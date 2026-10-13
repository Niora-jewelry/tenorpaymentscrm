'use client';

/**
 * PostHog — session replay and product analytics.
 *
 * ── IT ONLY RUNS WHERE A KEY IS SET ──────────────────────────────────────
 * `NEXT_PUBLIC_POSTHOG_KEY` absent means `posthog.init` is never called, so
 * local development, CI and the test suite record nothing and send nothing.
 * That is the switch: setting the key in Vercel turns recording on, removing
 * it turns recording off, and neither needs a deploy of this file.
 *
 * ── RECORDING IS UNMASKED, DELIBERATELY AND BY INSTRUCTION ───────────────
 * `maskAllInputs: false` and `maskTextSelector` unset, so replays show real
 * values. That was asked for explicitly, to make a bug report answerable
 * without a screenshot.
 *
 * ⚠️ WHAT THAT MEANS, WRITTEN DOWN SO IT IS NEVER A SURPRISE.
 * These screens carry things the rest of this codebase goes to some length to
 * protect, and a replay copies all of them to PostHog's servers:
 *
 *   * SSN, EIN, bank account number and routing number — the four fields
 *     marked `sensitive`, masked on screen behind a Reveal;
 *   * processor-portal passwords on the Logins tab, which are envelope-
 *     encrypted at rest and whose every reveal is written to the audit log.
 *     A reveal during a recorded session puts a working credential into the
 *     replay in plain sight, where no audit row accounts for it;
 *   * every merchant's financials.
 *
 * None of that is a reason the feature cannot exist — it is the reason the
 * project's own rule is that credentials are "excluded from every export".
 * A replay is an export. Whoever can open the PostHog project can read all of
 * it, so that account list is now as sensitive as an admin login here, and
 * PostHog's own retention setting decides how long the copy lives.
 *
 * To close only the sharpest edge without losing anything else, give the
 * reveal control in `value.tsx` the class `ph-no-capture`: the password
 * becomes a block in replays and the rest of the screen is untouched.
 *
 * ── WHY `person_profiles: 'identified_only'` ─────────────────────────────
 * Every page behind this layout is authenticated, so an anonymous profile
 * here would be a signed-in person PostHog had not been told the name of —
 * a second, partial identity for the same human. Profiles are created on
 * `identify` below and nowhere else.
 */
import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import posthog from 'posthog-js';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

export function PostHogProvider({
  userId,
  email,
  isAdmin,
}: {
  userId: string;
  email: string;
  isAdmin: boolean;
}) {
  useEffect(() => {
    if (!KEY) return;

    if (!posthog.__loaded) {
      posthog.init(KEY, {
        api_host: HOST,
        person_profiles: 'identified_only',
        capture_pageview: false, // sent below, so Next's client routing counts
        session_recording: {
          maskAllInputs: false,
          maskTextSelector: undefined,
        },
      });
    }

    /*
     * Tie the recording to the person, so "Izzy hit an error" is findable
     * without guessing from a timestamp. The email is already the identifier
     * every other audit surface in this app uses.
     */
    posthog.identify(userId, { email, role: isAdmin ? 'admin' : 'member' });
  }, [userId, email, isAdmin]);

  return null;
}

/**
 * Page views, for an app that navigates on the client.
 *
 * `capture_pageview: false` above is not a way of sending fewer of them — it
 * is because Next moves between routes without a document load, so PostHog's
 * automatic capture would record the first URL and then nothing for the rest
 * of the session. Watching the pathname sends one per real navigation.
 *
 * Separated from the provider because `useSearchParams` opts a component into
 * client-side rendering for its whole subtree; keeping it in its own leaf
 * under `<Suspense>` means that cost lands here and nowhere else.
 */
export function PostHogPageviews() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!KEY || !posthog.__loaded) return;
    const qs = searchParams.toString();
    posthog.capture('$pageview', { $current_url: pathname + (qs ? `?${qs}` : '') });
  }, [pathname, searchParams]);

  return null;
}
