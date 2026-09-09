/**
 * How much of the app actually honours a grant at each scope level.
 *
 * Deliberately NOT marked `server-only`, and deliberately not living in
 * `adminGrants.ts`: the grant matrix is a Client Component, and importing a
 * value (rather than a type) out of a `server-only` module drags the whole
 * service-role client into the browser bundle — a build error by design, per
 * `CLAUDE.md` § Secrets. This file holds no secrets and reaches no database, so
 * both halves can share one copy instead of the copy drifting.
 *
 * The content is a survey, not an opinion. Taken across the whole of `src/`
 * while building Phase 6b, because a matrix that renders a control with no
 * effect is the same class of lie as Phase 4's `status_field_id` or a Connect
 * button that connects nothing — and here the lie would be about security.
 * Re-check it whenever a render path starts or stops consulting a grant.
 */
import type { GrantScope } from './permissions';

export type Enforcement = 'enforced' | 'route-only' | 'unread';

export const ENFORCEMENT_NOTE: Record<GrantScope, { level: Enforcement; note: string }> = {
  /**
   * `[module]/page.tsx:61` — `hidden` redirects to `/dashboard`, `view` drops
   * every edit control (`:113`, `:133`).
   *
   * This entry carried a `route-only` caveat — "the sidebar is built from
   * `admin_only` alone, so a hidden module is still listed and following the
   * link bounces" — which was true when the survey was written and is not any
   * more: `(app)/layout.tsx` now filters the nav through `moduleGrant()` itself,
   * so a hidden module's label and slug never reach the browser at all. Re-read
   * per this file's own instruction, on a screen whose whole job is not to
   * overstate OR understate what a control does.
   */
  module: {
    level: 'enforced',
    note: 'Fully enforced. A hidden module is absent from the sidebar — its label and slug never reach the browser — and opening it directly redirects away; View removes every edit control.',
  },
  /**
   * Also re-read, and also changed. `tabGrant()` genuinely had no callers when
   * this was written; it does now. `[module]/page.tsx` resolves every tab's
   * grant and drops a Hidden one from the strip entirely (absent, never blank).
   * Since 2026-09-07 the grants are resolved BEFORE the drawer fetches, so a
   * hidden tab's contents are never read either — they used to be queried and
   * shipped in the page payload with only the button removed. `tabAccess.ts`
   * re-checks the grant on every write — which makes this the ONLY
   * permission over Cases, Files, Logins, Statements, Updates and Communication,
   * none of which are made of fields.
   */
  tab: {
    level: 'enforced',
    note: 'Fully enforced. A Hidden tab is dropped from the drawer, its contents are never queried, and writes into it are refused — it is the only lever over Cases, Files, Logins, Statements, Updates and Communication, which are not made of fields.',
  },
  /**
   * A scope only since migration 50. The client's §8 always asked for
   * "tab/subtab access"; `grant_scope` had no fourth value, so the subtab half
   * could not be built — the nineteen subtabs could only be restricted by
   * hiding their whole parent tab or by granting each field inside them one at
   * a time. Application → Private (EIN, account and routing numbers, owner
   * SSNs) is the case that made the gap worth closing.
   *
   * Resolved UNDER the tab, never around it: `capGrant(tab, subtab)` at
   * `[module]/page.tsx`, so a subtab cannot re-open what its tab closed.
   */
  subtab: {
    level: 'enforced',
    note: 'Fully enforced. A Hidden subtab is dropped from the strip and its fields are never queried; View makes every field inside it read-only. Capped by its tab, so it can restrict further but never re-open.',
  },
  /**
   * Fully enforced. One precise caveat, because `records.ts`'s own header
   * says it and this file used to say the opposite: the mechanism is
   * strip-AFTER-fetch, not a per-viewer SQL projection. A JSONB document
   * cannot have keys projected away per row without a dynamic expression, so
   * the whole `values` column is read and the hidden keys are removed
   * server-side before the row becomes a return value. The security outcome
   * `CLAUDE.md` §3 is protecting holds — the value never reaches the browser,
   * the RSC payload or dev tools — but "absent from the query" is not
   * literally true, and claiming it was made two files in this directory
   * contradict each other. A hidden field's key is stripped from
   * `records.values` before the row leaves the data layer (`records.ts:49,159,206`), dropped from dashboard columns and
   * the drawer field grid (`[module]/page.tsx:74,252`), removed from activity
   * history (`activity.ts:65`), and refused on write (`records.ts:272,315`,
   * `repeatGroups.ts:40`). Absent from the query, not blanked in the UI.
   */
  field: {
    level: 'enforced',
    note: 'Fully enforced. A hidden field never reaches the page — its key is stripped server-side before the row leaves the data layer, in dashboards, drawers, history and writes. Not blanked in the UI, and not readable in dev tools.',
  },
};
