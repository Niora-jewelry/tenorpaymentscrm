/**
 * Proposals — what a CRM user does: preview, send, void, look at one sent.
 *
 * Every function starts at the gate (CLAUDE.md rule 2):
 *   · the record's proposals tab (whichever carries `shows_proposals`) at Edit
 *     to preview, send or void, at View to list;
 *   · a value the sender may not see is not sent out in their name: hidden
 *     fields are left out of the proposal, exactly as an application does;
 *   · sending goes out through the person's OWN connected Outlook mailbox.
 *
 * A proposal is frozen when it is sent (`proposals.content`): what the
 * merchant opens is what was previewed, whatever happens to the record later.
 */
import 'server-only';
import { groupFieldProblems, isFilled, requiredFlagProblems, type FieldProblem, type ProblemGroup } from '@/lib/records/fieldProblems';
import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { companyBody, companyFromOption, queueCrmMail, sendingInboxFor, SendingInboxError, type SendingInbox } from '@/lib/mail/sendingInbox';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { appOrigin } from '@/lib/appOrigin';
import { loadConfig, type Config } from '@/lib/records/config';
import type { AuthContext } from '@/lib/records/permissions';
import { hiddenFieldKeysFor, requireTabAdd, tabAccess } from '@/lib/records/tabAccess';
import { tabBaseGrant } from '@/lib/records/restrictions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';
import { sendDue } from '@/lib/mail/compose/send';
import { fromOptions, withSignature } from '@/lib/mail/compose/sender';
import type { FromOption } from '@/lib/mail/viewTypes';
import { toPostgresBytea } from '@/lib/security/otp';
import { newId, newToken, recordForApplication } from '@/lib/applications/store';
import type { Recipient } from '@/lib/applications/service';
import { buildProposal, hasSavingsFigures, PROPOSAL_FIELD_KEYS, type ProposalContent } from './content';

export class ProposalError extends Error {}

/** How long the merchant's link works. */
export const PROPOSAL_EXPIRY_DAYS = 30;

export type ProposalStatus = 'sent' | 'viewed' | 'approved' | 'expired' | 'voided';

export const proposalLabel = (n: number) => `PRO-${String(n).padStart(6, '0')}`;
export const proposalLinkFor = (token: string) => `${appOrigin()}/proposal/${token}`;

/** Expired is a date, not a write. */
export function effectiveProposalStatus(p: { status: string; expires_at: string }): ProposalStatus {
  if ((p.status === 'sent' || p.status === 'viewed') && new Date(p.expires_at).getTime() < Date.now()) return 'expired';
  return p.status as ProposalStatus;
}

export async function proposalsTab(): Promise<string | null> {
  return (await loadConfig()).tabs.find((t) => t.showsProposals)?.key ?? null;
}
async function requireProposalsEdit(ctx: AuthContext, recordId: string): Promise<void> {
  const tab = await proposalsTab();
  if (!tab) throw new ProposalError('Proposals are not set up on any tab.');
  if ((await requireTabAdd(ctx, recordId, tab)) !== 'edit') throw new ProposalError('No edit access to proposals.');
}

// ── reading ─────────────────────────────────────────────────────────────────

export type ProposalView = {
  id: string;
  label: string;
  status: ProposalStatus;
  recipient: string;
  cc: string[];
  sentAt: string;
  sentByName: string | null;
  expiresAt: string;
  viewedAt: string | null;
  approvedAt: string | null;
  voidedAt: string | null;
  monthlySavings: number;
};

export type ProposalsPanelData = { items: ProposalView[]; canEdit: boolean };

/** The record's proposals, for anyone who can see the tab that carries them. */
export async function proposalsFor(ctx: AuthContext, recordId: string): Promise<ProposalsPanelData> {
  const tab = await proposalsTab();
  const grant = tab ? await tabAccess(ctx, recordId, tab) : 'hidden';
  if (grant === 'hidden') return { items: [], canEdit: false };
  // No grant on the table: read after the gate, here.
  const { data, error } = await supabaseAdmin()
    .from('proposals')
    .select('id, number, status, recipient, cc, sent_at, sent_by, expires_at, viewed_at, approved_at, voided_at, content')
    .eq('record_id', recordId)
    .order('sent_at', { ascending: false });
  if (error) throw error;
  const senders = [...new Set((data ?? []).map((p) => p.sent_by as string | null).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  if (senders.length) {
    const { data: people } = await supabaseAdmin().from('profiles').select('id, full_name, email').in('id', senders);
    for (const p of people ?? []) names.set(p.id as string, ((p.full_name as string | null) || (p.email as string | null) || '') as string);
  }
  const items: ProposalView[] = (data ?? []).map((p) => ({
    id: p.id,
    label: proposalLabel(p.number as number),
    status: effectiveProposalStatus(p),
    recipient: p.recipient,
    cc: p.cc ?? [],
    sentAt: p.sent_at,
    sentByName: p.sent_by ? names.get(p.sent_by) ?? null : null,
    expiresAt: p.expires_at,
    viewedAt: p.viewed_at,
    approvedAt: p.approved_at,
    voidedAt: p.voided_at,
    monthlySavings: Number((p.content as ProposalContent | null)?.savings?.monthly ?? 0),
  }));
  return { items, canEdit: grant === 'edit' || (await tabBaseGrant(ctx, recordId, tab!)) === 'edit' };
}

// ── the content ─────────────────────────────────────────────────────────────

/** Something the sender should know before it goes: where to fix it, if anywhere. */
export type ProposalNote = { tone: 'block' | 'info'; text: string; href?: string };

type Draft = { content: ProposalContent; notes: ProposalNote[]; merchant: string; contactEmail: string; contactName: string; recipients: Recipient[] };

/** "Applications › Prior Processor" — where a field lives, from configuration. */
function placeOf(config: Config, key: string): { words: string; tab?: string; subtab?: string } {
  const f = config.fields.find((x) => x.key === key);
  const tab = f ? config.tabs.find((t) => t.id === f.tabId) : undefined;
  const sub = f?.subtabId ? config.subtabs.find((s) => s.id === f.subtabId) : undefined;
  return { words: [tab?.label, sub?.label].filter(Boolean).join(' › ') || 'the record', tab: tab?.key, subtab: sub?.key };
}

async function draftFor(ctx: AuthContext, recordId: string, moduleSlug: string | null): Promise<Draft> {
  const rec = await recordForApplication(recordId);
  if (!rec) throw new ProposalError('That record no longer exists.');
  const config = await loadConfig();
  // What the sender may not see is not sent out in their name either.
  const hidden = await hiddenFieldKeysFor(ctx, recordId, config.fields);
  const visible = Object.fromEntries(Object.entries(rec.values).filter(([k]) => !hidden.has(k)));

  const rmIds = Array.isArray(visible.relationship_manager) ? (visible.relationship_manager as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  let rmEmail: string | null = null;
  if (rmIds.length) {
    const { data } = await supabaseAdmin().from('profiles').select('id, email, status, deleted_at').in('id', rmIds);
    const live = (data ?? []).filter((p) => p.status === 'active' && !p.deleted_at);
    rmEmail = (rmIds.map((id) => live.find((p) => p.id === id)?.email as string | undefined).find(Boolean) ?? null) as string | null;
  }
  const content = buildProposal(visible, { dealName: rec.dealName, relationshipManagerEmail: rmEmail, preparedOn: new Date() });

  const notes: ProposalNote[] = [];
  const link = (key: string) => {
    const p = placeOf(config, key);
    return {
      words: p.words,
      href: moduleSlug && p.tab ? `/${moduleSlug}?record=${recordId}&tab=${encodeURIComponent(p.tab)}${p.subtab ? `&subtab=${encodeURIComponent(p.subtab)}` : ''}&field=${key}` : undefined,
    };
  };
  if (!hasSavingsFigures(visible)) {
    const at = link('prior_monthly_volume');
    notes.push({ tone: 'block', text: `The Savings Analysis has no figures yet. Fill them in on ${at.words}.`, href: at.href });
  }
  const hiddenUsed = PROPOSAL_FIELD_KEYS.filter((k) => hidden.has(k));
  if (hiddenUsed.length) notes.push({ tone: 'info', text: 'Some proposal fields are in a section you can’t see, so they are left out.' });
  const ticked = (v: unknown) => v === true || v === 'Yes' || v === 'yes' || v === 'true';
  if (ticked(visible.pos_in_proposal) && !content.pos) {
    const at = link('pos_description');
    notes.push({ tone: 'info', text: `POS Architecture is ticked but has nothing to show — add a description or requirements on ${at.words}.`, href: at.href });
  }
  if (ticked(visible.pos_detail_in_proposal) && !content.detailedPos) {
    const at = link('merchant_direct_relationships');
    notes.push({ tone: 'info', text: `Detailed POS is ticked but no row is ticked “In proposal” on ${at.words}.`, href: at.href });
  }
  if (!rmEmail) notes.push({ tone: 'info', text: `No relationship manager on the record: the closing page shows ${content.closing.email}.` });

  const contact = !hidden.has('contact') && Array.isArray(rec.values.contact) ? ((rec.values.contact[0] ?? {}) as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return {
    content,
    notes,
    merchant: content.merchantName,
    contactEmail: str(contact.email),
    contactName: str(contact.name).split(/\s+/)[0] ?? '',
    recipients: recipientsOn(rec.values, hidden),
  };
}

/** The same picker the application uses: first contact, then every other email on the record. */
function recipientsOn(crm: Record<string, unknown>, hidden: Set<string>): Recipient[] {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const groups: [string, string, (m: Record<string, unknown>) => string][] = [
    ['contact', 'Contact', (m) => str(m.name)],
    ['affiliate', 'Affiliate', (m) => str(m.business_name) || str(m.name)],
    ['owner_ownership', 'Owner', (m) => [str(m.first), str(m.last)].filter(Boolean).join(' ')],
  ];
  for (const [key, who, nameOf] of groups) {
    if (hidden.has(key) || !Array.isArray(crm[key])) continue;
    (crm[key] as unknown[]).forEach((raw, i) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const address = str(m.email);
      if (!address || seen.has(address.toLowerCase())) return;
      seen.add(address.toLowerCase());
      const name = nameOf(m);
      out.push({ address, label: `${who}${name ? ` · ${name}` : ` ${i + 1}`}`, kind: key === 'contact' && i === 0 ? 'default' : 'other' });
    });
  }
  return out;
}

/** The preview page: exactly what would go out if sent now. */
export async function previewProposal(ctx: AuthContext, recordId: string, moduleSlug: string | null): Promise<{ content: ProposalContent; notes: ProposalNote[] }> {
  await requireProposalsEdit(ctx, recordId);
  const d = await draftFor(ctx, recordId, moduleSlug);
  return { content: d.content, notes: d.notes };
}

// ── the pre-send check ──────────────────────────────────────────────────────

export type OptionalPage = { page: string; reason: string; href?: string };

/**
 * Before the send dialog (client, 4 Nov 2026):
 *  - required: the cover's merchant name and the Savings Analysis figures (the
 *    cover, savings and closing pages are always in a proposal), plus any field
 *    an admin marks Required in Presets that the proposal uses. Listed with links.
 *  - optional: POS Architecture and Detailed POS. Not ticked, or ticked with
 *    nothing to show, and the user is asked to confirm before sending without them.
 */
export async function proposalPreCheck(ctx: AuthContext, recordId: string, moduleSlug: string | null): Promise<{ groups: ProblemGroup[]; optional: OptionalPage[] }> {
  await requireProposalsEdit(ctx, recordId);
  const rec = await recordForApplication(recordId);
  if (!rec) throw new ProposalError('That record no longer exists.');
  const config = await loadConfig();
  const hidden = await hiddenFieldKeysFor(ctx, recordId, config.fields);
  const visible = Object.fromEntries(Object.entries(rec.values).filter(([k]) => !hidden.has(k)));
  const problems: FieldProblem[] = [];
  const unseen = 'needed, in a section you can’t see. Ask someone who can to fill it in.';
  if (hidden.has('legal_business_name')) problems.push({ fieldKey: 'legal_business_name', message: unseen });
  else if (!isFilled(visible.legal_business_name)) problems.push({ fieldKey: 'legal_business_name', message: 'the merchant name on the cover page. Fill it in first.' });
  if (!hasSavingsFigures(visible)) problems.push({ fieldKey: 'prior_monthly_volume', message: 'the Savings Analysis has no figures yet. Fill in the current and proposed figures.' });
  const already = new Set(problems.map((p) => p.fieldKey));
  problems.push(...requiredFlagProblems(config, rec.values, PROPOSAL_FIELD_KEYS.filter((k) => !already.has(k)), hidden));

  const ticked = (v: unknown) => v === true || v === 'Yes' || v === 'yes' || v === 'true';
  const content = buildProposal(visible, { dealName: rec.dealName, relationshipManagerEmail: null, preparedOn: new Date() });
  const link = (key: string) => {
    const p = placeOf(config, key);
    return moduleSlug && p.tab ? `/${moduleSlug}?record=${recordId}&tab=${encodeURIComponent(p.tab)}${p.subtab ? `&subtab=${encodeURIComponent(p.subtab)}` : ''}&field=${key}` : undefined;
  };
  const optional: OptionalPage[] = [];
  if (!ticked(visible.pos_in_proposal)) optional.push({ page: 'POS Architecture', reason: 'not ticked to include', href: link('pos_in_proposal') });
  else if (!content.pos) optional.push({ page: 'POS Architecture', reason: 'ticked, but it has no description or requirements, so it is left out', href: link('pos_description') });
  if (!ticked(visible.pos_detail_in_proposal)) optional.push({ page: 'Detailed POS', reason: 'not ticked to include', href: link('pos_detail_in_proposal') });
  else if (!content.detailedPos) optional.push({ page: 'Detailed POS', reason: 'ticked, but no Merchant Direct Relationships row is ticked “In proposal”, so it is left out', href: link('merchant_direct_relationships') });
  return { groups: groupFieldProblems(config, problems), optional };
}

// ── composing ───────────────────────────────────────────────────────────────

export type ProposalSendDefaults = {
  to: string;
  recipients: Recipient[];
  from: FromOption[];
  subject: string;
  body: string;
  expiryDays: number;
  notes: ProposalNote[];
  monthlySavings: number;
  merchant: string;
  /** Set when an admin chose one company inbox for proposals (Presets › Sending inbox). */
  company: { address: string; ready: boolean } | null;
};

export const DEFAULT_SUBJECT = 'Your proposal from Tenor Payments — {{merchant}}';
export const DEFAULT_BODY = `Hi {{contact_name}},

Thank you for the opportunity to review your payment processing. Your proposal for {{merchant}} is ready: it sets out what you pay today, what you would pay with Tenor, and what that saves you each month, each year and over three years.

{{link}}

When you are happy with it, approve it from the same page and we will take it from there. Any questions, just reply to this email.`;

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));

export async function proposalSendDefaults(ctx: AuthContext, recordId: string, moduleSlug: string | null): Promise<ProposalSendDefaults> {
  await requireProposalsEdit(ctx, recordId);
  const inbox = await sendingInboxFor('proposals');
  const [d, from] = await Promise.all([
    draftFor(ctx, recordId, moduleSlug),
    inbox.mode === 'mailbox' ? (inbox.inbox.ready ? companyFromOption(inbox.inbox).then((o) => [o]) : Promise.resolve([])) : fromOptions(ctx),
  ]);
  const vars = { merchant: d.merchant, contact_name: d.contactName || 'there' };
  return {
    to: d.contactEmail,
    recipients: d.recipients,
    from,
    subject: fill(DEFAULT_SUBJECT, vars),
    body: fill(DEFAULT_BODY, vars),
    expiryDays: PROPOSAL_EXPIRY_DAYS,
    notes: d.notes,
    monthlySavings: d.content.savings.monthly,
    merchant: d.merchant,
    company: inbox.mode === 'mailbox' ? { address: inbox.inbox.address, ready: inbox.inbox.ready } : null,
  };
}

// ── sending ─────────────────────────────────────────────────────────────────

export type ProposalSendInput = { recordId: string; mailboxId: string; to: string; cc: string[]; subject: string; body: string };

/** Your own mailbox needs Email access; the company inbox an admin chose does not. */
async function mailGate(ctx: AuthContext, inbox: SendingInbox): Promise<void> {
  if (await currentImpersonation()) throw new ProposalError('You are signed in as someone else. Stop impersonating to send.');
  if (inbox.mode === 'mailbox') {
    if (!inbox.inbox.ready) throw new ProposalError(`Proposals go out from ${inbox.inbox.address}, which has no working connection. Ask an admin to reconnect it in Email.`);
  } else {
    try {
      await requireEmailAccess(ctx, 'edit');
    } catch (e) {
      if (e instanceof EmailAccessError) throw new ProposalError(e.message);
      throw e;
    }
  }
  for (const [i, rule] of [RATE_LIMITS.mailSendPerUserMinute, RATE_LIMITS.mailSendPerUserDay].entries()) {
    const limit = await rateLimit(userKey(`mail_send${i}`, ctx.userId), rule);
    if (!limit.allowed) throw new ProposalError(`You're sending faster than Outlook allows. Try again in ${limit.retryAfterSeconds} seconds.`);
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The person's words, the link as a button, their signature added by the caller. */
export function proposalEmailHtml(body: string, link: string): string {
  const button =
    `<a href="${esc(link)}" style="display:inline-block;background:#102347;color:#ffffff;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px;">View your proposal</a>`;
  const withLink = body.includes('{{link}}') ? body : `${body.trimEnd()}\n\n{{link}}`;
  return withLink
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px;">${esc(para).replace(/\n/g, '<br>').replace(/\{\{\s*link\s*\}\}/g, button)}</p>`)
    .join('');
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

export async function sendProposal(ctx: AuthContext, input: ProposalSendInput): Promise<{ id: string; label: string }> {
  await requireProposalsEdit(ctx, input.recordId);
  const inbox = await sendingInboxFor('proposals');
  await mailGate(ctx, inbox);
  if (!isEmail(input.to)) throw new ProposalError('Enter a valid recipient email address.');
  const bad = input.cc.find((c) => !isEmail(c));
  if (bad) throw new ProposalError(`${bad} is not a valid email address.`);

  const d = await draftFor(ctx, input.recordId, null);
  const block = d.notes.find((n) => n.tone === 'block');
  if (block) throw new ProposalError(block.text);

  const id = newId();
  const { token, hash } = newToken();
  const { data: row, error } = await supabaseAdmin()
    .from('proposals')
    .insert({
      id,
      record_id: input.recordId,
      token_hash: toPostgresBytea(hash),
      content: d.content,
      recipient: input.to.trim().toLowerCase(),
      cc: input.cc.map((c) => c.trim().toLowerCase()),
      subject: input.subject,
      sent_by: ctx.userId,
      expires_at: new Date(Date.now() + PROPOSAL_EXPIRY_DAYS * 86400_000).toISOString(),
    })
    .select('number')
    .single();
  if (error) throw error;
  const label = proposalLabel(row.number as number);

  try {
    const link = proposalLinkFor(token);
    const supabase = await createSupabaseServerClient();
    let outboxId: string | undefined;
    let fromAddress = '';
    if (inbox.mode === 'mailbox') {
      // The company inbox an admin chose; whoever clicked Send is kept as the one who asked.
      try {
        outboxId = (
          await queueCrmMail({
            mailboxId: inbox.inbox.mailboxId,
            preferUser: ctx.userId,
            requestedBy: ctx.userId,
            crmRef: `proposal:${id}`,
            recordId: input.recordId,
            subject: input.subject,
            html: await companyBody(proposalEmailHtml(input.body, link), inbox.inbox),
            to: [{ name: '', address: input.to }],
            cc: input.cc.map((address) => ({ name: '', address })),
          })
        ).outboxId;
      } catch (e) {
        throw new ProposalError(e instanceof SendingInboxError ? e.message : 'Outlook did not accept the message. Try again.');
      }
      fromAddress = inbox.inbox.address;
    } else {
    const html = await withSignature(proposalEmailHtml(input.body, link), input.mailboxId, true);
    const { data, error: mailError } = await supabase.rpc('mail_outbox_submit', {
      p_request_id: newId(),
      p_mailbox_id: input.mailboxId,
      p_draft_id: null,
      p_kind: 'new',
      p_source_graph_id: null,
      p_subject: input.subject,
      p_body_html: html,
      p_to: [{ name: '', address: input.to }],
      p_cc: input.cc.map((address) => ({ name: '', address })),
      p_bcc: [],
      p_attachments: [],
      p_send_at: null,
    });
    if (mailError) throw new ProposalError(mailError.code === '42501' || mailError.code === '22023' ? mailError.message : 'Outlook did not accept the message. Try again.');
    const ownId = (data as { id: string }[])[0]?.id;
    outboxId = ownId;
    // No undo window for a proposal: it goes now.
    if (ownId) after(() => sendDue({ only: ownId, budgetMs: 50_000 }).then(() => undefined));

    fromAddress = (await supabase.from('mail_mailboxes').select('address').eq('id', input.mailboxId).maybeSingle()).data?.address ?? '';
    }
    // The merchant's email history on the record (the drawer's Email tab).
    await supabaseAdmin()
      .from('messages')
      .insert({
        record_id: input.recordId,
        channel: 'email',
        direction: 'out',
        from_identity: fromAddress || 'crm',
        to_identity: [input.to, ...input.cc].join(', '),
        subject: input.subject,
        body: input.body.replace(/\{\{\s*link\s*\}\}/g, '[View your proposal]'),
        external_id: `proposal:${id}:${outboxId ?? newId()}`,
        sent_at: new Date().toISOString(),
      });
  } catch (e) {
    // Never leave a proposal on the record that was never sent.
    await supabaseAdmin().from('proposals').delete().eq('id', id);
    throw e;
  }
  await supabaseAdmin().rpc('proposal_log', { p_proposal: id, p_actor: ctx.userId, p_summary: `Proposal ${label} sent to ${input.to}.` });
  return { id, label };
}

/** The link stops working. An approval already given stays. */
export async function voidProposal(ctx: AuthContext, proposalId: string): Promise<void> {
  const { data: p, error } = await supabaseAdmin().from('proposals').select('id, number, record_id, status').eq('id', proposalId).maybeSingle();
  if (error) throw error;
  if (!p) throw new ProposalError('That proposal no longer exists.');
  await requireProposalsEdit(ctx, p.record_id as string);
  if (p.status === 'voided') return;
  if (p.status === 'approved') throw new ProposalError('This proposal is already approved; there is nothing to void.');
  const { error: e2 } = await supabaseAdmin()
    .from('proposals')
    .update({ status: 'voided', voided_at: new Date().toISOString(), voided_by: ctx.userId })
    .eq('id', p.id)
    .in('status', ['sent', 'viewed']);
  if (e2) throw e2;
  await supabaseAdmin().rpc('proposal_log', {
    p_proposal: p.id,
    p_actor: ctx.userId,
    p_summary: `Proposal ${proposalLabel(p.number as number)} voided — the link no longer works.`,
  });
}

/** One sent proposal as the merchant sees it, for someone who can see the record's proposals. */
export async function sentProposal(ctx: AuthContext, proposalId: string): Promise<{ view: ProposalView; content: ProposalContent; recordId: string } | null> {
  const { data: p, error } = await supabaseAdmin().from('proposals').select('id, record_id, content').eq('id', proposalId).maybeSingle();
  if (error) throw error;
  if (!p) return null;
  const panel = await proposalsFor(ctx, p.record_id as string);
  const view = panel.items.find((i) => i.id === proposalId);
  if (!view) return null;
  return { view, content: p.content as ProposalContent, recordId: p.record_id as string };
}

/** The first display module the person can open the record in, for "Back to the record". */
export async function recordHrefFor(ctx: AuthContext, recordId: string): Promise<string | null> {
  const config = await loadConfig();
  const supabase = await createSupabaseServerClient();
  const { data: mods } = await supabase.from('record_modules').select('module_id').eq('record_id', recordId);
  const ids = new Set((mods ?? []).map((m) => m.module_id as string));
  const mod = config.modules.filter((m) => ids.has(m.id) && m.kind === 'display').sort((a, b) => a.position - b.position)[0];
  const tab = await proposalsTab();
  return mod ? `/${mod.slug}?record=${recordId}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}` : null;
}
