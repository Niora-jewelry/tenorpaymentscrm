/**
 * Sends what the outbox holds once its undo window (or scheduled time) has
 * passed. Always draft → attachments → send, so every step is resumable:
 *
 *   1. The Outlook draft — the composer's autosaved one, or a new one made
 *      here (createReply/Forward for answers). Its id is written down BEFORE
 *      anything else, so a retry continues the same draft.
 *   2. Final content written onto it (subject, body + Outlook's quote,
 *      recipients).
 *   3. Attachments not yet uploaded: up to 3 MB in one request, larger ones
 *      through Microsoft's upload session in 4 MB chunks (bytes go to
 *      Microsoft's pre-authorised upload host only — never our token).
 *      Each is marked uploaded as it lands.
 *   4. /send.
 * A retry after an unclear failure first asks Outlook whether the draft still
 * exists as a draft; if not, it was sent, and nothing is sent twice.
 *
 * Failures Outlook means (too large, Send As denied, quota, bad address) fail
 * the message at once with a notice that says which; anything transient is
 * retried with backoff, five times.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env.server';
import { graphForIdentity } from '../tokens';
import { GraphError, type GraphTransport } from '../graph/transport';
import { rootFor } from '../sync/folders';
import { nextSyncDelayMinutes } from '../backoff';
import { messageFor } from '../messages';
import { mailLog } from '../log';
import type { Addr } from '../viewTypes';
import { createGraphDraft, patchGraphDraft } from './drafts';
import { isUploadHost } from './recipients';

export const OUTBOX_BUCKET = 'mail-outbox';
const SMALL_ATTACHMENT = 3 * 1024 * 1024;
/** 12 × 320 KiB: Microsoft wants chunks in multiples of 320 KiB, at most 4 MB. */
const CHUNK = 12 * 320 * 1024;
const MAX_ATTEMPTS = 5;
const PERMANENT = new Set(['too_large', 'send_as_denied', 'send_quota', 'bad_recipient', 'scope_missing', 'mailbox_access_removed', 'mailbox_not_found', 'reconnect_required', 'consent_required']);

type StoredAttachment = { path: string; name: string; size: number; contentType: string; uploaded?: boolean };

type OutboxRow = {
  id: string;
  mailbox_id: string;
  user_id: string;
  identity_id: string | null;
  kind: 'new' | 'reply' | 'replyAll' | 'forward';
  source_graph_id: string | null;
  existing_draft_graph_id: string | null;
  draft_id: string | null;
  subject: string | null;
  body_html: string;
  to_recipients: Addr[];
  cc_recipients: Addr[];
  bcc_recipients: Addr[];
  attachments: StoredAttachment[];
  draft_graph_id: string | null;
  quote_html: string;
  internet_message_id: string | null;
  attempts: number;
  automation_run_id: string | null;
};

export type SendSummary = { sent: number; failed: number; retried: number };

/** Sends every due message (or just one), within the caller's time budget. */
export async function sendDue(opts: { only?: string; budgetMs?: number } = {}): Promise<SendSummary> {
  const admin = supabaseAdmin();
  const owner = `send-${randomUUID()}`;
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const summary: SendSummary = { sent: 0, failed: 0, retried: 0 };
  while (Date.now() < deadline - 5_000) {
    const { data, error } = await admin.rpc('mail_claim_outbox', { p_owner: owner, p_limit: 5, p_lease_seconds: 180, p_only: opts.only ?? null });
    if (error) {
      mailLog('error', 'send', 'claim_failed', { code: error.code });
      break;
    }
    const rows = (data ?? []) as OutboxRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const r = await sendOne(row);
      summary[r] += 1;
    }
    if (opts.only) break;
  }
  return summary;
}

async function sendOne(claimed: OutboxRow): Promise<keyof SendSummary> {
  let row = claimed;
  const admin = supabaseAdmin();
  const { data: mb } = await admin.from('mail_mailboxes').select('address, graph_user_id').eq('id', row.mailbox_id).maybeSingle();
  if (!mb || !row.identity_id) return fail(row, 'reconnect_required', null);
  const graph = graphForIdentity(row.identity_id);
  const root = rootFor({ graph_user_id: mb.graph_user_id as string | null, address: mb.address as string });
  const s = { graph, root };

  try {
    let draft = row.draft_graph_id ?? row.existing_draft_graph_id;

    // A send that died after /send: if Outlook no longer has it as a draft, it went.
    // (A draft that is simply GONE is decided in the catch below: Sent Items, or deleted.)
    if (draft && row.attempts > 1) {
      const m = await graph.request<{ isDraft?: boolean }>({ path: `${root}/messages/${encodeURIComponent(draft)}`, query: { $select: 'isDraft' } });
      if (m?.isDraft === false) return done(row, mb.address as string, draft);
    }

    // Outlook's quoted history: the composer's draft keeps it on mail_drafts;
    // a draft this engine made keeps it on the outbox row, so a retry has it.
    let quote = row.quote_html ?? '';
    if (row.draft_id) {
      const { data: d } = await admin.from('mail_drafts').select('quote_html').eq('id', row.draft_id).maybeSingle();
      quote = (d?.quote_html as string | undefined) ?? '';
    }
    if (!draft) {
      const created = await createGraphDraft(s, row.kind, row.source_graph_id);
      draft = created.id;
      quote = created.quote;
      await admin.from('mail_outbox').update({ draft_graph_id: draft, quote_html: quote, updated_at: new Date().toISOString() }).eq('id', row.id);
    } else if (draft !== row.draft_graph_id) {
      await admin.from('mail_outbox').update({ draft_graph_id: draft, updated_at: new Date().toISOString() }).eq('id', row.id);
    }
    row = { ...row, draft_graph_id: draft };

    const patched = await patchGraphDraft(s, draft, {
      subject: row.subject ?? '',
      html: row.body_html,
      quote,
      to: row.to_recipients,
      cc: row.cc_recipients,
      bcc: row.bcc_recipients,
    });
    if (patched.internetMessageId && patched.internetMessageId !== row.internet_message_id) {
      await admin.from('mail_outbox').update({ internet_message_id: patched.internetMessageId }).eq('id', row.id);
      row = { ...row, internet_message_id: patched.internetMessageId };
    }

    const atts = [...(row.attachments ?? [])];
    for (let i = 0; i < atts.length; i += 1) {
      if (atts[i].uploaded) continue;
      await uploadAttachment(graph, root, draft, atts[i]);
      atts[i] = { ...atts[i], uploaded: true };
      // Mark it AND renew the lease: a long upload must not let another worker re-claim the row.
      await admin
        .from('mail_outbox')
        .update({ attachments: atts, lease_until: new Date(Date.now() + 180_000).toISOString() })
        .eq('id', row.id);
    }

    await graph.request({ method: 'POST', path: `${root}/messages/${encodeURIComponent(draft)}/send` });
    return done(row, mb.address as string, draft);
  } catch (e) {
    const code = e instanceof GraphError ? e.classified.code : 'internal';
    mailLog('warn', 'send', 'send_failed', {
      outboxId: row.id,
      code,
      attempt: row.attempts,
      // Not a Graph answer: say what broke (a network error, a storage failure) — never content.
      ...(e instanceof GraphError ? {} : { detail: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : 'unknown', cause: e instanceof Error && e.cause ? String(e.cause).slice(0, 160) : undefined }),
    });
    if (code === 'not_found') {
      // The draft (or the message being answered) is gone from Outlook. If it is
      // in Sent Items, it went; otherwise someone deleted it — say so, never "sent".
      const sentId = row.internet_message_id ? await findInSent(graph, root, row.internet_message_id).catch(() => null) : null;
      if (sentId) return done(row, mb.address as string, sentId);
      return fail(row, row.draft_graph_id ? 'draft_gone' : 'source_gone', mb.address as string);
    }
    if (PERMANENT.has(code) || row.attempts >= MAX_ATTEMPTS) return fail(row, code, mb.address as string);
    const wait = (e instanceof GraphError && e.classified.retryAfterSeconds ? e.classified.retryAfterSeconds * 1000 : nextSyncDelayMinutes(row.attempts) * 60_000);
    await admin
      .from('mail_outbox')
      .update({ status: 'held', release_at: new Date(Date.now() + wait).toISOString(), lease_until: null, last_error_code: code.slice(0, 64), updated_at: new Date().toISOString() })
      .eq('id', row.id);
    return 'retried';
  }
}

/** The Sent Items copy of a message, by its internetMessageId. */
async function findInSent(graph: GraphTransport, root: string, internetMessageId: string): Promise<string | null> {
  const res = await graph.request<{ value?: Array<{ id?: string }> }>({
    path: `${root}/mailFolders/sentitems/messages`,
    query: { $filter: `internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`, $select: 'id', $top: 1 },
  });
  return res?.value?.[0]?.id ?? null;
}

async function uploadAttachment(graph: GraphTransport, root: string, draft: string, att: StoredAttachment): Promise<void> {
  const admin = supabaseAdmin();
  const { data: blob, error } = await admin.storage.from(OUTBOX_BUCKET).download(att.path);
  if (error || !blob) throw new GraphError(0, { code: 'unknown', reaction: 'none', detail: 'attachment_missing' }, null);
  const bytes = Buffer.from(await blob.arrayBuffer());
  const base = `${root}/messages/${encodeURIComponent(draft)}/attachments`;

  if (bytes.length <= SMALL_ATTACHMENT) {
    await graph.request({
      method: 'POST',
      path: base,
      body: { '@odata.type': '#microsoft.graph.fileAttachment', name: att.name, contentType: att.contentType || 'application/octet-stream', contentBytes: bytes.toString('base64') },
    });
    return;
  }

  const session = await graph.request<{ uploadUrl?: string }>({
    method: 'POST',
    path: `${base}/createUploadSession`,
    body: { AttachmentItem: { attachmentType: 'file', name: att.name, size: bytes.length, contentType: att.contentType || 'application/octet-stream' } },
  });
  const url = session?.uploadUrl ?? '';
  if (!isUploadHost(url, serverEnv.MAIL_PROVIDER === 'mock' ? serverEnv.MAIL_MOCK_BASE_URL : undefined)) {
    throw new GraphError(0, { code: 'unknown', reaction: 'none', detail: 'upload_host_refused' }, null);
  }
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length) - 1;
    const res = await fetch(url, {
      method: 'PUT',
      // Pre-authorised URL: no Authorization header, by Microsoft's design.
      // Content-Length comes from the body itself (fetch refuses a hand-set one).
      headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
      body: new Uint8Array(bytes.subarray(start, end + 1)),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new GraphError(res.status, res.status === 413 ? { code: 'too_large', reaction: 'none' } : { code: 'provider_down', reaction: 'reschedule' }, null);
    }
  }
}

async function done(row: OutboxRow, address: string, draft: string): Promise<'sent'> {
  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  await admin
    .from('mail_outbox')
    .update({ status: 'sent', sent_at: now, sent_graph_id: draft, lease_until: null, last_error_code: null, last_error: null, updated_at: now })
    .eq('id', row.id);
  if (row.draft_id) await admin.from('mail_drafts').update({ deleted_at: now }).eq('id', row.draft_id);
  const paths = (row.attachments ?? []).map((a) => a.path).filter(Boolean);
  if (paths.length) await admin.storage.from(OUTBOX_BUCKET).remove(paths);
  // Show it in Sent Items (and gone from Drafts) without waiting for the scheduler.
  await admin.rpc('mail_enqueue_hot', { p_mailbox_id: row.mailbox_id });
  if (row.automation_run_id) await admin.rpc('automation_mail_result', { p_outbox: row.id, p_ok: true, p_error: null });
  mailLog('info', 'send', 'sent', { outboxId: row.id, mailbox: address.split('@')[1] ?? '' });
  return 'sent';
}

async function fail(row: OutboxRow, code: string, address: string | null): Promise<'failed'> {
  const admin = supabaseAdmin();
  const now = new Date().toISOString();
  const first = row.to_recipients[0]?.name || row.to_recipients[0]?.address || 'your recipient';
  const why =
    code === 'draft_gone'
      ? 'Its draft was deleted in Outlook before it could go.'
      : code === 'source_gone'
        ? 'The message it answers is no longer in Outlook.'
        : code === 'internal' || code === 'unknown' || code === 'provider_down'
          ? MAIL_FALLBACK
          : messageFor(code as never, { shared: address ?? undefined, to: first, address: address ?? undefined });
  const subject = row.subject?.trim() ? `“${row.subject.trim().slice(0, 80)}”` : 'Your message';
  await admin
    .from('mail_outbox')
    .update({ status: 'failed', lease_until: null, last_error_code: code.slice(0, 64), last_error: why.slice(0, 500), updated_at: now })
    .eq('id', row.id);
  await admin.from('mail_notices').insert({
    user_id: row.user_id,
    mailbox_id: row.mailbox_id,
    outbox_id: row.id,
    kind: 'send_failed',
    body: `${subject} to ${first} didn't send. ${why}`.slice(0, 500),
  });
  if (row.automation_run_id) await admin.rpc('automation_mail_result', { p_outbox: row.id, p_ok: false, p_error: why.slice(0, 300) });
  return 'failed';
}

const MAIL_FALLBACK = 'It is still in your Drafts — open it to try again.';
