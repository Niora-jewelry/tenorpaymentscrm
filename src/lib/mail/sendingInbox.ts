/**
 * Which inbox CRM emails go out from (client, 3 Nov 2026): "I could choose
 * which inbox those emails come out of" — for applications, proposals and
 * agreements. office@ is the company inbox "for emails such as contracts,
 * agreements and other office type info".
 *
 *   own       the sender's own connected mailbox (the From picker, as before)
 *   mailbox   one company inbox for everyone, chosen by an admin in Presets
 *   signwell  agreements only: SignWell emails the signers itself (as before)
 *
 * A company inbox sends through the connection of whoever connected it — the
 * rule automations already follow (`automation_mail_sender`). The outbox row
 * keeps who asked and what it was for, so a refused send lands on the record.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { sanitizeOutgoing } from '@/lib/mail/content/sanitize';
import { sendDue } from '@/lib/mail/compose/send';
import type { AuthContext } from '@/lib/records/permissions';
import { canOpenAdminPage } from '@/lib/records/permissions';
import type { FromOption } from '@/lib/mail/viewTypes';

export type SendPurpose = 'applications' | 'proposals' | 'agreements';
export type SendMode = 'own' | 'mailbox' | 'signwell';

export const PURPOSES: SendPurpose[] = ['applications', 'proposals', 'agreements'];
/**
 * Agreements default to the sender's own mailbox, not SignWell's email: in SignWell's
 * own mode SignWell emails the signers and sends them the signed copy, which the
 * client does not want (4 Nov 2026).
 */
export const DEFAULT_MODE: Record<SendPurpose, SendMode> = { applications: 'own', proposals: 'own', agreements: 'own' };

export type CompanyInbox = { mailboxId: string; address: string; displayName: string; ready: boolean };

export type SendingInbox =
  | { mode: 'own' }
  | { mode: 'signwell' }
  | { mode: 'mailbox'; inbox: CompanyInbox };

export class SendingInboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendingInboxError';
  }
}

async function inboxById(mailboxId: string): Promise<CompanyInbox | null> {
  const admin = supabaseAdmin();
  const [{ data: mb }, { data: sender }] = await Promise.all([
    admin.from('mail_mailboxes').select('id, address, display_name, deleted_at, deactivated_at').eq('id', mailboxId).maybeSingle(),
    admin.rpc('automation_mail_sender', { p_mailbox: mailboxId }),
  ]);
  if (!mb || mb.deleted_at) return null;
  return {
    mailboxId: mb.id as string,
    address: mb.address as string,
    displayName: (mb.display_name as string) || '',
    ready: !mb.deactivated_at && Array.isArray(sender) && sender.length > 0,
  };
}

/** The setting for one kind of email, as it stands. */
export async function sendingInboxFor(purpose: SendPurpose): Promise<SendingInbox> {
  const { data, error } = await supabaseAdmin().from('mail_send_purposes').select('mode, mailbox_id').eq('purpose', purpose).maybeSingle();
  if (error) throw error;
  const mode = ((data?.mode as SendMode | undefined) ?? DEFAULT_MODE[purpose]) as SendMode;
  if (mode === 'mailbox' && data?.mailbox_id) {
    const inbox = await inboxById(data.mailbox_id as string);
    // The inbox was removed from the CRM: nothing can go from it, and saying so beats silently using someone's own.
    return { mode: 'mailbox', inbox: inbox ?? { mailboxId: data.mailbox_id as string, address: 'a removed inbox', displayName: '', ready: false } };
  }
  return mode === 'signwell' ? { mode: 'signwell' } : { mode: 'own' };
}

/** The company inbox as a From option, with its own signature. */
export async function companyFromOption(inbox: CompanyInbox): Promise<FromOption> {
  const { data } = await supabaseAdmin().from('mail_signatures').select('body_html').eq('mailbox_id', inbox.mailboxId).limit(1).maybeSingle();
  return { mailboxId: inbox.mailboxId, address: inbox.address, displayName: inbox.displayName, signatureHtml: (data?.body_html as string | undefined) ?? '' };
}

/** The body as it goes from the company inbox: sanitised, with the inbox's signature. */
export async function companyBody(html: string, inbox: CompanyInbox): Promise<string> {
  const clean = sanitizeOutgoing(html);
  const sig = (await companyFromOption(inbox)).signatureHtml;
  return sig ? `${clean}<br><div class="tapdash-signature">${sig}</div>` : clean;
}

export type CrmMail = {
  mailboxId: string;
  /** Use this person's own connection to the inbox when they have one. */
  preferUser: string | null;
  requestedBy: string | null;
  /** What it is for: `application:<id>`, `proposal:<id>`, `agreement_link:<signerId>`… */
  crmRef: string;
  recordId: string | null;
  subject: string;
  html: string;
  to: { name: string; address: string }[];
  cc?: { name: string; address: string }[];
  attachments?: { path: string; name: string; size: number; contentType: string }[];
  requestId?: string;
};

/** Queues one email from a chosen inbox and sends it now (after the response). */
export async function queueCrmMail(mail: CrmMail, opts: { sendNow?: boolean } = {}): Promise<{ outboxId: string; senderUser: string }> {
  const { data, error } = await supabaseAdmin().rpc('crm_mail_enqueue', {
    p_request: mail.requestId ?? randomUUID(),
    p_mailbox: mail.mailboxId,
    p_prefer_user: mail.preferUser,
    p_requested_by: mail.requestedBy,
    p_crm_ref: mail.crmRef,
    p_record: mail.recordId,
    p_subject: mail.subject,
    p_body: mail.html,
    p_to: mail.to,
    p_cc: mail.cc ?? [],
    p_attachments: mail.attachments ?? [],
  });
  if (error) throw new SendingInboxError(error.code === '22023' ? error.message : 'Outlook did not accept the message. Try again.');
  const row = (data as { id: string; sender_user: string }[])[0];
  if (!row) throw new SendingInboxError('Outlook did not accept the message. Try again.');
  if (opts.sendNow !== false) {
    // After the response, as the person's own sends do; the mail tick picks up anything this misses.
    after(() => sendDue({ only: row.id, budgetMs: 50_000 }).then(() => undefined, () => undefined));
  }
  return { outboxId: row.id, senderUser: row.sender_user };
}

/**
 * The Presets screen: every kind with its setting, and the inboxes an admin may
 * pick — every mailbox in the CRM that has a working connection.
 */
export type SendingInboxSettings = {
  rows: { purpose: SendPurpose; mode: SendMode; mailboxId: string | null; ready: boolean | null }[];
  inboxes: CompanyInbox[];
};

export async function readSendingInboxSettings(ctx: AuthContext): Promise<SendingInboxSettings> {
  if (!(await canOpenAdminPage(ctx, 'presets'))) throw new SendingInboxError('You do not have access to Presets.');
  const admin = supabaseAdmin();
  const [{ data: rows }, { data: conns }] = await Promise.all([
    admin.from('mail_send_purposes').select('purpose, mode, mailbox_id'),
    admin
      .from('mail_connections')
      .select('mailbox_id, mail_mailboxes!inner(address, display_name, deleted_at, deactivated_at)')
      .is('disconnected_at', null)
      .in('status', ['ok', 'degraded']),
  ]);
  const inboxes = new Map<string, CompanyInbox>();
  for (const c of (conns ?? []) as unknown as { mailbox_id: string; mail_mailboxes: { address: string; display_name: string; deleted_at: string | null; deactivated_at: string | null } }[]) {
    if (c.mail_mailboxes.deleted_at || c.mail_mailboxes.deactivated_at) continue;
    inboxes.set(c.mailbox_id, { mailboxId: c.mailbox_id, address: c.mail_mailboxes.address, displayName: c.mail_mailboxes.display_name ?? '', ready: true });
  }
  const byPurpose = new Map(((rows ?? []) as { purpose: SendPurpose; mode: SendMode; mailbox_id: string | null }[]).map((r) => [r.purpose, r]));
  return {
    rows: PURPOSES.map((purpose) => {
      const r = byPurpose.get(purpose);
      const mode = r?.mode ?? DEFAULT_MODE[purpose];
      const mailboxId = mode === 'mailbox' ? (r?.mailbox_id ?? null) : null;
      return { purpose, mode, mailboxId, ready: mailboxId ? inboxes.has(mailboxId) : null };
    }),
    inboxes: [...inboxes.values()].sort((a, b) => a.address.localeCompare(b.address)),
  };
}

export async function saveSendingInbox(ctx: AuthContext, purpose: SendPurpose, mode: SendMode, mailboxId: string | null): Promise<void> {
  if (!(await canOpenAdminPage(ctx, 'presets'))) throw new SendingInboxError('You do not have access to Presets.');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_mail_send_purpose', { p_purpose: purpose, p_mode: mode, p_mailbox: mode === 'mailbox' ? mailboxId : null });
  if (error) throw new SendingInboxError(error.code === '42501' ? 'You do not have access to Presets.' : error.message);
}
