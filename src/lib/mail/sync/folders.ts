/**
 * Reads a mailbox's whole folder tree from Graph and stores it.
 *
 * Two Graph conversations, run together:
 *   * the well-known folders (Inbox, Sent Items …) by NAME, in one `$batch`,
 *     because their display names are localised and renameable — "Posteingang"
 *     is still the inbox;
 *   * every folder, flat, via `mailFolders/delta` (Graph's one call that
 *     returns nested folders without walking `childFolders` level by level).
 *
 * Then one database call writes the lot (`mail_apply_folder_tree`), so the
 * tree is never stored half-updated.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { graphForIdentity } from '../tokens';
import { batchItemError, GraphError, mailboxRoot, type GraphTransport } from '../graph/transport';
import { planFolderTree, WELL_KNOWN, type GraphFolder, type WellKnown } from './folderTree';

/** A tree deeper than 50 pages of 50 is not a mailbox anyone can use; stop there. */
const MAX_PAGES = 50;
const SELECT = 'id,displayName,parentFolderId,totalItemCount,unreadItemCount,childFolderCount';

export async function resolveWellKnownIds(graph: GraphTransport, root: string): Promise<Map<string, WellKnown>> {
  const items = await graph.batch(WELL_KNOWN.map((wk) => ({ path: `${root}/mailFolders/${wk}`, query: { $select: 'id' } })));
  const out = new Map<string, WellKnown>();
  items.forEach((item, i) => {
    const err = batchItemError(item);
    if (err) {
      // A mailbox with no Archive folder yet is normal; anything else is a real failure.
      if (err.classified.code === 'not_found') return;
      throw err;
    }
    const id = (item.body as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' && id) out.set(id, WELL_KNOWN[i]);
  });
  if (![...out.values()].includes('inbox')) {
    throw new GraphError(404, { code: 'mailbox_not_found', reaction: 'none', connection: 'broken', detail: 'no_inbox' }, null);
  }
  return out;
}

export async function enumerateFolders(
  graph: GraphTransport,
  root: string,
): Promise<{ folders: GraphFolder[]; complete: boolean }> {
  const folders: GraphFolder[] = [];
  let next: { path: string; query?: Record<string, string> } | null = {
    path: `${root}/mailFolders/delta`,
    query: { $select: SELECT },
  };
  for (let page = 0; next && page < MAX_PAGES; page += 1) {
    const res: { value?: GraphFolder[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } =
      (await graph.request({ ...next, headers: { Prefer: 'odata.maxpagesize=100' } })) ?? {};
    for (const f of res.value ?? []) folders.push(f);
    if (res['@odata.deltaLink']) return { folders, complete: true };
    next = res['@odata.nextLink'] ? { path: res['@odata.nextLink'] } : null;
  }
  return { folders, complete: false };
}

type MailboxRow = {
  id: string;
  address: string;
  graph_user_id: string | null;
  sync_identity_id: string | null;
  deleted_at: string | null;
};

/** The Graph root for a mailbox: its object id when known, else its address. */
export function rootFor(mb: { graph_user_id: string | null; address: string }): string {
  return mailboxRoot(mb.graph_user_id ?? mb.address);
}

/**
 * Refreshes one mailbox's folder tree. `graph` is passed by the connect flow
 * (it holds a fresh token already); the engine omits it and acts as the
 * mailbox's sync identity.
 */
export async function refreshFolderTree(mailboxId: string, graph?: GraphTransport): Promise<{ folders: number; complete: boolean }> {
  const admin = supabaseAdmin();
  const { data: mb, error } = await admin
    .from('mail_mailboxes')
    .select('id, address, graph_user_id, sync_identity_id, deleted_at')
    .eq('id', mailboxId)
    .maybeSingle<MailboxRow>();
  if (error) throw new GraphError(0, { code: 'provider_down', reaction: 'reschedule', detail: 'db' }, null);
  if (!mb || mb.deleted_at) return { folders: 0, complete: false };
  if (!graph) {
    if (!mb.sync_identity_id) {
      throw new GraphError(401, { code: 'reconnect_required', reaction: 'none', connection: 'broken', detail: 'no_driver' }, null);
    }
    graph = graphForIdentity(mb.sync_identity_id);
  }

  const root = rootFor(mb);
  const [wellKnown, listed] = await Promise.all([resolveWellKnownIds(graph, root), enumerateFolders(graph, root)]);
  const rows = planFolderTree(listed.folders, wellKnown);
  if (rows.length === 0) return { folders: 0, complete: false };

  const { error: applyErr } = await admin.rpc('mail_apply_folder_tree', {
    p_mailbox_id: mailboxId,
    p_folders: rows,
    p_complete: listed.complete,
  });
  if (applyErr) throw new Error(`mail_apply_folder_tree failed: ${applyErr.code ?? 'db'}`);
  return { folders: rows.length, complete: listed.complete };
}
