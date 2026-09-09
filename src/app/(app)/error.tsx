'use client';

/**
 * The error boundary for every signed-in page.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 * There was no `error.tsx` anywhere in this app. Without one, ANY throw during
 * a server render — a dropped connection to a remote database, a Supabase
 * timeout, a `.single()` that matched no rows — unmounts the whole tree and
 * Next.js replaces the entire screen with its own bare "A server error
 * occurred. Reload to try again." That page has no navigation, no sidebar, no
 * indication of what failed, and no way back except the browser's Back button.
 * A single slow query taking one drawer down took the entire application with
 * it.
 *
 * A boundary here keeps the failure inside the page area, keeps the app shell
 * and its navigation on screen, and offers `reset()` — which re-runs the failed
 * server render in place, without a full page reload and without losing the
 * user's position in the list behind an open drawer.
 *
 * ── WHAT IS DELIBERATELY NOT SHOWN ────────────────────────────────────────
 * Not `error.message`. In production Next.js already redacts server-side
 * messages to a generic string plus a digest, but this boundary also catches
 * client-side render errors, whose messages are NOT redacted and can carry
 * query fragments, ids, or field values. The digest is shown instead: it is the
 * stable, non-sensitive handle that correlates this screen with the real stack
 * in the server log, which is where the detail belongs.
 *
 * ── AUTH ERRORS DO NOT BELONG HERE ────────────────────────────────────────
 * `NotAuthenticatedError` from `authorize()` never reaches this: the proxy
 * redirects an unauthenticated request to /login before the page renders at
 * all. If one ever did surface here, "Try again" is still the right and only
 * affordance — the retry re-runs the render, and the redirect wins.
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the only place the client can record this. The
    // server-side original was already logged with its full stack by Next
    // before it was redacted; the digest below is what ties the two together.
    console.error('Page render failed:', error);
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-6 text-center shadow-[0_1px_2px_rgba(8,32,47,.04)]">
        <div className="mx-auto grid size-10 place-items-center rounded-full bg-warn-bg text-warn">
          <Icon name="alert-triangle" size={18} />
        </div>

        <h2 className="mt-3 text-[15px] font-semibold text-ink-900">This page didn&rsquo;t load</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          Something went wrong while fetching this data. Nothing you were working on has been
          changed. Trying again usually works.
        </p>

        {error.digest ? (
          <p className="mt-3 font-mono text-[11px] text-ink-400">Reference: {error.digest}</p>
        ) : null}

        <div className="mt-5 flex items-center justify-center gap-2.5">
          <Button onClick={() => reset()}>Try again</Button>
          <Link
            href="/dashboard"
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-500 transition-colors hover:bg-canvas hover:text-ink-900"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
