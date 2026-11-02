'use client';

/**
 * Keeps an open list and drawer current without a refresh.
 *
 * `record_pings` holds one row per record, touched when something on it changes
 * that other people's screens must show. The row says nothing: it only tells the
 * page to ask the server again, and the server decides what this viewer gets.
 * RLS decides whose pings arrive.
 *
 * One refresh at a time. A drawer takes a moment to render, and starting another
 * cancels the one under way, so a run of changes could hold the old screen for as
 * long as they kept coming: a ping during a refresh waits for it to finish.
 */
import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { RealtimeChannel } from '@supabase/supabase-js';

const SETTLE_MS = 300;

export function useRecordPings(recordIds: string[], viewerId: string): void {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const ids = useRef(new Set(recordIds));
  const again = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    ids.current = new Set(recordIds);
  }, [recordIds]);

  useEffect(() => {
    busy.current = refreshing;
    if (!refreshing && again.current) {
      again.current = false;
      startRefresh(() => router.refresh());
    }
  }, [refreshing, router]);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const supabase = createSupabaseBrowserClient();
    let channel: RealtimeChannel | null = null;

    // The token goes on the socket before the join: see `useLiveCounts`.
    void supabase.auth
      .getSession()
      .then(async ({ data }) => {
        const token = data.session?.access_token;
        if (token) await supabase.realtime.setAuth(token);
        if (!live) return;
        channel = supabase
          .channel('record-pings')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'record_pings' }, (payload) => {
            const ping = payload.new as { record_id?: string; by_user?: string | null };
            const open = new URLSearchParams(window.location.search).get('record');
            if (!ping.record_id || ping.by_user === viewerId) return;
            if (!ids.current.has(ping.record_id) && ping.record_id !== open) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              if (busy.current) again.current = true;
              else startRefresh(() => router.refresh());
            }, SETTLE_MS);
          })
          .subscribe();
      })
      .catch(() => undefined);

    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [router, viewerId]);
}
