/**
 * Prepopulated Application — what a CRM user does: send, resend, void,
 * upload a returned PDF, enter answers by hand, review, open a returned PDF.
 *
 * Every function starts at the gate (CLAUDE.md rule 2):
 *   · the record's Applications tab at Edit to send / resend / void / upload /
 *     review (View to list);
 *   · Accept also needs Edit on each field it writes — the same grant the
 *     drawer asks for;
 *   · sending goes out through the person's OWN connected Outlook mailbox
 *     (Email Edit, not impersonating, the mail rate limits);
 *   · opening a returned PDF needs "Returned application PDFs" (they hold SSNs).
 */
import 'server-only';
import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { loadConfig } from '@/lib/records/config';
import { assertAdminPage } from '@/lib/records/adminConfig';
import { permissionsFor, type AuthContext } from '@/lib/records/permissions';
import { fieldCapsFor, hiddenFieldKeysFor, requireTabEdit, tabAccess } from '@/lib/records/tabAccess';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';
import { OUTBOX_BUCKET, sendDue } from '@/lib/mail/compose/send';
import { fromOptions, withSignature } from '@/lib/mail/compose/sender';
import type { FromOption } from '@/lib/mail/viewTypes';
import { toPostgresBytea } from '@/lib/security/otp';
import { openBytes, sealBytes } from './crypto';
import { answersForPdf, buildWrite, parseTargetKey, prefillAnswers, ssnOnFile as ssnOnFileFor, type CrmValues } from './mapping';
import { applicationFileName, fillApplicationPdf, loadTemplate, readApplicationPdf, templateInstalled, TemplateMissingError } from './pdf';
import { sanitizeAnswers } from './validate';
import type { Answers } from './catalog';
import {
  appLabel,
  applicationById,
  applicationByNumber,
  applicationSettings,
  choiceLabels,
  effectiveStatus,
  ingest,
  linkIsLive,
  merchantName,
  newId,
  newToken,
  openToken,
  parseAppLabel,
  recordForApplication,
  sealToken,
  type ApplicationRow,
  type ApplicationStatus,
} from './store';
import { fromBytea } from '@/lib/mail/crypto';

export class ApplicationError extends Error {}

const FILES_BUCKET = 'application-pdfs';
const MAX_PDF = 25 * 1024 * 1024;

/**
 * The drawer tab that carries applications — whichever is flagged
 * `shows_applications`. Its grant is the applications grant.
 */
export async function applicationsTab(): Promise<string | null> {
  return (await loadConfig()).tabs.find((t) => t.showsApplications)?.key ?? null;
}
async function requireApplicationsEdit(ctx: AuthContext, recordId: string): Promise<void> {
  const tab = await applicationsTab();
  if (!tab) throw new ApplicationError('Applications are not set up on any tab.');
  await requireTabEdit(ctx, recordId, tab);
}

export const linkFor = (token: string) => `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/apply/${token}`;

// ── reading ─────────────────────────────────────────────────────────────────

export type ApplicationView = {
  id: string;
  label: string;
  status: ApplicationStatus;
  recipient: string;
  cc: string[];
  sentAt: string;
  sentById: string | null;
  lastSentAt: string;
  sendCount: number;
  expiresAt: string;
  openedAt: string | null;
  submittedAt: string | null;
  returnedVia: 'online' | 'pdf' | null;
  reviewedAt: string | null;
  voidedAt: string | null;
  pending: number;
  applied: number;
  files: { id: string; name: string; sizeBytes: number; readable: boolean; fieldsFound: number; uploadedAt: string; uploadedVia: 'crm' | 'merchant' }[];
};

export type ApplicationsPanelData = {
  items: ApplicationView[];
  canEdit: boolean;
  canOpenPdfs: boolean;
  templateReady: boolean;
};

export async function canOpenReturnedPdfs(ctx: AuthContext): Promise<boolean> {
  if (ctx.isAdmin) return true;
  return (await permissionsFor(ctx)).settings['applications.pdfs'] === 'full';
}

/** The record's applications, through the viewer's own RLS. */
export async function applicationsFor(ctx: AuthContext, recordId: string): Promise<ApplicationsPanelData> {
  const tab = await applicationsTab();
  const grant = tab ? await tabAccess(ctx, recordId, tab) : 'hidden';
  if (grant === 'hidden') return { items: [], canEdit: false, canOpenPdfs: false, templateReady: false };
  const supabase = await createSupabaseServerClient();
  const [apps, changes, files, canOpenPdfs, templateReady] = await Promise.all([
    supabase
      .from('applications')
      .select('id, number, status, recipient, cc, sent_by, sent_at, last_sent_at, send_count, expires_at, opened_at, submitted_at, returned_via, reviewed_at, voided_at')
      .eq('record_id', recordId)
      .order('sent_at', { ascending: false }),
    supabase.from('application_changes').select('application_id, status').eq('record_id', recordId),
    supabase
      .from('application_files')
      .select('id, application_id, name, size_bytes, readable, fields_found, uploaded_at, uploaded_via')
      .eq('record_id', recordId)
      .order('uploaded_at', { ascending: false }),
    canOpenReturnedPdfs(ctx),
    templateInstalled(),
  ]);
  for (const r of [apps, changes, files]) if (r.error) throw r.error;
  const count = (id: string, s: string) => (changes.data ?? []).filter((c) => c.application_id === id && c.status === s).length;
  const items: ApplicationView[] = (apps.data ?? []).map((a) => ({
    id: a.id,
    label: appLabel(a.number),
    status: effectiveStatus(a as ApplicationRow),
    recipient: a.recipient,
    cc: a.cc ?? [],
    sentAt: a.sent_at,
    sentById: a.sent_by,
    lastSentAt: a.last_sent_at,
    sendCount: a.send_count,
    expiresAt: a.expires_at,
    openedAt: a.opened_at,
    submittedAt: a.submitted_at,
    returnedVia: a.returned_via,
    reviewedAt: a.reviewed_at,
    voidedAt: a.voided_at,
    pending: count(a.id, 'pending'),
    applied: count(a.id, 'applied') + count(a.id, 'accepted'),
    files: (files.data ?? [])
      .filter((f) => f.application_id === a.id)
      .map((f) => ({ id: f.id, name: f.name, sizeBytes: f.size_bytes, readable: f.readable, fieldsFound: f.fields_found, uploadedAt: f.uploaded_at, uploadedVia: f.uploaded_via })),
  }));
  return { items, canEdit: grant === 'edit', canOpenPdfs, templateReady };
}

// ── composing ───────────────────────────────────────────────────────────────

/** An email the record already holds, offered in the To picker. */
export type Recipient = { address: string; label: string; kind: 'default' | 'other' };

export type SendDefaults = {
  to: string;
  /** Default first (the first contact's email), then every other email on the
   *  record — other contacts, affiliates, owners — each once. */
  recipients: Recipient[];
  from: FromOption[];
  subject: string;
  body: string;
  expiryDays: number;
  fileName: string;
  templateReady: boolean;
};

async function mailGate(ctx: AuthContext): Promise<void> {
  if (await currentImpersonation()) throw new ApplicationError('You are signed in as someone else. Stop impersonating to send.');
  try {
    await requireEmailAccess(ctx, 'edit');
  } catch (e) {
    if (e instanceof EmailAccessError) throw new ApplicationError(e.message);
    throw e;
  }
  for (const [i, rule] of [RATE_LIMITS.mailSendPerUserMinute, RATE_LIMITS.mailSendPerUserDay].entries()) {
    const limit = await rateLimit(userKey(`mail_send${i}`, ctx.userId), rule);
    if (!limit.allowed) throw new ApplicationError(`You're sending faster than Outlook allows. Try again in ${limit.retryAfterSeconds} seconds.`);
  }
}

const firstContact = (crm: CrmValues) =>
  (Array.isArray(crm.contact) ? (crm.contact[0] as Record<string, unknown> | undefined) : undefined) ?? {};

/**
 * "Which emails do applications go to? Can we do a picker: Default / Other
 * emails / Custom email" (the client, 30 Oct 2026). Default is the first
 * contact; the others are every email the record holds, in the groups the
 * viewer may see, each address once.
 */
function recipientsOn(crm: CrmValues, hidden: Set<string>): Recipient[] {
  const out: Recipient[] = [];
  const seen = new Set<string>();
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const add = (address: string, label: string, kind: Recipient['kind']) => {
    if (!address || seen.has(address.toLowerCase())) return;
    seen.add(address.toLowerCase());
    out.push({ address, label, kind });
  };
  const groups: [string, string, (m: Record<string, unknown>) => string][] = [
    ['contact', 'Contact', (m) => str(m.name)],
    ['affiliate', 'Affiliate', (m) => str(m.business_name) || str(m.name)],
    ['owner_ownership', 'Owner', (m) => [str(m.first), str(m.last)].filter(Boolean).join(' ')],
  ];
  for (const [key, who, nameOf] of groups) {
    if (hidden.has(key) || !Array.isArray(crm[key])) continue;
    (crm[key] as unknown[]).forEach((raw, i) => {
      const m = (raw ?? {}) as Record<string, unknown>;
      const name = nameOf(m);
      add(str(m.email), `${who}${name ? ` · ${name}` : ` ${i + 1}`}`, key === 'contact' && i === 0 ? 'default' : 'other');
    });
  }
  return out;
}

function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

/** What the Send Application modal opens with. */
export async function sendDefaults(ctx: AuthContext, recordId: string): Promise<SendDefaults> {
  await requireApplicationsEdit(ctx, recordId);
  const [rec, settings, from, templateReady, me] = await Promise.all([
    recordForApplication(recordId),
    applicationSettings(),
    fromOptions(ctx),
    templateInstalled(),
    supabaseAdmin().from('profiles').select('full_name, email').eq('id', ctx.userId).maybeSingle(),
  ]);
  if (!rec) throw new ApplicationError('That record no longer exists.');
  const hidden = await hiddenFieldKeysFor(ctx, recordId, (await loadConfig()).fields);
  const contact = hidden.has('contact') ? {} : firstContact(rec.values);
  const name = merchantName(rec.values, rec.dealName);
  const expires = new Date(Date.now() + settings.linkExpiryDays * 86400_000);
  const vars = {
    merchant: name,
    contact_name: (typeof contact.name === 'string' && contact.name.trim().split(/\s+/)[0]) || 'there',
    expires: expires.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    sender_name: (me.data?.full_name as string | undefined) || (me.data?.email as string | undefined) || '',
  };
  const recipients = recipientsOn(rec.values, hidden);
  return {
    to: typeof contact.email === 'string' ? contact.email : '',
    recipients,
    from,
    subject: fillTemplate(settings.emailSubject, vars),
    body: fillTemplate(settings.emailBody, vars),
    expiryDays: settings.linkExpiryDays,
    fileName: applicationFileName(name),
    templateReady,
  };
}

// ── sending ─────────────────────────────────────────────────────────────────

export type SendInput = {
  recordId: string;
  mailboxId: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The message as Outlook sends it: the person's words, the link as a button-like line, their signature. */
function emailHtml(body: string, link: string): string {
  const anchor = `<a href="${esc(link)}" style="color:#1d4ed8;font-weight:600;">Complete the application online</a>`;
  const withLink = body.includes('{{link}}') ? body : `${body.trimEnd()}\n\n{{link}}`;
  return withLink
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px;">${esc(para).replace(/\n/g, '<br>').replace(/\{\{\s*link\s*\}\}/g, anchor)}</p>`)
    .join('');
}

/**
 * Everything one send needs, for a new application and a resend alike: the
 * PDF built from the CRM as it is NOW, the email out through Outlook, the
 * record's email history, the activity entry.
 */
async function deliver(
  ctx: AuthContext,
  app: { id: string; number: number; recordId: string },
  token: string,
  input: Omit<SendInput, 'recordId'>,
): Promise<void> {
  const rec = await recordForApplication(app.recordId);
  if (!rec) throw new ApplicationError('That record no longer exists.');
  // What the sender may not see is not sent out in their name either.
  const hidden = await hiddenFieldKeysFor(ctx, app.recordId, (await loadConfig()).fields);
  const visible = Object.fromEntries(Object.entries(rec.values).filter(([k]) => !hidden.has(k)));
  const labels = await choiceLabels();
  const pdf = await fillApplicationPdf(await loadTemplate(), answersForPdf(prefillAnswers(visible, labels)), appLabel(app.number));
  const fileName = applicationFileName(merchantName(rec.values, rec.dealName));

  const path = `${ctx.userId}/${newId()}/${fileName.replace(/[^\w.\- ()']+/g, '_')}`;
  const up = await supabaseAdmin().storage.from(OUTBOX_BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: false });
  if (up.error) throw new ApplicationError('Could not attach the PDF. Try again.');

  const link = linkFor(token);
  const html = await withSignature(emailHtml(input.body, link), input.mailboxId, true);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('mail_outbox_submit', {
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
    p_attachments: [{ path, name: fileName, size: pdf.byteLength, contentType: 'application/pdf' }],
    p_send_at: null,
  });
  if (error) {
    await supabaseAdmin().storage.from(OUTBOX_BUCKET).remove([path]);
    throw new ApplicationError(error.code === '42501' || error.code === '22023' ? error.message : 'Outlook did not accept the message. Try again.');
  }
  const outboxId = (data as { id: string }[])[0]?.id;
  // No undo window for an application: it goes now.
  if (outboxId) after(() => sendDue({ only: outboxId, budgetMs: 50_000 }).then(() => undefined));

  const fromAddress =
    (await supabase.from('mail_mailboxes').select('address').eq('id', input.mailboxId).maybeSingle()).data?.address ?? '';
  // The merchant's email history on the record (the drawer's Email tab).
  await supabaseAdmin()
    .from('messages')
    .insert({
      record_id: app.recordId,
      channel: 'email',
      direction: 'out',
      from_identity: fromAddress || 'crm',
      to_identity: [input.to, ...input.cc].join(', '),
      subject: input.subject,
      body: `${input.body.replace(/\{\{\s*link\s*\}\}/g, link)}\n\nAttached: ${fileName}`,
      external_id: `application:${app.id}:${outboxId ?? newId()}`,
      sent_at: new Date().toISOString(),
    });
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
function checkRecipients(to: string, cc: string[]) {
  if (!isEmail(to)) throw new ApplicationError('Enter a valid recipient email address.');
  const bad = cc.find((c) => !isEmail(c));
  if (bad) throw new ApplicationError(`${bad} is not a valid email address.`);
}

export async function sendApplication(ctx: AuthContext, input: SendInput): Promise<{ id: string; label: string }> {
  await requireApplicationsEdit(ctx, input.recordId);
  await mailGate(ctx);
  checkRecipients(input.to, input.cc);
  await loadTemplate().catch((e) => {
    if (e instanceof TemplateMissingError) throw new ApplicationError(e.message);
    throw e;
  });

  const settings = await applicationSettings();
  const id = newId();
  const { token, hash } = newToken();
  const { data: row, error } = await supabaseAdmin()
    .from('applications')
    .insert({
      id,
      record_id: input.recordId,
      token_hash: toPostgresBytea(hash),
      ...sealToken(token, id),
      recipient: input.to.trim().toLowerCase(),
      cc: input.cc.map((c) => c.trim().toLowerCase()),
      subject: input.subject,
      sent_by: ctx.userId,
      expires_at: new Date(Date.now() + settings.linkExpiryDays * 86400_000).toISOString(),
    })
    .select('number')
    .single();
  if (error) throw error;
  try {
    await deliver(ctx, { id, number: row.number as number, recordId: input.recordId }, token, input);
  } catch (e) {
    // Never leave an application on the record that was never sent.
    await supabaseAdmin().from('applications').delete().eq('id', id);
    throw e;
  }
  await supabaseAdmin().rpc('application_log', {
    p_application: id,
    p_actor: ctx.userId,
    p_summary: `${appLabel(row.number as number)} sent to ${input.to}`,
  });
  await supabaseAdmin().rpc('automation_application_sent', { p_application: id });
  return { id, label: appLabel(row.number as number) };
}

/** Same link, a freshly filled PDF, and the link's clock restarted. */
export async function resendApplication(ctx: AuthContext, applicationId: string, input: Omit<SendInput, 'recordId'>): Promise<void> {
  const app = await applicationById(applicationId);
  if (!app) throw new ApplicationError('That application no longer exists.');
  await requireApplicationsEdit(ctx, app.record_id);
  if (app.status === 'voided') throw new ApplicationError('This application was voided. Send a new one instead.');
  if (!['sent', 'opened'].includes(app.status)) throw new ApplicationError('This application has already come back, so there is nothing to resend.');
  await mailGate(ctx);
  checkRecipients(input.to, input.cc);
  const { data: sealed, error } = await supabaseAdmin().from('applications').select('id, token_sealed, token_iv').eq('id', app.id).single();
  if (error) throw error;
  const token = openToken(sealed);
  await deliver(ctx, { id: app.id, number: app.number, recordId: app.record_id }, token, input);
  const settings = await applicationSettings();
  await supabaseAdmin()
    .from('applications')
    .update({
      recipient: input.to.trim().toLowerCase(),
      cc: input.cc.map((c) => c.trim().toLowerCase()),
      subject: input.subject,
      last_sent_at: new Date().toISOString(),
      send_count: app.send_count + 1,
      expires_at: new Date(Date.now() + settings.linkExpiryDays * 86400_000).toISOString(),
    })
    .eq('id', app.id);
  await supabaseAdmin().rpc('application_log', { p_application: app.id, p_actor: ctx.userId, p_summary: `${appLabel(app.number)} sent again to ${input.to}` });
  await supabaseAdmin().rpc('automation_application_sent', { p_application: app.id });
}

/** The link stops working. Answers already returned stay. */
export async function voidApplication(ctx: AuthContext, applicationId: string): Promise<void> {
  const app = await applicationById(applicationId);
  if (!app) throw new ApplicationError('That application no longer exists.');
  await requireApplicationsEdit(ctx, app.record_id);
  if (app.status === 'voided') return;
  if (app.status === 'reviewed') throw new ApplicationError('This application is already reviewed; there is nothing left to void.');
  const { error } = await supabaseAdmin()
    .from('applications')
    .update({ status: 'voided', voided_at: new Date().toISOString(), voided_by: ctx.userId })
    .eq('id', app.id);
  if (error) throw error;
  // Anything still waiting for review is dropped with it.
  await supabaseAdmin().from('application_changes').delete().eq('application_id', app.id).eq('status', 'pending');
  await supabaseAdmin().rpc('application_log', { p_application: app.id, p_actor: ctx.userId, p_summary: `${appLabel(app.number)} voided — the link no longer works` });
}

// ── returned PDFs ───────────────────────────────────────────────────────────

/*
 * Upload in two steps, because a Vercel function takes at most 4.5 MB of
 * request body and a returned application can be larger: the browser puts the
 * file straight into private storage through a one-time signed URL, then the
 * server takes it from there — reads it, deletes the plain copy, and stores it
 * encrypted. Callers gate who may get a URL; the path shape is checked again
 * when the file is taken, so no other object can be pulled through here.
 */
const INCOMING = /^incoming\/[0-9a-f-]{36}\.pdf$/;

export async function signedPdfUpload(): Promise<{ path: string; token: string }> {
  const path = `incoming/${newId()}.pdf`;
  const { data, error } = await supabaseAdmin().storage.from(FILES_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new ApplicationError('Could not prepare the upload. Try again.');
  return { path: data.path, token: data.token };
}

export async function readIncoming(path: string): Promise<Uint8Array> {
  if (!INCOMING.test(path)) throw new ApplicationError('That upload is not valid.');
  const dl = await supabaseAdmin().storage.from(FILES_BUCKET).download(path);
  if (dl.error || !dl.data) throw new ApplicationError('The upload did not arrive, or has expired. Upload the PDF again.');
  return new Uint8Array(await dl.data.arrayBuffer());
}

/** The plain staged copy goes as soon as the file is stored encrypted (or refused). */
export async function dropIncoming(path: string): Promise<void> {
  if (!INCOMING.test(path)) return;
  await supabaseAdmin().storage.from(FILES_BUCKET).remove([path]);
}

export async function prepareCrmUpload(ctx: AuthContext, recordId: string) {
  await requireApplicationsEdit(ctx, recordId);
  return signedPdfUpload();
}

/** Encrypts and stores a returned PDF; returns its id. */
export async function storeReturnedPdf(opts: {
  recordId: string;
  applicationId: string | null;
  name: string;
  bytes: Uint8Array;
  readable: boolean;
  fieldsFound: number;
  uploadedBy: string | null;
  via: 'crm' | 'merchant';
}): Promise<string> {
  const id = newId();
  const sealed = sealBytes(Buffer.from(opts.bytes), `application-file:${id}`);
  const path = `${opts.recordId}/${id}.bin`;
  const up = await supabaseAdmin().storage.from(FILES_BUCKET).upload(path, sealed.data, { contentType: 'application/octet-stream', upsert: false });
  if (up.error) throw new ApplicationError('Could not store the PDF. Try again.');
  const safeName = opts.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 200) || 'Application.pdf';
  const { error } = await supabaseAdmin().from('application_files').insert({
    id,
    application_id: opts.applicationId,
    record_id: opts.recordId,
    storage_path: path,
    name: safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`,
    size_bytes: opts.bytes.byteLength,
    iv: toPostgresBytea(sealed.iv),
    readable: opts.readable,
    fields_found: opts.fieldsFound,
    uploaded_by: opts.uploadedBy,
    uploaded_via: opts.via,
  });
  if (error) {
    await supabaseAdmin().storage.from(FILES_BUCKET).remove([path]);
    throw error;
  }
  return id;
}

export type UploadOutcome =
  | { kind: 'imported'; applicationId: string; label: string; applied: number; pending: number }
  | { kind: 'unreadable'; applicationId: string; label: string; fileId: string }
  | { kind: 'choose'; reason: 'missing' | 'other_merchant' | 'not_open'; foundLabel: string | null; options: { id: string; label: string; status: ApplicationStatus }[] };

/**
 * "Upload completed application". The PDF's hidden ID decides where it goes;
 * when it is missing or belongs to another merchant, the user is asked
 * (spec: "warn the user and ask which application it belongs to").
 */
export async function uploadReturnedPdf(
  ctx: AuthContext,
  input: { recordId: string; applicationId: string | null; name: string; bytes: Uint8Array },
): Promise<UploadOutcome> {
  await requireApplicationsEdit(ctx, input.recordId);
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_PDF) throw new ApplicationError('The PDF must be under 25 MB.');
  if (Buffer.from(input.bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new ApplicationError('That file is not a PDF.');

  const read = await readApplicationPdf(input.bytes);
  const own = (
    await supabaseAdmin().from('applications').select('id, number, status, expires_at').eq('record_id', input.recordId).order('sent_at', { ascending: false })
  ).data as { id: string; number: number; status: ApplicationStatus; expires_at: string }[] | null;
  const options = (own ?? [])
    .filter((a) => a.status !== 'voided' && a.status !== 'reviewed')
    .map((a) => ({ id: a.id, label: appLabel(a.number), status: effectiveStatus(a) }));

  let app: ApplicationRow | null = null;
  if (input.applicationId) {
    app = await applicationById(input.applicationId);
    if (!app || app.record_id !== input.recordId) throw new ApplicationError('That application is not on this record.');
  } else {
    const n = parseAppLabel(read.appLabel);
    const found = n !== null ? await applicationByNumber(n) : null;
    if (!found) return { kind: 'choose', reason: 'missing', foundLabel: read.appLabel, options };
    if (found.record_id !== input.recordId) return { kind: 'choose', reason: 'other_merchant', foundLabel: read.appLabel, options };
    app = found;
  }
  if (app.status === 'voided') throw new ApplicationError(`${appLabel(app.number)} was voided. Choose another application.`);
  if (app.status === 'reviewed') return { kind: 'choose', reason: 'not_open', foundLabel: appLabel(app.number), options };

  const fileId = await storeReturnedPdf({
    recordId: input.recordId,
    applicationId: app.id,
    name: input.name,
    bytes: input.bytes,
    readable: read.readable,
    fieldsFound: read.fieldsFound,
    uploadedBy: ctx.userId,
    via: 'crm',
  });

  if (!read.readable) {
    await supabaseAdmin()
      .from('applications')
      .update({ status: 'pdf_uploaded', submitted_at: app.submitted_at ?? new Date().toISOString(), returned_via: 'pdf' })
      .eq('id', app.id);
    await supabaseAdmin().rpc('application_log', {
      p_application: app.id,
      p_actor: ctx.userId,
      p_summary: `${appLabel(app.number)} returned as a PDF with no readable fields — enter the answers by hand`,
    });
    return { kind: 'unreadable', applicationId: app.id, label: appLabel(app.number), fileId };
  }
  const r = await ingest(app, read.answers, 'pdf', ctx.userId);
  return { kind: 'imported', applicationId: app.id, label: appLabel(app.number), ...r };
}

/** The decrypted bytes of a returned PDF, for someone allowed to open it. */
export async function openReturnedPdf(ctx: AuthContext, fileId: string): Promise<{ name: string; bytes: Buffer }> {
  if (!(await canOpenReturnedPdfs(ctx))) throw new ApplicationError('You do not have access to returned application PDFs.');
  // RLS: only a file on a record this person can open comes back.
  const supabase = await createSupabaseServerClient();
  const { data: visible } = await supabase.from('application_files').select('id').eq('id', fileId).maybeSingle();
  if (!visible) throw new ApplicationError('That file is not available.');
  const { data: row, error } = await supabaseAdmin().from('application_files').select('id, name, storage_path, iv').eq('id', fileId).single();
  if (error) throw error;
  const dl = await supabaseAdmin().storage.from(FILES_BUCKET).download(row.storage_path as string);
  if (dl.error || !dl.data) throw new ApplicationError('That file could not be read.');
  const bytes = openBytes({ data: Buffer.from(await dl.data.arrayBuffer()), iv: fromBytea(row.iv) }, `application-file:${row.id}`);
  return { name: row.name as string, bytes };
}

// ── manual entry (unreadable PDF) ───────────────────────────────────────────

export async function enterAnswersByHand(ctx: AuthContext, applicationId: string, raw: unknown) {
  const app = await applicationById(applicationId);
  if (!app) throw new ApplicationError('That application no longer exists.');
  await requireApplicationsEdit(ctx, app.record_id);
  if (app.status === 'voided' || app.status === 'reviewed') throw new ApplicationError('This application is closed.');
  const answers: Answers = sanitizeAnswers(raw);
  return ingest(app, answers, 'manual', ctx.userId);
}

// ── review ──────────────────────────────────────────────────────────────────

export type ReviewRow = {
  id: string;
  question: string;
  fieldKey: string;
  crmDisplay: string | null;
  answerDisplay: string;
  candidates: { display: string }[] | null;
  via: 'online' | 'pdf' | 'manual';
  canAccept: boolean;
};
export type ReviewData = {
  application: ApplicationView | null;
  rows: ReviewRow[];
  decided: { id: string; question: string; answerDisplay: string; status: 'applied' | 'accepted' | 'kept'; decidedAt: string | null }[];
  canEdit: boolean;
  fileId: string | null;
};

export async function reviewFor(ctx: AuthContext, applicationId: string): Promise<ReviewData> {
  const app = await applicationById(applicationId);
  if (!app) throw new ApplicationError('That application no longer exists.');
  const panel = await applicationsFor(ctx, app.record_id);
  const view = panel.items.find((i) => i.id === applicationId) ?? null;
  if (!view) throw new ApplicationError('That application is not available.');
  // RLS hides rows for fields this person may not see.
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('application_changes')
    .select('id, question, field_key, crm_display, answer_display, answer_value, via, status, decided_at, created_at')
    .eq('application_id', applicationId)
    .order('created_at');
  if (error) throw error;
  const config = await loadConfig();
  const fields = new Map(config.fields.map((f) => [f.key, f]));
  const editable = new Map<string, boolean>();
  for (const key of new Set((data ?? []).map((r) => r.field_key as string))) {
    const caps = await fieldCapsFor(ctx, [app.record_id], fields.get(key));
    editable.set(key, panel.canEdit && caps.get(app.record_id) === 'edit');
  }
  const rows: ReviewRow[] = [];
  const decided: ReviewData['decided'] = [];
  for (const r of data ?? []) {
    const av = (r.answer_value ?? {}) as { c?: { display: string }[] };
    if (r.status === 'pending') {
      rows.push({
        id: r.id,
        question: r.question,
        fieldKey: r.field_key,
        crmDisplay: r.crm_display,
        answerDisplay: r.answer_display,
        candidates: av.c ? av.c.map((c) => ({ display: c.display })) : null,
        via: r.via,
        canAccept: editable.get(r.field_key) ?? false,
      });
    } else {
      decided.push({ id: r.id, question: r.question, answerDisplay: r.answer_display, status: r.status, decidedAt: r.decided_at });
    }
  }
  return { application: view, rows, decided, canEdit: panel.canEdit, fileId: view.files[0]?.id ?? null };
}

export type Decision = { changeId: string; decision: 'accept' | 'keep'; pick?: number };

/** Accept / Keep CRM value, one or many. Values, history and decisions in one transaction. */
export async function decide(ctx: AuthContext, applicationId: string, decisions: Decision[]): Promise<{ remaining: number }> {
  const app = await applicationById(applicationId);
  if (!app) throw new ApplicationError('That application no longer exists.');
  await requireApplicationsEdit(ctx, app.record_id);
  if (app.status === 'voided') throw new ApplicationError('This application was voided.');
  const ids = [...new Set(decisions.map((d) => d.changeId))];
  if (!ids.length) return { remaining: await pendingCount(app.id) };

  const config = await loadConfig();
  const fields = new Map(config.fields.map((f) => [f.key, f]));
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data: rows, error } = await supabaseAdmin()
      .from('application_changes')
      .select('id, target, field_key, question, answer_value, via, status')
      .eq('application_id', app.id)
      .in('id', ids);
    if (error) throw error;
    const pending = (rows ?? []).filter((r) => r.status === 'pending');
    const byId = new Map(pending.map((r) => [r.id as string, r]));
    const accepts: { target: NonNullable<ReturnType<typeof parseTargetKey>>; value: unknown; question: string }[] = [];
    const acceptIds: string[] = [];
    const keepIds: string[] = [];
    let via: 'online' | 'pdf' | 'manual' = 'online';
    for (const d of decisions) {
      const r = byId.get(d.changeId);
      if (!r) continue;
      if (d.decision === 'keep') {
        keepIds.push(r.id);
        continue;
      }
      const caps = await fieldCapsFor(ctx, [app.record_id], fields.get(r.field_key as string));
      if (caps.get(app.record_id) !== 'edit') throw new ApplicationError(`You cannot change ${fields.get(r.field_key as string)?.label ?? r.field_key}.`);
      const target = parseTargetKey(r.target as string);
      if (!target) continue;
      const av = (r.answer_value ?? {}) as { v?: unknown; c?: { value: unknown }[] };
      let value = av.v;
      if (av.c) {
        if (d.pick === undefined || !av.c[d.pick]) throw new ApplicationError(`Choose a value for “${r.question}” before accepting it.`);
        value = av.c[d.pick]!.value;
      }
      accepts.push({ target, value, question: r.question as string });
      acceptIds.push(r.id);
      via = r.via as typeof via;
    }
    const rec = await recordForApplication(app.record_id);
    if (!rec) throw new ApplicationError('That record no longer exists.');
    const write = buildWrite(accepts, rec.values);
    const { error: werr } = await supabaseAdmin().rpc('application_write_values', {
      p_application: app.id,
      p_values: write.values,
      p_notes: write.notes,
      p_change_ids: acceptIds,
      p_status: 'accepted',
      p_kept_ids: keepIds,
      p_actor: ctx.userId,
      p_via: via,
      p_expected_updated_at: rec.updatedAt,
    });
    if (werr?.code === '40001' && attempt === 0) continue;
    if (werr) throw werr;
    return { remaining: await pendingCount(app.id) };
  }
  throw new ApplicationError('The record kept changing. Try again.');
}

async function pendingCount(applicationId: string): Promise<number> {
  const { count } = await supabaseAdmin()
    .from('application_changes')
    .select('id', { count: 'exact', head: true })
    .eq('application_id', applicationId)
    .eq('status', 'pending');
  return count ?? 0;
}

export { linkIsLive };

// ── the application page (review / details / enter by hand) ─────────────────

export type ApplicationPageData = ReviewData & {
  recordName: string;
  recordHref: string | null;
  canOpenPdfs: boolean;
  file: { id: string; name: string } | null;
  /** Answers to start hand entry from (the CRM's values), when the PDF had no readable fields. */
  manual: { answers: Answers; ssnOnFile: Record<number, string> } | null;
};

export async function applicationPage(ctx: AuthContext, applicationId: string): Promise<ApplicationPageData> {
  const review = await reviewFor(ctx, applicationId);
  const app = await applicationById(applicationId);
  if (!app || !review.application) throw new ApplicationError('That application is not available.');
  const [rec, config, canOpenPdfs] = await Promise.all([recordForApplication(app.record_id), loadConfig(), canOpenReturnedPdfs(ctx)]);
  if (!rec) throw new ApplicationError('That record no longer exists.');

  // Back to the record, in the first display module this person can see it in.
  const supabase = await createSupabaseServerClient();
  const { data: mods } = await supabase.from('record_modules').select('module_id').eq('record_id', app.record_id);
  const ids = new Set((mods ?? []).map((m) => m.module_id as string));
  const mod = config.modules.filter((m) => ids.has(m.id) && m.kind === 'display').sort((a, b) => a.position - b.position)[0];

  const files = review.application.files;
  const unreadable =
    review.application.status === 'pdf_uploaded' && review.rows.length === 0 && review.decided.length === 0 && files.some((f) => !f.readable);
  let manual: ApplicationPageData['manual'] = null;
  if (unreadable && review.canEdit) {
    const hidden = await hiddenFieldKeysFor(ctx, app.record_id, config.fields);
    const visible = Object.fromEntries(Object.entries(rec.values).filter(([k]) => !hidden.has(k)));
    manual = { answers: prefillAnswers(visible, await choiceLabels()), ssnOnFile: hidden.has('owner_private') ? {} : ssnOnFileFor(rec.values) };
  }
  return {
    ...review,
    recordName: merchantName(rec.values, rec.dealName),
    recordHref: mod ? `/${mod.slug}?record=${app.record_id}` : null,
    canOpenPdfs,
    file: files[0] && canOpenPdfs ? { id: files[0].id, name: files[0].name } : null,
    manual,
  };
}

// ── Presets › Application ───────────────────────────────────────────────────

export async function readApplicationSettings(ctx: AuthContext) {
  await assertAdminPage(ctx, 'presets');
  return applicationSettings();
}

export async function saveApplicationSettings(ctx: AuthContext, input: { linkExpiryDays: number; emailSubject: string; emailBody: string }): Promise<void> {
  await assertAdminPage(ctx, 'presets');
  // Through the person's own client: the function checks the Presets page again.
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_application_settings', {
    p_expiry_days: input.linkExpiryDays,
    p_subject: input.emailSubject,
    p_body: input.emailBody,
  });
  if (error) throw new ApplicationError(error.code === '23514' || error.code === '42501' ? error.message : 'The settings were not saved. Try again.');
}
