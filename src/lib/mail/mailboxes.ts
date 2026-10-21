/**
 * The signed-in person's own mailbox connections, read through RLS.
 *
 * Takes an `AuthContext` (CLAUDE.md rule 2) and uses the request-scoped
 * client, so `mail_connections_select` / `mail_mailboxes_select` decide what
 * comes back — this function only narrows to the person's own rows (an admin
 * can also read other people's connections to mailboxes they can see, which
 * is not what "my mailboxes" means).
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from '@/lib/records/permissions';
import type { Health } from './viewTypes';

export const MAX_CONNECTIONS = 30;

export type ConnectionHealth = Health;

export type MyMailbox = {
  connectionId: string;
  mailboxId: string;
  address: string;
  displayName: string;
  kind: 'personal' | 'shared';
  health: ConnectionHealth;
  connectedAt: string;
  lastSyncedAt: string | null;
  /** Folders found in Outlook, and how many have had their mail fetched. */
  folders: number;
  foldersReady: number;
  /** Messages Outlook reports across all folders (its own counts). */
  messages: number;
  inboxUnread: number;
  inboxId: string | null;
};

type Row = {
  id: string;
  mailbox_id: string;
  status: 'ok' | 'degraded' | 'broken' | 'paused_user' | 'disconnected';
  connected_at: string;
  mail_mailboxes: {
    address: string;
    display_name: string;
    kind: 'personal' | 'shared';
    sync_status: 'pending' | 'ok' | 'throttled' | 'degraded' | 'broken' | 'stalled' | 'paused';
    last_graph_ok_at: string | null;
    seeded_at: string | null;
  } | null;
};

export function healthOf(r: { status: string; mb: { sync_status: string; seeded_at: string | null } }): ConnectionHealth {
  if (r.status === 'broken') return 'needs_reconnect';
  if (r.status === 'degraded') return 'needs_permission';
  if (r.mb.sync_status === 'broken' || r.mb.sync_status === 'stalled') return 'stalled';
  if (r.mb.sync_status === 'throttled') return 'throttled';
  if (r.mb.sync_status === 'pending' || !r.mb.seeded_at) return 'setting_up';
  return 'ok';
}

export async function myMailboxes(ctx: AuthContext): Promise<MyMailbox[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('mail_connections')
    .select(
      'id, mailbox_id, status, connected_at, mail_mailboxes(address, display_name, kind, sync_status, last_graph_ok_at, seeded_at)',
    )
    .eq('user_id', ctx.userId)
    .is('disconnected_at', null)
    .order('connected_at', { ascending: true })
    .returns<Row[]>();
  if (error) throw new Error(`Could not load mailboxes: ${error.code ?? 'db'}`);

  const live = (data ?? []).filter((r): r is Row & { mail_mailboxes: NonNullable<Row['mail_mailboxes']> } => r.mail_mailboxes !== null);
  // Folder stats for the settings cards (RLS: only mailboxes this person sees).
  const { data: folders } = live.length
    ? await supabase
        .from('mail_folders')
        .select('id, mailbox_id, well_known, total_count, unread_count, seeded_at')
        .in('mailbox_id', live.map((r) => r.mailbox_id))
        .is('deleted_at', null)
    : { data: [] };
  type F = { id: string; mailbox_id: string; well_known: string | null; total_count: number; unread_count: number; seeded_at: string | null };
  const stats = new Map<string, { folders: number; foldersReady: number; messages: number; inboxUnread: number; inboxId: string | null }>();
  for (const f of (folders ?? []) as F[]) {
    if (f.well_known === 'outbox') continue;
    const st = stats.get(f.mailbox_id) ?? { folders: 0, foldersReady: 0, messages: 0, inboxUnread: 0, inboxId: null };
    st.folders += 1;
    if (f.seeded_at || (f.total_count ?? 0) === 0) st.foldersReady += 1;
    st.messages += f.total_count ?? 0;
    if (f.well_known === 'inbox') {
      st.inboxUnread = f.unread_count ?? 0;
      st.inboxId = f.id;
    }
    stats.set(f.mailbox_id, st);
  }

  return live
    .map((r) => ({
      ...(stats.get(r.mailbox_id) ?? { folders: 0, foldersReady: 0, messages: 0, inboxUnread: 0, inboxId: null }),
      connectionId: r.id,
      mailboxId: r.mailbox_id,
      address: r.mail_mailboxes.address,
      displayName: r.mail_mailboxes.display_name,
      kind: r.mail_mailboxes.kind,
      health: healthOf({ status: r.status, mb: r.mail_mailboxes }),
      connectedAt: r.connected_at,
      lastSyncedAt: r.mail_mailboxes.last_graph_ok_at,
    }));
}
