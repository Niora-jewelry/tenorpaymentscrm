/**
 * Is session recording switched on for this deployment?
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────
 * Three places need the answer and they live on different sides of the
 * client/server line: the provider that starts PostHog, the sign-in page that
 * tells staff they are being recorded, and the admin Integrations screen that
 * lists it as a provider. `lib/env.server.ts` is marked `server-only`, so the
 * sign-in page cannot import it; duplicating `Boolean(process.env…)` in three
 * files is how one of them ends up disagreeing with the other two.
 *
 * The disagreement that matters is not a broken screen — it is the sign-in
 * page telling people they are recorded when they are not, or saying nothing
 * while they are. A notice that is wrong in either direction is worse than no
 * notice, so there is exactly one definition.
 *
 * `NEXT_PUBLIC_` on purpose: the browser has to read the key to send anything
 * at all, so this is not a secret being leaked — it is a public ingestion key
 * doing its job. The secret PostHog keys are never referenced by this app.
 */
export const sessionRecordingConfigured = Boolean(process.env.NEXT_PUBLIC_POSTHOG_KEY);
