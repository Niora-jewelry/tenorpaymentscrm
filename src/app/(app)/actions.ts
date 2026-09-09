'use server';

/**
 * Server actions for the global app chrome (the sidebar's notification
 * bell) — not scoped to any one module, unlike `[module]/actions.ts`.
 */
import { authorize } from '@/lib/records/permissions';
import {
  notificationsFor, unreadNotificationCount, markNotificationRead, markAllNotificationsRead,
  type NotificationRow,
} from '@/lib/records/notifications';

export async function getNotificationsAction(): Promise<{ notifications: NotificationRow[]; unreadCount: number }> {
  const ctx = await authorize();
  const [notifications, unreadCount] = await Promise.all([
    notificationsFor(ctx),
    unreadNotificationCount(ctx),
  ]);
  return { notifications, unreadCount };
}

export async function markNotificationReadAction(notificationId: string): Promise<void> {
  const ctx = await authorize();
  await markNotificationRead(ctx, notificationId);
}

export async function markAllNotificationsReadAction(): Promise<void> {
  const ctx = await authorize();
  await markAllNotificationsRead(ctx);
}
