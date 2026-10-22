'use client';

/**
 * The sidebar's unread counts, kept live.
 *
 * Supabase Realtime streams `notifications` changes for this person (the
 * table's own SELECT policy decides what reaches a subscriber, so the filter
 * here is a courtesy, not the security). Every event is a signal to re-ask
 * the server for the counts — the row payload is never trusted as the truth
 * and never shown. A 60-second poll and a refetch on tab focus cover a
 * dropped socket; each browser tab subscribes on its own, which is what
 * keeps two tabs in step.
 *
 * Two window events let the rest of the page follow along without prop
 * drilling: `tapdash:notifications-count` (the numbers) and
 * `tapdash:notifications-changed` (something about my mentions moved — an
 * open drawer or the Notifications list refetches its own view).
 */
import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { unreadCountsAction } from './actions';
import type { UnreadCounts } from '@/lib/records/notifications';

const POLL_MS = 60_000;
export const COUNT_EVENT = 'tapdash:notifications-count';
export const CHANGED_EVENT = 'tapdash:notifications-changed';

/** Any client that changed a notification itself (marked read, opened) says so, and every listener refetches. */
export function announceNotificationsChanged(): void {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

export function useLiveCounts(userId: string, initial: UnreadCounts): UnreadCounts {
  const [counts, setCounts] = useState(initial);

  useEffect(() => {
    let live = true;
    let inFlight: Promise<void> | null = null;
    const refetch = () => {
      if (inFlight) return inFlight;
      inFlight = unreadCountsAction()
        .then((c) => {
          if (!live) return;
          setCounts(c);
          window.dispatchEvent(new CustomEvent(COUNT_EVENT, { detail: c }));
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    };

    /*
     * ── THE TOKEN GOES ON THE SOCKET BEFORE THE JOIN ───────────────────────
     * The browser client loads its session from cookies asynchronously.
     * Subscribing straight away sent the join as `anon`, which has no SELECT
     * on notifications, and Realtime answered "Unable to subscribe to changes
     * with given parameters" — silently, so the 60 s poll carried every count
     * and nothing looked broken. Measured 64 s in the browser against 200 ms
     * once the token is set first. Later refreshes are re-applied by the
     * client itself (TOKEN_REFRESHED → realtime.setAuth).
     */
    const supabase = createSupabaseBrowserClient();
    let channel: RealtimeChannel | null = null;
    void supabase.auth
      .getSession()
      .then(async ({ data }) => {
        const token = data.session?.access_token;
        if (token) await supabase.realtime.setAuth(token);
        if (!live) return;
        channel = supabase
          .channel(`notifications:${userId}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, () => {
            void refetch();
            window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
          })
          .subscribe((status) => {
            // Anything that may have happened while the socket was down.
            if (status === 'SUBSCRIBED') void refetch();
          });
      })
      .catch(() => undefined);

    const poll = setInterval(() => void refetch(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    const onChanged = () => void refetch();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(CHANGED_EVENT, onChanged);

    return () => {
      live = false;
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(CHANGED_EVENT, onChanged);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId]);

  return counts;
}
