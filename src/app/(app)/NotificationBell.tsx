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
        className={`relative grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-150 ${
          open ? 'bg-canvas text-ink-900' : 'text-ink-400 hover:bg-canvas hover:text-ink-900'
        }`}
      >
        <Icon name="bell" size={16} />
        {unreadCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[16px] place-items-center rounded-full bg-brand-600 px-1 text-[9.5px] font-bold leading-[16px] text-white ring-2 ring-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          {/*
            A click-catcher behind the panel rather than only a `mousedown`
            listener on the document. The listener alone let a click land on
            whatever was underneath while it was closing — opening a record in
            the table behind the panel on the way past.
          */}
          <span
            aria-hidden
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />

          <div
            role="dialog"
            aria-label="Notifications"
            className="absolute left-0 top-full z-50 mt-2 w-[336px] origin-top-left animate-pop-in overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.06),0_20px_48px_-16px_rgba(8,32,47,.32)]"
          >
            <header className="flex items-center gap-2 border-b border-line-soft bg-canvas/50 px-3.5 py-2.5">
              <span className="text-[13px] font-semibold tracking-[-.01em] text-ink-900">
                Notifications
              </span>
              {unreadCount > 0 ? (
                <span className="rounded-full bg-brand-600 px-1.5 py-[1px] text-[10.5px] font-bold leading-[15px] text-white">
                  {unreadCount}
                </span>
              ) : null}
              {unreadCount > 0 ? (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="ml-auto rounded text-[11.5px] font-semibold text-brand-700 transition-colors hover:underline"
                >
                  Mark all read
                </button>
              ) : null}
            </header>

            <div className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain">
              {notifications.length === 0 ? (
                <div className="px-4 py-9 text-center">
                  <span className="mx-auto grid size-9 place-items-center rounded-full bg-canvas text-ink-300">
                    <Icon name="bell" size={16} />
                  </span>
                  <p className="mt-2.5 text-[13px] font-medium text-ink-700">You are all caught up</p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-400">
                    Mentions on updates show up here.
                  </p>
                </div>
              ) : (
                notifications.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => openNotification(n)}
                    className={`group/row flex w-full items-start gap-2.5 border-b border-line-faint px-3.5 py-3 text-left transition-colors last:border-0 hover:bg-canvas ${
                      n.readAt ? '' : 'bg-brand-50/50'
                    }`}
                  >
                    {/* Unread is carried by a dot AND a tinted row, not by bold
                        text: the body is a sentence, and bolding a whole
                        sentence reads as shouting rather than as new. */}
                    <span
                      aria-hidden
                      className={`mt-[5px] size-[7px] shrink-0 rounded-full ${
                        n.readAt ? 'bg-transparent ring-1 ring-inset ring-line' : 'bg-brand-600'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[12.5px] leading-[1.45] ${n.readAt ? 'text-ink-600' : 'text-ink-900'}`}>
                        {n.body}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-400">
                        <Icon name="clock" size={10} />
                        {relative(n.createdAt, now)}
                        {n.recordId ? (
                          <>
                            <span aria-hidden className="text-line">·</span>
                            <span className="font-medium text-brand-700 opacity-0 transition-opacity group-hover/row:opacity-100">
                              Open record
                            </span>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>

            {notifications.length ? (
              <footer className="border-t border-line-soft bg-canvas/50 px-3.5 py-2 text-[11px] text-ink-400">
                Showing the {notifications.length} most recent.
              </footer>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
