/**
 * Notifications — the bell. `notifications` (migration 11) is written
 * exclusively by `notify()` (a SECURITY DEFINER function with no client
 * grant at all — migration 22's "no grant to anyone" posture); this file is
 * the read/mark-read side, scoped to the signed-in user by RLS
 * (`recipient_id = auth.uid()`) and by the column-restricted `update
 * (read_at)` grant, so there is nothing here that could touch another
 * user's notifications even by mistake.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

export type NotificationRow = {
  id: string;
  body: string;
  recordId: string | null;
  sourceKind: string;
  createdAt: string;
  readAt: string | null;
};

function mapNotification(r: Record<string, unknown>): NotificationRow {
  return {
    id: r.id as string,
    body: r.body as string,
    recordId: (r.record_id as string | null) ?? null,
    sourceKind: r.source_kind as string,
    createdAt: r.created_at as string,
    readAt: (r.read_at as string | null) ?? null,
  };
}

const BELL_LIMIT = 20;

export async function notificationsFor(ctx: AuthContext): Promise<NotificationRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(BELL_LIMIT);
  if (error) throw error;
  return (data ?? []).map(mapNotification);
}

export async function unreadNotificationCount(ctx: AuthContext): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', ctx.userId)
    .is('read_at', null);
  if (error) throw error;
  return count ?? 0;
}

export async function markNotificationRead(ctx: AuthContext, notificationId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('recipient_id', ctx.userId);
  if (error) throw error;
}

export async function markAllNotificationsRead(ctx: AuthContext): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_id', ctx.userId)
    .is('read_at', null);
  if (error) throw error;
}
