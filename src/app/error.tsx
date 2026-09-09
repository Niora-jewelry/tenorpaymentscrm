'use client';

/**
 * The outermost error boundary below the root layout.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `(app)/error.tsx` ─────────────────────
 * A route's own `error.tsx` does NOT catch an error thrown by the layout it
 * sits beside — that layout is *above* the boundary, so its failure has to be
 * handled by a boundary further up. `(app)/layout.tsx` fetches the sidebar's
 * module list, the notification bell, the people directory and six record
 * counts, so it has real failure modes of its own, and every one of them would
 * otherwise land on Next's bare "A server error occurred" screen.
 *
 * This is deliberately self-contained: it must render even when the reason it
 * is rendering is that the app shell could not be built. No sidebar, no
 * `PeopleProvider`, no design-system components that might themselves depend on
 * data — just tokens from `globals.css`, which the root layout has already
 * loaded.
 *
 * `error.message` is not shown, for the reason given in `(app)/error.tsx`: in
 * production the server-side message is already redacted to a digest, and a
 * client-side one is not redacted at all. The digest is the safe handle that
 * ties this screen to the real stack in the server log.
 */
import { useEffect } from 'react';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Application shell failed:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-6 text-center">
        <h1 className="text-[15px] font-semibold text-ink-900">TapDash couldn&rsquo;t load</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          Something went wrong while loading the application. Your data has not been changed.
        </p>

        {error.digest ? (
          <p className="mt-3 font-mono text-[11px] text-ink-400">Reference: {error.digest}</p>
        ) : null}

        <div className="mt-5 flex items-center justify-center gap-2.5">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-700"
          >
            Try again
          </button>
          {/*
            A plain <a>, not next/link, deliberately — this boundary renders
            because the application shell could not be built, so the escape
            hatch has to be a FULL document request that discards the broken
            client tree. A client-side transition would reuse it and is quite
            likely to fail again in the same way.
          */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/login"
            className="rounded-lg px-3 py-1.5 text-[13px] text-ink-500 transition-colors hover:bg-canvas hover:text-ink-900"
          >
            Sign in again
          </a>
        </div>
      </div>
    </div>
  );
}
