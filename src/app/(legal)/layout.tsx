/**
 * The public-facing pages: SMS terms, privacy policy, and the consent form.
 *
 * ── WHY THESE ARE PUBLIC WHEN THE REST OF THE CRM IS NOT ─────────────────
 * A carrier reviewer opens these URLs from outside, with no account and no
 * invitation, and if they cannot read them the campaign is rejected. Two of
 * the three grounds TapDash's registration failed on were exactly this: the
 * terms URL and the privacy policy could not be verified.
 *
 * They are also the only pages in this application meant for people who are
 * not staff — everything else is behind the invite-only gate, deliberately.
 * Keeping them in their own route group makes that boundary visible in the
 * directory structure rather than only in `proxy.ts`.
 *
 * Deliberately plain: no session lookup, no Supabase call, no client
 * JavaScript beyond the consent form's own. A legal page that cannot render
 * when the database is down is a legal page that is sometimes not published.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-[760px] items-center gap-2.5 px-6 py-4">
          <span
            aria-hidden
            className="grid size-8 place-items-center rounded-[9px] bg-accent text-[15px] font-bold text-accent-ink"
          >
            T
          </span>
          <span className="text-[17px] font-semibold tracking-tight text-ink-900">TapDash</span>
          <span className="ml-1 text-[13px] text-ink-400">Payments</span>
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-6 py-10">{children}</main>

      <footer className="mx-auto max-w-[760px] px-6 pb-12 pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-5 text-[12.5px] text-ink-400">
          <Link href="/sms-terms" className="hover:text-ink-700">
            SMS Terms
          </Link>
          <Link href="/privacy-policy" className="hover:text-ink-700">
            Privacy Policy
          </Link>
          <Link href="/sms-consent" className="hover:text-ink-700">
            Text message consent
          </Link>
          <span className="ml-auto">TapDash Payments</span>
        </div>
      </footer>
    </div>
  );
}
