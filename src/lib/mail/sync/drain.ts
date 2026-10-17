/**
 * Works through one leased mailbox's queue until it is empty, the time
 * budget runs out, or Microsoft says stop.
 *
 * The queue is the engine's only to-do list: webhooks, the scheduler, the
 * connect flow and the UI all ENQUEUE (coalesced per mailbox/kind/target),
 * and only this loop talks to Graph on their behalf — so a burst of
 * notifications for one mailbox collapses into one delta walk.
 *
 * Failure handling, per item:
 *   throttled        → the whole mailbox waits out Retry-After; the item stays.
 *   sign-in dead     → stop; `tokens.ts` has already broken the identity and
 *                      handed the mailbox to another connector.
 *   access removed   → this connector's link to the mailbox is broken.
 *   folder gone      → refresh the tree; drop the item.
 *   anything else    → retry with backoff (1, 2, 4 … 30 min); after five
 *                      attempts the item is dropped and the error kept.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { graphForIdentity } from '../tokens';
import { GraphError } from '../graph/transport';
import { nextSyncDelayMinutes } from '../backoff';
import { mailLog } from '../log';
import { refreshFolderTree, rootFor } from './folders';
import { refetchMessages, refreshFolderCounts, runFolderDelta, type FolderState } from './delta';
import type { FolderInfo, MailboxCtx } from './ingest';

export type ClaimedMailbox = {
  id: string;
  address: string;
  graph_user_id: string | null;
  sync_identity_id: string;
  kind: 'personal' | 'shared';
  sync_status: string;
};

export type DrainResult = {
  items: number;
  changed: number;
  status: 'ok' | 'throttled' | 'failed';
  errorCode?: string;
};

type QueueItem = { id: number; kind: string; target: string; attempts: number };

const MAX_ATTEMPTS = 5;
const TAKE = 10;
/** Work a later phase owns; acknowledged so it does not block the queue. */
const LATER = new Set(['subscription_ensure', 'rules_refresh', 'contacts_delta', 'load_older', 'attachments_list']);

const FOLDER_COLUMNS = 'id, graph_id, well_known, delta_link, seeded_at, oldest_loaded_at';

async function loadFolders(mailboxId: string): Promise<FolderState[]> {
  const { data, error } = await supabaseAdmin()
    .from('mail_folders')
    .select(FOLDER_COLUMNS)
    .eq('mailbox_id', mailboxId)
    .is('deleted_at', null);
  if (error) throw new Error(`mail_folders read failed: ${error.code ?? 'db'}`);
  return (data ?? []) as FolderState[];
}

function contextFor(mb: ClaimedMailbox, folders: FolderState[], ctx?: MailboxCtx): MailboxCtx {
  const byGraph = new Map<string, FolderInfo>();
  const byId = new Map<string, FolderInfo>();
  for (const f of folders) {
    const info = { id: f.id, graph_id: f.graph_id, well_known: f.well_known };
    byGraph.set(f.graph_id, info);
    byId.set(f.id, info);
  }
  return {
    id: mb.id,
    address: mb.address,
    root: rootFor(mb),
    graph: ctx?.graph ?? graphForIdentity(mb.sync_identity_id),
    foldersByGraphId: byGraph,
    foldersById: byId,
  };
}

export async function drainMailbox(mb: ClaimedMailbox, deadline: number, owner: string, trigger = 'tick'): Promise<DrainResult> {
  const admin = supabaseAdmin();
  const started = new Date().toISOString();
  const { data: run } = await admin
    .from('mail_sync_runs')
    .insert({ mailbox_id: mb.id, trigger, status: 'running', started_at: started })
    .select('id')
    .single();

  let folders = await loadFolders(mb.id);
  let ctx = contextFor(mb, folders);
  const touched = new Map<string, FolderInfo>();
  let items = 0;
  let changed = 0;
  let transient = 0;
  let result: DrainResult = { items: 0, changed: 0, status: 'ok' };

  const finish = (id: number, extra: Record<string, unknown> = {}) =>
    admin.from('mail_sync_queue').update({ processed_at: new Date().toISOString(), ...extra }).eq('id', id);

  outer: while (Date.now() < deadline) {
    const { data: due, error } = await admin
      .from('mail_sync_queue')
      .select('id, kind, target, attempts')
      .eq('mailbox_id', mb.id)
      .is('processed_at', null)
      .lte('not_before', new Date().toISOString())
      .order('priority', { ascending: true })
      .order('not_before', { ascending: true })
      .limit(TAKE);
    if (error) throw new Error(`mail_sync_queue read failed: ${error.code ?? 'db'}`);
    if (!due?.length) break;

    for (const item of due as QueueItem[]) {
      if (Date.now() >= deadline) break outer;
      items += 1;
      try {
        if (item.kind === 'folders_refresh') {
          await refreshFolderTree(mb.id, ctx.graph);
          await admin.rpc('mail_enqueue_bootstrap', { p_mailbox_id: mb.id });
          folders = await loadFolders(mb.id);
          ctx = contextFor(mb, folders, ctx);
          await finish(item.id);
        } else if (item.kind === 'seed_folder' || item.kind === 'folder_delta') {
          const folder = folders.find((f) => f.id === item.target);
          if (!folder) {
            await finish(item.id, { last_error: 'folder_gone' });
            continue;
          }
          // Re-read: an earlier item in this run may have moved its cursor.
          const { data: fresh } = await admin.from('mail_folders').select(FOLDER_COLUMNS).eq('id', folder.id).maybeSingle();
          const out = await runFolderDelta(ctx, (fresh as FolderState | null) ?? folder, deadline);
          if (out.changed > 0) touched.set(folder.id, folder);
          changed += out.changed;
          await finish(item.id);
          if (!out.complete) {
            // Mid-walk (cursor saved) or reset: carry on at once, same urgency.
            await admin.rpc('mail_enqueue', {
              p_mailbox_id: mb.id,
              p_kind: out.reset ? 'seed_folder' : item.kind,
              p_target: item.target,
              p_priority: item.kind === 'seed_folder' || out.reset ? 2 : 3,
            });
          }
        } else if (item.kind === 'message_changed') {
          changed += await refetchMessages(ctx, [item.target], null);
          await finish(item.id);
        } else if (item.kind === 'message_deleted') {
          const { data } = await admin.rpc('mail_soft_delete_messages', {
            p_mailbox_id: mb.id,
            p_graph_ids: [item.target],
            p_folder_id: null,
          });
          changed += Number(data ?? 0);
          await finish(item.id);
        } else if (LATER.has(item.kind)) {
          await finish(item.id, { last_error: 'deferred' });
        } else {
          await finish(item.id, { last_error: 'unknown_kind' });
        }
      } catch (e) {
        const c = e instanceof GraphError ? e.classified : null;
        const code = c?.code ?? 'internal';

        if (code === 'throttled') {
          const until = new Date(Date.now() + (c?.retryAfterSeconds ?? 30) * 1000).toISOString();
          await admin.from('mail_mailboxes').update({ throttled_until: until, sync_status: 'throttled' }).eq('id', mb.id);
          await admin.from('mail_sync_queue').update({ not_before: until }).eq('id', item.id);
          result = { items, changed, status: 'throttled', errorCode: code };
          break outer;
        }
        if (code === 'reconnect_required' || code === 'consent_required' || code === 'app_secret_invalid') {
          result = { items, changed, status: 'failed', errorCode: code };
          break outer;
        }
        if (code === 'mailbox_access_removed' || code === 'mailbox_not_found') {
          const stamp = new Date().toISOString();
          await admin
            .from('mail_connections')
            .update({ status: 'broken', status_changed_at: stamp, last_error_code: code, last_error_at: stamp })
            .eq('mailbox_id', mb.id)
            .eq('identity_id', mb.sync_identity_id)
            .is('disconnected_at', null);
          await admin
            .from('mail_mailboxes')
            .update({ sync_status: 'broken', last_error_code: code, last_error_at: stamp })
            .eq('id', mb.id);
          result = { items, changed, status: 'failed', errorCode: code };
          break outer;
        }
        if (code === 'not_found' && (item.kind === 'seed_folder' || item.kind === 'folder_delta')) {
          await finish(item.id, { last_error: 'folder_gone' });
          await admin.rpc('mail_enqueue', { p_mailbox_id: mb.id, p_kind: 'folders_refresh', p_target: '', p_priority: 2 });
          continue;
        }

        const attempts = item.attempts + 1;
        const detail = (e instanceof Error ? `${code}: ${e.message}` : code).slice(0, 500);
        if (attempts >= MAX_ATTEMPTS) {
          await finish(item.id, { attempts, last_error: detail });
          if (item.kind === 'seed_folder' || item.kind === 'folder_delta') {
            const f = folders.find((x) => x.id === item.target);
            if (f) {
              const { data: cur } = await admin.from('mail_folders').select('delta_error_count').eq('id', f.id).maybeSingle();
              await admin
                .from('mail_folders')
                .update({ delta_error_count: Number(cur?.delta_error_count ?? 0) + 1, delta_last_error: detail })
                .eq('id', f.id);
            }
          }
        } else {
          const wait = nextSyncDelayMinutes(attempts) * 60_000;
          await admin
            .from('mail_sync_queue')
            .update({ attempts, last_error: detail, not_before: new Date(Date.now() + wait).toISOString() })
            .eq('id', item.id);
        }
        mailLog('warn', 'drain', 'item_failed', { mailboxId: mb.id, kind: item.kind, code, attempts });
        transient += 1;
        if (code === 'provider_down' && transient >= 3) {
          result = { items, changed, status: 'failed', errorCode: code };
          break outer;
        }
      }
    }
  }

  if (result.status === 'ok') result = { items, changed, status: 'ok' };
  result.items = items;
  result.changed = changed;

  try {
    if (touched.size && result.status === 'ok') await refreshFolderCounts(ctx, [...touched.values()]);
  } catch (e) {
    mailLog('warn', 'drain', 'folder_counts_failed', { mailboxId: mb.id, code: e instanceof GraphError ? e.classified.code : 'internal' });
  }
  if (changed > 0) await admin.rpc('mail_bump_seq', { p_mailbox_id: mb.id });
  await settleMailbox(mb, owner, result);

  if (run?.id) {
    await admin
      .from('mail_sync_runs')
      .update({
        status: result.status,
        items: result.items,
        error_code: result.errorCode ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id);
  }
  return result;
}

/** Mailbox status after a run, and the lease handed back. */
async function settleMailbox(mb: ClaimedMailbox, owner: string, r: DrainResult): Promise<void> {
  const admin = supabaseAdmin();
  const stamp = new Date().toISOString();
  const { data: cur } = await admin
    .from('mail_mailboxes')
    .select('sync_status, consecutive_failures, seeded_at')
    .eq('id', mb.id)
    .maybeSingle();
  const patch: Record<string, unknown> = { last_sync_at: stamp, updated_at: stamp };

  if (r.status === 'ok') {
    patch.last_graph_ok_at = stamp;
    patch.consecutive_failures = 0;
    patch.throttled_until = null;
    patch.last_error_code = null;
    patch.last_error = null;
    // "Setting up" ends once every hot folder has its first full pass.
    let seededAt = cur?.seeded_at ?? null;
    if (!seededAt) {
      const { count } = await admin
        .from('mail_folders')
        .select('id', { count: 'exact', head: true })
        .eq('mailbox_id', mb.id)
        .eq('tier', 'hot')
        .is('deleted_at', null)
        .is('seeded_at', null);
      if ((count ?? 1) === 0) seededAt = stamp;
    }
    patch.seeded_at = seededAt;
    if (cur && !['broken', 'stalled', 'paused'].includes(cur.sync_status)) patch.sync_status = seededAt ? 'ok' : 'pending';
  } else if (r.status === 'failed' && r.errorCode === 'provider_down') {
    const n = Number(cur?.consecutive_failures ?? 0) + 1;
    patch.consecutive_failures = n;
    patch.last_error_code = r.errorCode;
    patch.last_error_at = stamp;
    if (n >= 3 && cur && !['broken', 'stalled', 'paused'].includes(cur.sync_status)) patch.sync_status = 'degraded';
  }

  await admin.from('mail_mailboxes').update(patch).eq('id', mb.id);
  await admin.from('mail_mailboxes').update({ lease_until: null, lease_owner: null }).eq('id', mb.id).eq('lease_owner', owner);
}
