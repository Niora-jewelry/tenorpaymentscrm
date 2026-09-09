/**
 * The one invalidator for `loadConfig()`'s cross-request cache.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE — the failure it prevents is completely
 * silent. `loadConfig()` (`config.ts`) is wrapped in `unstable_cache`, so a
 * config write that doesn't invalidate the tag returns success, leaves the
 * database perfectly correct, and never appears in a single module's
 * dashboard or drawer. Nothing errors. Nothing looks broken. Presets is about
 * to grow from 4 mutations to roughly 20 across sub-steps 2-5, and every one
 * of them has to do this; hand-rolling the pair 20 times is 20 chances to
 * forget. `adminConfig.test.ts` fails the build if any config-writing action
 * skips it.
 *
 * WHICH PRIMITIVE, AND WHY IT IS `updateTag` — sub-step 1 shipped this as
 * `revalidateTag(CONFIG_CACHE_TAG, 'max')` on the belief that `unstable_cache`
 * responds to `revalidateTag` but not `updateTag`. That was backwards, and it
 * produced this module's own nightmare scenario in Phase 1: moving a field
 * between tabs wrote correctly, showed correctly on the Presets screen, and
 * never changed a single module's drawer.
 *
 * Read Next 16's own source (`server/web/spec-extension/revalidate.js`):
 *   - `revalidateTag(tag, profile)` expires the tag according to that
 *     `cacheLife` PROFILE. `'max'` is the longest-lived profile there is, so
 *     passing it asks for the slowest possible expiry — the opposite of the
 *     intent. Next's own JSDoc says it outright: *"For immediate expiration in
 *     Server Actions, use `updateTag` instead."*
 *   - `updateTag(tag)` calls the same internal with NO profile, commented
 *     "immediate expiration". Same tag, same machinery — it is the correct
 *     primitive here, not a different cache system.
 *
 * `updateTag` THROWS outside a Server Action (route handlers must use
 * `revalidateTag`). Every caller of this function is a Server Action under
 * the admin routes, which is the only place config is ever written. A route
 * handler that needed this would need its own invalidator.
 */
import 'server-only';
import { revalidatePath, updateTag } from 'next/cache';
import { CONFIG_CACHE_TAG } from './config';
import { STATEMENT_PERIODS_TAG } from './statements';

/**
 * Call after ANY write to a `loadConfig()`-backed table — `tabs`, `subtabs`,
 * `module_tab_order`, `module_subtab_order`, `fields`, `module_columns`,
 * `module_header_fields`, `field_choices`, `pipelines`, `pipeline_steps`.
 *
 * Invalidates two things:
 *   1. the shared config cache, so every module's real dashboard and drawer
 *      pick the change up on their next render, in the same running server;
 *   2. EVERY route under the root layout — not just `/admin/presets`.
 *
 * Why (2) is `'/'` + `'layout'` and not the Presets path it used to be:
 * config is global. One field moving from Overview to Marketing changes the
 * drawer on `/leads`, `/deals`, `/contacts`, `/tickets` and `/records`
 * simultaneously; a column or header change does the same to their
 * dashboards. Scoping the revalidation to the screen the admin happened to
 * submit from left every one of those routes serving a stale render — and
 * the stale one is invisible from the admin's side, because the Presets
 * screen reads `fields` directly (`listFieldsForAdmin`, so archived rows are
 * visible) rather than through the cache. The admin therefore sees the change
 * land, and only a user on a module route sees it not have landed. That is
 * precisely the silent, admin-invisible failure this module exists to
 * prevent, so the invalidation has to be as wide as the data is.
 *
 * `revalidatePath('/', 'layout')` also clears the CLIENT Router Cache for
 * those routes, which the tag alone cannot do: a soft navigation from
 * `/admin/presets` to `/leads` can otherwise replay a cached RSC payload
 * without ever asking the server, so the fresh config never gets a chance to
 * render. A config write happens a handful of times a day, by one admin —
 * paying a full revalidation for it is not a cost worth optimising.
 */
export function revalidateConfig(): void {
  updateTag(CONFIG_CACHE_TAG);
  revalidatePath('/', 'layout');
}

/**
 * Call after extending the Statements month grid (Modules Amendment 4).
 *
 * A sibling of `revalidateConfig`, not a special case of it: `statement_periods`
 * is NOT a `loadConfig()` table, so widening that function to cover it would
 * make every config write also drop this cache and vice versa. Same shape and
 * the same reason — `allPeriods` is cached across requests and users, so
 * without this an admin adds 2033, the twelve rows land, and every drawer's
 * year selector keeps ending at 2032.
 *
 * `revalidatePath('/', 'layout')` for the same reason the config invalidator
 * uses it: the new year has to appear in the Statements tab of every module,
 * and the client Router Cache would otherwise replay a stale payload on a soft
 * navigation away from Presets.
 */
export function revalidateStatementPeriods(): void {
  updateTag(STATEMENT_PERIODS_TAG);
  revalidatePath('/', 'layout');
}
