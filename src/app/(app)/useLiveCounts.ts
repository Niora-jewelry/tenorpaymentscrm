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

    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel(`notifications:${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, () => {
        void refetch();
        window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
      })
      .subscribe();

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
      void supabase.removeChannel(channel);
    };
  }, [userId]);

  return counts;
}
