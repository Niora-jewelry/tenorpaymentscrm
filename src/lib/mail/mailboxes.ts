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

export const MAX_CONNECTIONS = 30;

export type ConnectionHealth = 'ok' | 'setting_up' | 'needs_reconnect' | 'needs_permission' | 'stalled' | 'throttled';

export type MyMailbox = {
  connectionId: string;
  mailboxId: string;
  address: string;
  displayName: string;
  kind: 'personal' | 'shared';
  health: ConnectionHealth;
  connectedAt: string;
  lastSyncedAt: string | null;
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

export function healthOf(r: Pick<Row, 'status'> & { mb: NonNullable<Row['mail_mailboxes']> }): ConnectionHealth {
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

  return (data ?? [])
    .filter((r): r is Row & { mail_mailboxes: NonNullable<Row['mail_mailboxes']> } => r.mail_mailboxes !== null)
    .map((r) => ({
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
