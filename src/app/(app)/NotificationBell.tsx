'use client';

/**
 * The notification bell — MODULE-2-PLAN §9.1's "top bar bell, lime dot with
 * count." Polls rather than using Supabase Realtime: this app has no
 * realtime infra anywhere else, and a 25s interval is more than fast enough
 * for "someone mentioned you" to feel prompt in a B2B CRM. Every unread
 * notification came from `notify()`, which only ever fires from
 * `add_update_with_mentions()` today (an @mention) — the body text is
 * already a complete sentence, so this renders it as-is rather than trying
 * to re-derive a summary.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { relative } from '@/proto/ui/tokens';
import { getNotificationsAction, markNotificationReadAction, markAllNotificationsReadAction } from './actions';
import type { NotificationRow } from '@/lib/records/notifications';

const POLL_MS = 25_000;

export function NotificationBell({
  initialNotifications,
  initialUnreadCount,
}: {
  initialNotifications: NotificationRow[];
  initialUnreadCount: number;
}) {
  const router = useRouter();
  const [notifications, setNotifications] = useState(initialNotifications);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const [open, setOpen] = useState(false);
  const [now] = useState(() => new Date());
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const result = await getNotificationsAction();
        setNotifications(result.notifications);
        setUnreadCount(result.unreadCount);
      } catch {
        // A transient poll failure just tries again next tick — never
        // surfaces as an error state for a background refresh.
      }
    };
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const openNotification = (n: NotificationRow) => {
    setOpen(false);
    if (!n.readAt) {
      setNotifications((list) => list.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
      void markNotificationReadAction(n.id);
    }
    if (n.recordId) router.push(`/records?record=${n.recordId}`);
  };

  const markAllRead = () => {
    setNotifications((list) => list.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);
    void markAllNotificationsReadAction();
  };

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        className="relative grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors duration-150 hover:bg-canvas hover:text-ink-900"
      >
        <Icon name="bell" size={16} />
        {unreadCount > 0 ? (
          <span className="absolute right-1 top-1 grid min-w-[15px] place-items-center rounded-full bg-accent px-[3px] text-[9px] font-bold leading-[15px] text-accent-ink">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-80 overflow-hidden rounded-xl border border-line bg-white shadow-[0_16px_40px_-12px_rgba(8,32,47,.35)]">
          <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
            <span className="text-[12.5px] font-semibold text-ink-900">Notifications</span>
            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={markAllRead}
                className="ml-auto text-[11.5px] font-semibold text-brand-700 hover:underline"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-3 py-8 text-center text-[12.5px] text-ink-400">Nothing yet.</p>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openNotification(n)}
                  className={`flex w-full items-start gap-2 border-b border-line-soft px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-canvas ${
                    n.readAt ? '' : 'bg-brand-50/60'
                  }`}
                >
                  {!n.readAt ? <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" /> : <span className="mt-1.5 w-1.5 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] leading-snug text-ink-700">{n.body}</span>
                    <span className="mt-0.5 block text-[11px] text-ink-400">{relative(n.createdAt, now)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
