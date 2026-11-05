/**
 * Agreements sent through Outlook (client, 3 Nov 2026: "Real email from
 * office@"). SignWell hosts the signing page and records every signature; the
 * CRM emails each signer their own link — from the inbox Presets › Sending
 * inbox chose — and sends the reminders (day 3, 6 and 10, as SignWell would),
 * the "withdrawn" notice on void and the "everyone has signed" note.
 *
 * Each signer's link is /sign/<token>: 32 random bytes, looked up by HMAC hash,
 * kept sealed so a reminder can carry the same link. The page behind it asks
 * SignWell for that signer's signing address at the moment they click, so a
 * corrected email or a voided agreement takes effect at once.
 */
import 'server-only';
import { randomBytes } from 'node:crypto';
import { appOrigin } from '@/lib/appOrigin';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { hashTicket, toPostgresBytea } from '@/lib/security/otp';
import { fromBytea } from '@/lib/mail/crypto';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { fromOptions, withSignature } from '@/lib/mail/compose/sender';
import { companyBody, queueCrmMail, sendingInboxFor } from '@/lib/mail/sendingInbox';
import type { AuthContext } from '@/lib/records/permissions';
import { openText, sealText } from './crypto';
import { kindFor } from './kinds';
import { agreementSettings, agrLabel, type AgreementRow, type SignerRow } from './store';
import { completedHtml, inviteHtml, reminderDue, reminderHtml, withdrawnHtml, type EmailAbout } from './signerEmails';


export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export type DeliveryPlan = { mailboxId: string; address: string; preferUser: string; company: boolean };

/** How an agreement leaves, as Presets set it. Null: SignWell emails the signers itself. */
export async function deliveryFor(ctx: AuthContext, mailboxIdFromClient: string | null): Promise<DeliveryPlan | null> {
  const inbox = await sendingInboxFor('agreements');
  if (inbox.mode === 'signwell') return null;
  if (inbox.mode === 'mailbox') {
    if (!inbox.inbox.ready) throw new DeliveryError(`Agreements go out from ${inbox.inbox.address}, which has no working connection. Ask an admin to reconnect it in Email.`);
    return { mailboxId: inbox.inbox.mailboxId, address: inbox.inbox.address, preferUser: ctx.userId, company: true };
  }
  // The sender's own mailbox: Email access, and a mailbox they connected themselves.
  try {
    await requireEmailAccess(ctx, 'edit');
  } catch (e) {
    if (e instanceof EmailAccessError) throw new DeliveryError(e.message);
    throw e;
  }
  const mine = await fromOptions(ctx);
  const pick = mine.find((m) => m.mailboxId === mailboxIdFromClient) ?? (mailboxIdFromClient ? null : mine[0]);
  if (!pick) throw new DeliveryError(mine.length ? 'Pick the mailbox to send from.' : 'Agreements go out from your own Outlook mailbox. Connect it in Email first.');
  return { mailboxId: pick.mailboxId, address: pick.address, preferUser: ctx.userId, company: false };
}

// ── the signer's link ────────────────────────────────────────────────────────

export function newSignerLink(signerId: string): { token: string; columns: { link_hash: string; link_sealed: string; link_iv: string } } {
  const token = randomBytes(32).toString('base64url');
  const sealed = sealText(token, `agreement-link:${signerId}`);
  return { token, columns: { link_hash: toPostgresBytea(hashTicket(token)), link_sealed: toPostgresBytea(sealed.data), link_iv: toPostgresBytea(sealed.iv) } };
}

export function openSignerLink(s: Pick<SignerRow, 'id' | 'link_sealed' | 'link_iv'>): string | null {
  if (!s.link_sealed || !s.link_iv) return null;
  return openText({ data: fromBytea(s.link_sealed), iv: fromBytea(s.link_iv) }, `agreement-link:${s.id}`);
}

const base = () => appOrigin();
export const signerLinkUrl = (token: string) => `${base()}/sign/${token}`;
export const signingRedirects = () => ({ redirectUrl: `${base()}/sign/complete`, declineRedirectUrl: `${base()}/sign/declined` });

// ── the emails (their words are in ./signerEmails) ───────────────────────────

const about = (a: AgreementRow): EmailAbout => ({
  what: kindFor(a.kind)?.emailLabel ?? 'agreement',
  merchant: a.merchant_name ?? 'your business',
  sentAt: a.sent_at,
  expiresAt: a.expires_at,
});

type Outgoing = { subject: string; html: string; crmRef: string };

async function bodyFor(a: Pick<AgreementRow, 'delivery_mailbox_id'>, html: string, company: boolean): Promise<string> {
  if (!a.delivery_mailbox_id) return html;
  if (company) {
    const { data } = await supabaseAdmin().from('mail_mailboxes').select('id, address, display_name').eq('id', a.delivery_mailbox_id).maybeSingle();
    if (data) return companyBody(html, { mailboxId: data.id as string, address: data.address as string, displayName: (data.display_name as string) ?? '', ready: true });
  }
  return withSignature(html, a.delivery_mailbox_id, true).catch(() => html);
}

/** One email to one signer from the agreement's inbox. */
async function emailSigner(a: AgreementRow, signer: SignerRow, out: Outgoing, actor: string | null, sendNow = true): Promise<void> {
  if (!a.delivery_mailbox_id) throw new DeliveryError('This agreement has no sending inbox any more. Void it and send a new one.');
  const company = a.delivery_company;
  await queueCrmMail({
    mailboxId: a.delivery_mailbox_id,
    preferUser: a.sent_by,
    requestedBy: actor ?? a.sent_by,
    crmRef: out.crmRef,
    recordId: a.record_id,
    subject: out.subject,
    html: await bodyFor(a, out.html, company),
    to: [{ name: signer.name, address: signer.email }],
  }, { sendNow });
}

/** The first emails, one per signer, right after SignWell accepted the document. */
export async function emailSigningLinks(a: AgreementRow, signers: { row: SignerRow; token: string }[], message: string, actor: string, plan: DeliveryPlan): Promise<void> {
  for (const { row, token } of signers) {
    await queueCrmMail({
      mailboxId: plan.mailboxId,
      preferUser: plan.preferUser,
      requestedBy: actor,
      crmRef: `agreement_link:${row.id}`,
      recordId: a.record_id,
      subject: a.subject,
      html: plan.company
        ? await companyBody(inviteHtml(message, row, signerLinkUrl(token), a.expires_at), { mailboxId: plan.mailboxId, address: plan.address, displayName: '', ready: true })
        : await withSignature(inviteHtml(message, row, signerLinkUrl(token), a.expires_at), plan.mailboxId, true),
      to: [{ name: row.name, address: row.email }],
    });
  }
  await supabaseAdmin().from('agreement_signers').update({ link_sent_at: new Date().toISOString() }).in('id', signers.map((s) => s.row.id));
}

const waiting = (s: SignerRow) => s.status === 'sent' || s.status === 'viewed';

/** A reminder to every signer still to sign. Returns how many went. */
export async function remindSigners(a: AgreementRow, signers: SignerRow[], actor: string | null, sendNow = true): Promise<number> {
  let sent = 0;
  for (const s of signers.filter(waiting)) {
    const token = openSignerLink(s);
    if (!token) continue;
    await emailSigner(a, s, { subject: `Reminder: ${a.subject}`, html: reminderHtml(about(a), s, signerLinkUrl(token)), crmRef: `agreement_reminder:${s.id}` }, actor, sendNow);
    await supabaseAdmin()
      .from('agreement_signers')
      // One sent by hand does not use up a day on the schedule (day 3, 6, 10).
      .update({ reminders_sent: actor ? s.reminders_sent : s.reminders_sent + 1, last_reminded_at: new Date().toISOString() })
      .eq('id', s.id);
    sent++;
  }
  return sent;
}

/** One signer at a corrected address: a fresh link (the old one stops), sent now. */
export async function emailNewLink(a: AgreementRow, signer: SignerRow, actor: string): Promise<void> {
  const link = newSignerLink(signer.id);
  const { error } = await supabaseAdmin().from('agreement_signers').update({ ...link.columns, link_sent_at: new Date().toISOString() }).eq('id', signer.id);
  if (error) throw error;
  // The sender's own words from the first send; {{signer_name}} becomes this signer's name.
  await emailSigner(a, signer, { subject: a.subject, html: inviteHtml(a.message, signer, signerLinkUrl(link.token), a.expires_at), crmRef: `agreement_link:${signer.id}` }, actor);
}

/** Voided: every signer who has not signed hears that the link is gone. */
export async function emailWithdrawn(a: AgreementRow, signers: SignerRow[], actor: string): Promise<void> {
  for (const s of signers.filter((x) => x.status !== 'signed' && x.status !== 'declined' && x.status !== 'bounced')) {
    await emailSigner(a, s, { subject: `Withdrawn: ${a.subject}`, html: withdrawnHtml(about(a), s), crmRef: `agreement_notice:${s.id}` }, actor).catch(() => undefined);
  }
}

/** Completed and the signed PDF stored: each signer is told, once, that everyone has signed. No copy goes with it. */
export async function emailCompleted(agreementId: string): Promise<void> {
  // Claim it: two webhooks for the same completion must not send twice.
  const { data } = await supabaseAdmin()
    .from('agreements')
    .update({ completion_emailed_at: new Date().toISOString() })
    .eq('id', agreementId)
    .eq('delivery', 'outlook')
    .eq('status', 'completed')
    .eq('download_status', 'stored')
    .is('completion_emailed_at', null)
    .select('*');
  const a = (data as AgreementRow[] | null)?.[0];
  if (!a) return;
  const { data: rows } = await supabaseAdmin().from('agreement_signers').select('*').eq('agreement_id', a.id).order('slot');
  for (const s of (rows ?? []) as SignerRow[]) {
    // Queued only: this runs in background work, and the per-minute mail tick sends it.
    await emailSigner(a, s, { subject: `Signed: ${a.subject}`, html: completedHtml(about(a), s), crmRef: `agreement_notice:${s.id}` }, null, false).catch(() => undefined);
  }
}

/**
 * The daily tick: reminders that are due, on SignWell's own schedule (day 3,
 * 6, 10 after sending), for agreements sent through Outlook while reminders are
 * on in Presets.
 */
export async function remindDueSigners(budgetMs = 30_000): Promise<number> {
  const settings = await agreementSettings();
  if (!settings.reminders) return 0;
  const started = Date.now();
  const { data } = await supabaseAdmin()
    .from('agreements')
    .select('*')
    .eq('delivery', 'outlook')
    .in('status', ['sent', 'viewed', 'partially_signed'])
    .gt('expires_at', new Date().toISOString())
    .order('sent_at')
    .limit(100);
  let sent = 0;
  for (const a of (data ?? []) as AgreementRow[]) {
    if (Date.now() - started > budgetMs) break;
    const { data: rows } = await supabaseAdmin().from('agreement_signers').select('*').eq('agreement_id', a.id).order('slot');
    const due = ((rows ?? []) as SignerRow[]).filter((s) => waiting(s) && reminderDue(a.sent_at, s.reminders_sent, new Date()));
    if (!due.length) continue;
    try {
      // Queued only; the per-minute mail tick sends them.
      sent += await remindSigners(a, due, null, false);
      await supabaseAdmin().rpc('agreement_log', {
        p_agreement: a.id,
        p_actor: null,
        p_summary: `Reminder emailed for ${agrLabel(a.number)} to ${due.map((s) => s.name).join(', ')}`,
        p_update_body: null,
      });
    } catch (e) {
      console.error('[agreements] reminder', a.id, e instanceof Error ? e.message.slice(0, 160) : e);
    }
  }
  return sent;
}
