'use server';

/**
 * Server actions for the global app chrome — the sidebar counts and the
 * Notifications module. Not scoped to any one module, unlike
 * `[module]/actions.ts`. Every input is parsed; every read is scoped to the
 * signed-in person by the RPCs themselves.
 */
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import {
  listNotifications,
  unreadCounts,
  openNotification, peekNotification,
  markNotifications,
  markAllRead,
  PHONE_KINDS,
  type NotificationView,
  type NotificationCursor,
  type UnreadCounts,
} from '@/lib/records/notifications';

const Filter = z.enum(['unread', 'read', 'all']);
const Cursor = z.object({ at: z.string().max(40), id: z.uuid() }).nullable();

export async function notificationsAction(input: { filter: 'unread' | 'read' | 'all'; cursor: NotificationCursor }): Promise<{ rows: NotificationView[]; next: NotificationCursor }> {
  const parsed = z.object({ filter: Filter, cursor: Cursor }).safeParse(input);
  const ctx = await authorize();
  if (!parsed.success) return listNotifications(ctx, 'all', null);
  return listNotifications(ctx, parsed.data.filter, parsed.data.cursor);
}

export async function unreadCountsAction(): Promise<UnreadCounts> {
  const ctx = await authorize();
  return unreadCounts(ctx);
}

/** Click-through: marks it read and opened, and says where to go. */
/**
 * `follow: true` is for links (the Notifications page): it returns where to
 * go and leaves the opening to the record page that lands there (`?n=`), so
 * the one-time previous value is shown exactly once, there. Without it, the
 * notification is opened in place — a field's dot, which shows the value
 * itself. A phone alert has no `?n=` landing and is opened either way.
 */
export async function openNotificationAction(input: { id: string; follow?: boolean }): Promise<{ href: string | null; notification: NotificationView | null }> {
  const parsed = z.object({ id: z.uuid(), follow: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { href: null, notification: null };
  const ctx = await authorize();
  if (parsed.data.follow) {
    const peeked = await peekNotification(ctx, parsed.data.id);
    if (peeked?.href?.includes('&n=')) return { href: peeked.href, notification: peeked };
  }
  const n = await openNotification(ctx, parsed.data.id);
  return { href: n?.href ?? null, notification: n };
}

export async function markNotificationsAction(input: { ids: string[]; read: boolean }): Promise<{ changed: number }> {
  const parsed = z.object({ ids: z.array(z.uuid()).min(1).max(200), read: z.boolean() }).safeParse(input);
  if (!parsed.success) return { changed: 0 };
  const ctx = await authorize();
  return { changed: await markNotifications(ctx, parsed.data.ids, parsed.data.read) };
}

export async function markAllReadAction(input: { scope: 'mentions' | 'phone' | 'all' } = { scope: 'all' }): Promise<{ changed: number }> {
  const parsed = z.object({ scope: z.enum(['mentions', 'phone', 'all']) }).safeParse(input);
  const ctx = await authorize();
  const scope = parsed.success ? parsed.data.scope : 'all';
  const kinds = scope === 'phone' ? PHONE_KINDS : scope === 'mentions' ? ['mention_update', 'mention_case_reply', 'mention_field'] : null;
  return { changed: await markAllRead(ctx, kinds) };
}
