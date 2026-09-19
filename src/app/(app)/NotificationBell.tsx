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
import { Icon, type IconName } from '@/proto/ui/icons';
import { relative } from '@/proto/ui/tokens';
import { getNotificationsAction, markNotificationReadAction, markAllNotificationsReadAction } from './actions';
import type { NotificationRow } from '@/lib/records/notifications';

const POLL_MS = 25_000;

/** Tells a call apart from a text apart from a mention at a glance, without
 *  reading the sentence. Falls back to the bell for anything unmapped. */
const KIND_ICON: Record<string, IconName> = {
  mention: 'quote',
  update: 'message-square',
  case: 'lifebuoy',
  call: 'phone',
  voicemail: 'mic',
  recording: 'mic',
  sms: 'message-square',
};

/** What the row offers to do, so the hover hint matches where it actually goes. */
const OPEN_LABEL: Record<string, string> = {
  call: 'Open call',
  voicemail: 'Play voicemail',
  recording: 'Play recording',
  sms: 'Open conversation',
  mention: 'Open update',
  update: 'Open update',
  case: 'Open case',
};

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

  /*
   * ── PAINT OPTIMISTICALLY, BUT ROLL BACK ON FAILURE ─────────────────────
   * These fired `void markNotificationReadAction(...)` — the badge cleared
   * locally and the rejection went nowhere. When the write actually failed (an
   * expired session is the common one) the notification stayed unread on the
   * server, reappeared on the next page load, and looked like the bell
   * randomly forgetting what you had read.
   *
   * Optimistic paint is still right — a read marker must not wait on a round
   * trip — so the fix is to keep the paint and undo it if the server refuses.
   * Same shape the dashboard's inline cell edit already uses: snapshot, paint,
   * restore on error.
   */
  const openNotification = (n: NotificationRow) => {
    setOpen(false);

    if (!n.readAt) {
      const previous = { notifications, unreadCount };
      setNotifications((list) => list.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));

      markNotificationReadAction(n.id).catch(() => {
        setNotifications(previous.notifications);
        setUnreadCount(previous.unreadCount);
      });
    }

    /*
     * `href` is resolved on the server against the modules this viewer can
     * actually open, and carries the tab and subtab the notification is about.
     * This used to be a hard-coded `/records?record=…` — the Records List is
     * admin-only, so a member clicking their own mention was pushed into a
     * module the gate immediately redirects them out of.
     */
    if (n.href) router.push(n.href);
  };

  const markAllRead = () => {
    const previous = { notifications, unreadCount };
    setNotifications((list) => list.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    setUnreadCount(0);

    markAllNotificationsReadAction().catch(() => {
      setNotifications(previous.notifications);
      setUnreadCount(previous.unreadCount);
    });
  };

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
        /* The trigger lives in the sidebar, which is now a navy gradient — the
           panel it opens is still on white, so only this button changes hue.
           `ink-400` on that ground is 1.9:1 and would read as a smudge. */
        className={`relative grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-150 ${
          open ? 'bg-white/20 text-white' : 'text-white/65 hover:bg-white/12 hover:text-white'
        }`}
      >
        <Icon name="bell" size={16} />
        {unreadCount > 0 ? (
          /* Lime on navy, the same pairing the active nav item uses, and the
             only thing in the header allowed to be brighter than the wordmark.
             The ring is the sidebar's own colour so the badge reads as sitting
             on the bell rather than floating over it. */
          <span className="absolute -right-0.5 -top-0.5 grid min-w-[16px] place-items-center rounded-full bg-accent px-1 text-[9.5px] font-bold leading-[16px] text-accent-ink ring-2 ring-brand-700">
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
            /*
             * ⚠️ `text-ink-900` ON THE PANEL ROOT IS LOAD-BEARING.
             *
             * This panel is a DOM child of the navigation rail, and the rail's
             * root sets `text-white`. Every row here names its own colour, so
             * that inheritance should never show — until one of those names is
             * a Tailwind class whose token does not exist, which emits no rule
             * at all. `text-ink-600` was exactly that: read notifications
             * inherited the rail's white and the list rendered as blank rows
             * with visible timestamps. The token exists now, and this line
             * means the next such gap costs a shade rather than the content.
             *
             * `max-w-[calc(100vw-2rem)]` for the same defensive reason: the
             * panel hangs off a 244px rail and is wider than it, so on a narrow
             * window it would otherwise run off the right edge.
             */
            className="absolute left-0 top-full z-50 mt-2 w-[352px] max-w-[calc(100vw-2rem)] origin-top-left animate-pop-in overflow-hidden rounded-xl border border-line bg-white text-ink-900 shadow-[0_1px_2px_rgba(8,32,47,.06),0_20px_48px_-16px_rgba(8,32,47,.32)]"
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
                        <Icon
                          name={KIND_ICON[n.sourceKind] ?? 'bell'}
                          size={11}
                          className="mr-1.5 inline-block align-[-1px] text-ink-400"
                        />
                        {n.body}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-400">
                        <Icon name="clock" size={10} />
                        {relative(n.createdAt, now)}
                        {/* Only promise a destination when there is one. A
                            record in no module this viewer can open has no
                            link, and saying "Open record" there would be a lie. */}
                        {n.href ? (
                          <>
                            <span aria-hidden className="text-line">·</span>
                            <span className="font-medium text-brand-700 opacity-0 transition-opacity group-hover/row:opacity-100">
                              {OPEN_LABEL[n.sourceKind] ?? 'Open record'}
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
