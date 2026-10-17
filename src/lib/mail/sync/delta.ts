/**
 * Per-folder reconciliation with Graph's message delta.
 *
 * Ported from the old CRM's `sync-core.ts`, fixing the two ways it lost
 * position or data:
 *
 *   1. The cursor is saved after EVERY page — the `nextLink` while a walk is
 *      in progress, the `deltaLink` once it completes. A run cut short by the
 *      page cap or the tick's time budget resumes exactly where it stopped.
 *      (The old engine dropped the cursor when it hit its cap and re-seeded
 *      from scratch on the next run.)
 *   2. `@removed` means "no longer in THIS folder", which is also what a move
 *      looks like. Each removed id is re-fetched: still exists → upserted into
 *      its new folder; 404 → tombstoned, and only while our row still says it
 *      is in this folder.
 *
 * A first walk is bounded to the last 14 days ("Load older mail" fetches
 * further back on request). An expired cursor (410 / SyncStateNotFound)
 * re-seeds the folder; re-ingesting is idempotent.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { batchItemError, GraphError } from '../graph/transport';
import { ingestMessages, type FolderInfo, type MailboxCtx } from './ingest';
import { MESSAGE_SELECT, type GraphMessage } from './messageMap';

export const SEED_DAYS = 14;
/** Pages of 50 per run; the cursor makes the rest a later run's job. */
export const MAX_PAGES_PER_RUN = 10;
const PREFER = 'odata.maxpagesize=50, outlook.body-content-type="html"';
const RESET_CODES = new Set(['SyncStateNotFound', 'SyncStateInvalid', 'ResyncRequired', 'InvalidSyncState']);

export type FolderState = FolderInfo & {
  delta_link: string | null;
  seeded_at: string | null;
  oldest_loaded_at: string | null;
};

export type DeltaOutcome = { changed: number; complete: boolean; reset: boolean };

type DeltaPage = { value?: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };

export function isCursorExpired(e: unknown): boolean {
  return e instanceof GraphError && (e.status === 410 || (e.graphCode !== null && RESET_CODES.has(e.graphCode)));
}

export async function runFolderDelta(mb: MailboxCtx, folder: FolderState, deadline: number, now = Date.now()): Promise<DeltaOutcome> {
  const admin = supabaseAdmin();
  const seeding = !folder.seeded_at;
  const cutoff = new Date(now - SEED_DAYS * 86_400_000).toISOString();

  let req: { path: string; query?: Record<string, string> } = folder.delta_link
    ? { path: folder.delta_link }
    : {
        path: `${mb.root}/mailFolders/${encodeURIComponent(folder.graph_id)}/messages/delta`,
        query: { $select: MESSAGE_SELECT, $filter: `receivedDateTime ge ${cutoff}` },
      };

  let changed = 0;
  for (let page = 0; page < MAX_PAGES_PER_RUN && Date.now() < deadline; page += 1) {
    let res: DeltaPage;
    try {
      res = (await mb.graph.request<DeltaPage>({ ...req, headers: { Prefer: PREFER } })) ?? {};
    } catch (e) {
      if (isCursorExpired(e)) {
        await admin.from('mail_folders').update({ delta_link: null, updated_at: new Date().toISOString() }).eq('id', folder.id);
        return { changed, complete: false, reset: true };
      }
      throw e;
    }

    const items = res.value ?? [];
    const removed = items.filter((m) => m['@removed']).map((m) => m.id).filter(Boolean);
    const live = items.filter((m) => !m['@removed']);
    if (live.length) changed += (await ingestMessages(mb, live, folder)).upserted;
    if (removed.length) changed += await refetchMessages(mb, removed, folder);

    const deltaLink = res['@odata.deltaLink'];
    const nextLink = res['@odata.nextLink'];
    const stamp = new Date().toISOString();
    if (deltaLink) {
      await admin
        .from('mail_folders')
        .update({
          delta_link: deltaLink,
          delta_synced_at: stamp,
          delta_error_count: 0,
          delta_last_error: null,
          ...(seeding ? { seeded_at: stamp } : {}),
          ...(seeding && !folder.oldest_loaded_at ? { oldest_loaded_at: cutoff } : {}),
          updated_at: stamp,
        })
        .eq('id', folder.id);
      return { changed, complete: true, reset: false };
    }
    if (!nextLink) {
      // Neither link: Graph ended the walk without a cursor. Start over next time.
      await admin.from('mail_folders').update({ delta_link: null, updated_at: stamp }).eq('id', folder.id);
      return { changed, complete: false, reset: true };
    }
    await admin.from('mail_folders').update({ delta_link: nextLink, updated_at: stamp }).eq('id', folder.id);
    req = { path: nextLink };
  }
  return { changed, complete: false, reset: false };
}

/**
 * Re-reads messages by id: the answer to `@removed` and to a change
 * notification. Exists → upserted where it now lives. 404 → tombstoned
 * (only from `removedFrom` when given). Returns rows changed.
 */
export async function refetchMessages(mb: MailboxCtx, graphIds: string[], removedFrom: FolderInfo | null): Promise<number> {
  const unique = [...new Set(graphIds)];
  if (unique.length === 0) return 0;
  const answers = await mb.graph.batch(
    unique.map((id) => ({
      path: `${mb.root}/messages/${encodeURIComponent(id)}`,
      query: { $select: MESSAGE_SELECT },
      headers: { Prefer: 'outlook.body-content-type="html"' },
    })),
  );
  const found: GraphMessage[] = [];
  const gone: string[] = [];
  answers.forEach((a, i) => {
    const err = batchItemError(a);
    if (!err) {
      if (a.body && typeof a.body === 'object') found.push(a.body as GraphMessage);
      return;
    }
    if (err.classified.code === 'not_found') gone.push(unique[i]);
    else if (err.classified.code === 'throttled' || err.classified.connection) throw err;
    // anything else: leave it for the next reconciliation
  });

  let changed = 0;
  if (found.length) changed += (await ingestMessages(mb, found, null)).upserted;
  if (gone.length) {
    const { data, error } = await supabaseAdmin().rpc('mail_soft_delete_messages', {
      p_mailbox_id: mb.id,
      p_graph_ids: gone,
      p_folder_id: removedFrom?.id ?? null,
    });
    if (error) throw new Error(`mail_soft_delete_messages failed: ${error.code ?? 'db'}`);
    changed += Number(data ?? 0);
  }
  return changed;
}

/** Graph's own unread/total counts for folders whose mail just changed. */
export async function refreshFolderCounts(mb: MailboxCtx, folders: FolderInfo[]): Promise<void> {
  if (folders.length === 0) return;
  const admin = supabaseAdmin();
  const answers = await mb.graph.batch(
    folders.map((f) => ({
      path: `${mb.root}/mailFolders/${encodeURIComponent(f.graph_id)}`,
      query: { $select: 'totalItemCount,unreadItemCount' },
    })),
  );
  for (let i = 0; i < folders.length; i += 1) {
    if (batchItemError(answers[i])) continue;
    const b = answers[i].body as { totalItemCount?: number; unreadItemCount?: number } | undefined;
    if (typeof b?.totalItemCount !== 'number') continue;
    await admin
      .from('mail_folders')
      .update({ total_count: b.totalItemCount, unread_count: b.unreadItemCount ?? 0, updated_at: new Date().toISOString() })
      .eq('id', folders[i].id);
  }
}
