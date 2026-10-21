/**
 * Writes Graph messages into `mail_messages` (and their attachment lists).
 *
 * ── OUTLOOK WINS, EXCEPT FOR A FEW SECONDS ───────────────────────────────
 * Graph's copy overwrites ours — with one exception. When the person just
 * marked a message read or moved it, and that change is still on its way to
 * Microsoft (a queued/running `mail_ops` row), a sync landing in between
 * would flip the message back for a moment. So for those messages the fields
 * the pending op is changing keep OUR value, and the message is re-checked a
 * few seconds later, when Graph has caught up. Once the op is done, Graph's
 * value is the truth again, whatever it is.
 *
 * ── RESURRECTION ─────────────────────────────────────────────────────────
 * The unique key is (mailbox, immutable graph id) and NOT partial, so a
 * message that was tombstoned (left a folder) and then shows up in another
 * folder revives the same row — same id, same pins — instead of colliding.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { batchItemError, type GraphTransport } from '../graph/transport';
import { needsAttachmentList, toMessageRow, type GraphMessage, type MessageRow } from './messageMap';
import { mailLog } from '../log';

export type FolderInfo = { id: string; graph_id: string; well_known: string | null };

export type MailboxCtx = {
  id: string;
  address: string;
  /** `/users/{id-or-address}` */
  root: string;
  graph: GraphTransport;
  foldersByGraphId: Map<string, FolderInfo>;
  foldersById: Map<string, FolderInfo>;
};

/** Keep one PostgREST request comfortably small. */
const MAX_CHUNK_BYTES = 4_000_000;
const MAX_CHUNK_ROWS = 50;

const GUARDED_KINDS: Record<string, keyof MessageRow> = {
  mark_read: 'is_read',
  mark_unread: 'is_read',
  move: 'folder_id',
  hard_delete: 'deleted_at',
};

function chunks(rows: MessageRow[]): MessageRow[][] {
  const out: MessageRow[][] = [];
  let cur: MessageRow[] = [];
  let size = 0;
  for (const r of rows) {
    const s = (r.body_html?.length ?? 0) + (r.body_text?.length ?? 0) + 2_000;
    if (cur.length && (size + s > MAX_CHUNK_BYTES || cur.length >= MAX_CHUNK_ROWS)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type IngestResult = { upserted: number; unknownFolder: boolean; guarded: number };

/**
 * @param walked the folder whose delta produced these (a fallback when Graph
 *               omits parentFolderId); null for single-message fetches.
 */
export async function ingestMessages(mb: MailboxCtx, messages: GraphMessage[], walked: FolderInfo | null): Promise<IngestResult> {
  // Never store a bare entry as a message: it would overwrite real fields with blanks.
  const live = messages.filter((m) => m?.id && !m['@removed'] && ('receivedDateTime' in m || 'sentDateTime' in m || 'subject' in m));
  if (live.length === 0) return { upserted: 0, unknownFolder: false, guarded: 0 };
  const admin = supabaseAdmin();
  let unknownFolder = false;

  const rows = live.map((m) => {
    let folder: FolderInfo | null = walked;
    if (m.parentFolderId) {
      const f = mb.foldersByGraphId.get(m.parentFolderId);
      if (f) folder = f;
      else {
        unknownFolder = true;
        folder = null;
      }
    }
    return toMessageRow(m, {
      mailboxId: mb.id,
      mailboxAddress: mb.address,
      folderId: folder?.id ?? null,
      folderWellKnown: folder?.well_known ?? null,
    });
  });

  // A folder created in Outlook since the last tree refresh: store the mail
  // now (folder unknown), and learn the folder so the next pass files it.
  if (unknownFolder) {
    await admin.rpc('mail_enqueue', { p_mailbox_id: mb.id, p_kind: 'folders_refresh', p_target: '', p_priority: 2 });
  }

  // ── pending-op guard ────────────────────────────────────────────────────
  const ids = rows.map((r) => r.graph_id);
  const { data: ops, error: opsErr } = await admin
    .from('mail_ops')
    .select('target_graph_id, kind')
    .eq('mailbox_id', mb.id)
    .in('status', ['queued', 'running'])
    .in('target_graph_id', ids);
  if (opsErr) throw new Error(`mail_ops read failed: ${opsErr.code ?? 'db'}`);

  const guardedFields = new Map<string, Set<keyof MessageRow>>();
  for (const op of ops ?? []) {
    const field = GUARDED_KINDS[op.kind as string];
    if (!field || !op.target_graph_id) continue;
    const set = guardedFields.get(op.target_graph_id) ?? new Set();
    set.add(field);
    guardedFields.set(op.target_graph_id, set);
  }
  if (guardedFields.size > 0) {
    const { data: current } = await admin
      .from('mail_messages')
      .select('graph_id, is_read, folder_id, deleted_at')
      .eq('mailbox_id', mb.id)
      .in('graph_id', [...guardedFields.keys()]);
    const byId = new Map((current ?? []).map((c) => [c.graph_id as string, c as Record<string, unknown>]));
    for (const r of rows) {
      const fields = guardedFields.get(r.graph_id);
      const cur = byId.get(r.graph_id);
      if (!fields || !cur) continue;
      for (const f of fields) (r as Record<string, unknown>)[f] = cur[f];
    }
    for (const gid of guardedFields.keys()) {
      await admin.rpc('mail_enqueue', {
        p_mailbox_id: mb.id,
        p_kind: 'message_changed',
        p_target: gid,
        p_priority: 2,
        p_delay_seconds: 5,
      });
    }
  }

  // ── upsert ──────────────────────────────────────────────────────────────
  const stored = new Map<string, string>(); // graph id → our id
  for (const chunk of chunks(rows)) {
    const { data, error } = await admin
      .from('mail_messages')
      .upsert(chunk, { onConflict: 'mailbox_id,graph_id' })
      .select('id, graph_id');
    if (error) throw new Error(`mail_messages upsert failed: ${error.code ?? 'db'}`);
    for (const d of data ?? []) stored.set(d.graph_id as string, d.id as string);
  }

  // ── attachment lists, first sight only ──────────────────────────────────
  const wanted = live.filter(needsAttachmentList).map((m) => ({ graphId: m.id, messageId: stored.get(m.id) })).filter((x): x is { graphId: string; messageId: string } => !!x.messageId);
  if (wanted.length) {
    const { data: have } = await admin
      .from('mail_attachments')
      .select('message_id')
      .in('message_id', wanted.map((w) => w.messageId));
    const already = new Set((have ?? []).map((h) => h.message_id as string));
    const todo = wanted.filter((w) => !already.has(w.messageId));
    if (todo.length) await syncAttachmentLists(mb, todo);
  }

  return { upserted: stored.size, unknownFolder, guarded: guardedFields.size };
}

type GraphAttachment = { id?: string; name?: string | null; contentType?: string | null; size?: number | null; isInline?: boolean | null; '@odata.type'?: string };

function kindOf(t: string | undefined): 'file' | 'item' | 'reference' {
  if (t === '#microsoft.graph.itemAttachment') return 'item';
  if (t === '#microsoft.graph.referenceAttachment') return 'reference';
  return 'file';
}

/** Metadata only — bytes are streamed from Graph when someone downloads. */
export async function syncAttachmentLists(mb: MailboxCtx, items: Array<{ graphId: string; messageId: string }>): Promise<void> {
  const admin = supabaseAdmin();
  const answers = await mb.graph.batch(
    items.map((i) => ({
      path: `${mb.root}/messages/${encodeURIComponent(i.graphId)}/attachments`,
      query: { $select: 'id,name,contentType,size,isInline' },
    })),
  );
  for (let i = 0; i < items.length; i += 1) {
    const err = batchItemError(answers[i]);
    if (err) {
      // Throttling stops the run; anything else just leaves this message's list for next time.
      if (err.classified.code === 'throttled') throw err;
      mailLog('warn', 'ingest', 'attachment_list_failed', { mailboxId: mb.id, code: err.classified.code });
      continue;
    }
    const list = ((answers[i].body as { value?: GraphAttachment[] } | undefined)?.value ?? []).filter((a) => a.id);
    if (list.length === 0) continue;
    const rows = list.map((a) => ({
      message_id: items[i].messageId,
      mailbox_id: mb.id,
      graph_id: a.id as string,
      name: (a.name || 'attachment').slice(0, 500),
      content_type: a.contentType?.slice(0, 200) ?? null,
      size_bytes: typeof a.size === 'number' ? a.size : null,
      is_inline: Boolean(a.isInline),
      kind: kindOf(a['@odata.type']),
    }));
    const { error } = await admin.from('mail_attachments').upsert(rows, { onConflict: 'message_id,graph_id' });
    if (error) throw new Error(`mail_attachments upsert failed: ${error.code ?? 'db'}`);
    const names = rows.filter((r) => !r.is_inline).map((r) => r.name).join(' ').slice(0, 2000);
    await admin.from('mail_messages').update({ attachment_names: names }).eq('id', items[i].messageId);
  }
}
