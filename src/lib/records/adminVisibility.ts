/**
 * Record visibility grants — "an admin can grant User A access to User B's
 * records", one-directional.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────
 * Two completely different things in this build are called a "grant", and
 * conflating them is the mistake this header exists to prevent:
 *
 *   - `template_grants` / `user_grants` (`adminGrants.ts`) answer *what may I
 *     see of a record I can already see* — Hidden/View/Edit, per module, tab and
 *     field. Resolved in the app layer by `effective_grant()`.
 *   - `record_visibility_grants` — this file — answers *which records exist for
 *     me at all*. It is read by `can_see_record()` (migration 1), which is
 *     called by the RLS policy on every content table, on every row of every
 *     query. There is no app-layer step to forget and no way to opt out of it.
 *
 * So the enforcement story here is the strongest in the codebase: the grant is
 * not consulted by any render path, it is part of the row-level predicate
 * itself. A record the viewer has no path to is not filtered out of a response —
 * it is not in the result set.
 *
 * ── THE ONE-WAY DIRECTION IS THE FEATURE ─────────────────────────────────
 * `(owner_id, viewer_id)` is unique and `owner_id <> viewer_id` is a check
 * constraint (migration 7). Granting A sight of B's records says nothing about
 * whether B can see A's; that needs its own row. Both directions are shown on
 * the screen for exactly that reason — "who can see this person's records" and
 * "whose records can this person see" are different questions with different
 * answers, and a screen showing only one of them invites the assumption that it
 * is symmetric.
 *
 * ── WHY "OWNER" MEANS TEAM MEMBER, NOT CREATOR ───────────────────────────
 * `can_see_record()` joins the grant to `record_team_members`, not to
 * `records.creator_user_id`. That is deliberate and predates this file: "Record
 * creator grants nothing" (migration 6, the client's own words). So a grant
 * follows the owner's TEAM MEMBERSHIPS and moves with them — take the owner off
 * a record and the viewer loses it too, on the next query, with no bookkeeping.
 *
 * ── NOT CACHED, LIKE EVERY OTHER PERMISSION ──────────────────────────────
 * No `revalidateConfig()`, ever — same rule as `adminGrants.ts` and
 * `adminUsers.ts`, pinned by the same test in `adminConfig.test.ts`. These rows
 * are read by Postgres inside an RLS predicate, so a cache in front of the
 * app-layer read would not even be the thing that matters; what matters is that
 * nobody adds one out of reflex.
 *
 * `supabaseAdmin()` throughout, with an explicit `assertAdmin` on every export:
 * `record_visibility_grants` has exactly one RLS policy, `for all to
 * authenticated using (auth_is_admin())`, so this is an admin surface at both
 * layers rather than one delegating to the other.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from './permissions';
import { assertAdminPage } from './adminConfig';
import type { RecordVisibilityGrantInput, RevokeVisibilityGrantInput } from './adminSchemas';

/** One row, with both people resolved. `grantedBy` is nullable because
 * `granted_by` is `on delete set null` — the grant outlives the admin who made
 * it, and saying "someone who has since left" is more honest than dropping the
 * row or inventing a name. */
export type VisibilityGrant = {
  id: string;
  ownerId: string;
  ownerName: string;
  viewerId: string;
  viewerName: string;
  grantedByName: string | null;
  createdAt: string;
};

/** Both directions for one person, which are different questions. */
export type VisibilityGrants = {
  /** Grants where this person is the VIEWER — whose records they can see. */
  sees: VisibilityGrant[];
  /** Grants where this person is the OWNER — who can see their records. */
  seenBy: VisibilityGrant[];
};

export type VisibilityResult = { ok: true } | { ok: false; message: string };

/** A person, for both the tables and the "grant access to…" picker. */
export type VisibilityPerson = { id: string; name: string; email: string; suspended: boolean };

type ProfileRow = {
  id: string;
  email: string;
  full_name: string | null;
  status: 'active' | 'suspended';
};

/**
 * Every account that can be either side of a grant.
 *
 * Reads `profiles` directly rather than through `team_directory()`, unlike
 * `directory.ts`: this is an admin screen holding an admin client, so the
 * definer function's minimal-exposure return shape would be withholding columns
 * from someone who can read the whole table anyway. `listUsers` in
 * `adminUsers.ts` reads it the same way for the same reason.
 */
export async function listVisibilityPeople(ctx: AuthContext): Promise<VisibilityPerson[]> {
  await assertAdminPage(ctx, 'permissions');
  const { data, error } = await supabaseAdmin()
    .from('profiles')
    .select('id, email, full_name, status')
    .is('deleted_at', null)
    .order('full_name', { nullsFirst: false });
  if (error) throw error;
  return ((data ?? []) as ProfileRow[]).map((p) => ({
    id: p.id,
    name: p.full_name?.trim() || p.email,
    email: p.email,
    suspended: p.status === 'suspended',
  }));
}

type GrantRow = {
  id: string;
  owner_id: string;
  viewer_id: string;
  granted_by: string | null;
  created_at: string;
};

function mapGrants(rows: GrantRow[], nameById: Map<string, string>): VisibilityGrant[] {
  return rows.map((r) => ({
    id: r.id,
    ownerId: r.owner_id,
    ownerName: nameById.get(r.owner_id) ?? 'Deleted account',
    viewerId: r.viewer_id,
    viewerName: nameById.get(r.viewer_id) ?? 'Deleted account',
    grantedByName: r.granted_by ? (nameById.get(r.granted_by) ?? 'Deleted account') : null,
    createdAt: r.created_at,
  }));
}

/** Both directions for one person, in one round trip each way. */
export async function listVisibilityGrants(ctx: AuthContext, userId: string): Promise<VisibilityGrants> {
  await assertAdminPage(ctx, 'permissions');
  const supabase = supabaseAdmin();

  const [seesRes, seenByRes, people] = await Promise.all([
    supabase.from('record_visibility_grants').select('*').eq('viewer_id', userId).order('created_at'),
    supabase.from('record_visibility_grants').select('*').eq('owner_id', userId).order('created_at'),
    listVisibilityPeople(ctx),
  ]);
  if (seesRes.error) throw seesRes.error;
  if (seenByRes.error) throw seenByRes.error;

  const nameById = new Map(people.map((p) => [p.id, p.name]));
  return {
    sees: mapGrants((seesRes.data ?? []) as GrantRow[], nameById),
    seenBy: mapGrants((seenByRes.data ?? []) as GrantRow[], nameById),
  };
}

/** Every grant in the system — the "who can see whose records" overview, which
 * is the only place the shape of the whole arrangement is visible at once. */
export async function listAllVisibilityGrants(ctx: AuthContext): Promise<VisibilityGrant[]> {
  await assertAdminPage(ctx, 'permissions');
  const [grantsRes, people] = await Promise.all([
    supabaseAdmin().from('record_visibility_grants').select('*').order('created_at', { ascending: false }),
    listVisibilityPeople(ctx),
  ]);
  if (grantsRes.error) throw grantsRes.error;
  const nameById = new Map(people.map((p) => [p.id, p.name]));
  return mapGrants((grantsRes.data ?? []) as GrantRow[], nameById);
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Grant `viewer` sight of every record `owner` is a team member of.
 *
 * Every refusal below is the DATABASE's — the unique index, the
 * `visibility_grant_not_self` check, the two foreign keys — turned into a
 * sentence. None of them is re-implemented here, on purpose: a copy of a
 * constraint in application code is a second thing to keep in step, and this one
 * would only ever be checking what a stale screen believed. `CLAUDE.md`'s
 * database section is explicit that rules which must never break belong in the
 * database as well as the code; this is the "as well as" half being a message,
 * not a second gate.
 */
export async function grantRecordVisibility(
  ctx: AuthContext,
  input: RecordVisibilityGrantInput,
): Promise<VisibilityResult> {
  await assertAdminPage(ctx, 'permissions');

  const { error } = await supabaseAdmin().from('record_visibility_grants').insert({
    owner_id: input.ownerId,
    viewer_id: input.viewerId,
    granted_by: ctx.userId,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { ok: false, message: 'That access has already been granted.' };
    if (error.code === CHECK_VIOLATION) {
      return { ok: false, message: 'Somebody can already see their own records — a grant to yourself does nothing.' };
    }
    if (error.code === FOREIGN_KEY_VIOLATION) {
      return { ok: false, message: 'One of those accounts no longer exists — reload the page.' };
    }
    return { ok: false, message: error.message };
  }
  return { ok: true };
}

/**
 * Take it away. Effective on the viewer's very next query — `can_see_record()`
 * is evaluated per statement, so there is nothing to propagate and no session to
 * invalidate.
 *
 * A delete matching nothing is not an error, here or in Postgres: the access is
 * already gone, which is the state the caller asked for.
 */
export async function revokeRecordVisibility(
  ctx: AuthContext,
  input: RevokeVisibilityGrantInput,
): Promise<VisibilityResult> {
  await assertAdminPage(ctx, 'permissions');
  const { error } = await supabaseAdmin().from('record_visibility_grants').delete().eq('id', input.grantId);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
