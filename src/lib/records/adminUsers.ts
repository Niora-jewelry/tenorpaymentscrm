/**
 * Admin → Users — the data layer for the one real gap identified against the
 * Admin Module Plan (§2.4): the permission-template schema (`permission_
 * templates`, `template_grants`, `user_templates`, `user_grants`) and the
 * pause mechanism (`profiles.status`/`sessions_valid_from`, already read and
 * enforced by `proxy.ts` on every request) are both fully real — only the
 * admin-facing list/invite/pause/assign-template write path was missing.
 *
 * `supabaseAdmin()` throughout, same as `listDeletedRecords` in `records.ts`:
 * this reads/writes across every user's own profile, which the request-
 * scoped (RLS'd) client can't do — every exported function here still opens
 * with an explicit `assertAdmin`, so the privilege boundary is enforced in
 * code, not delegated to RLS the way an ordinary per-user read is.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { invalidateGrants, type AuthContext } from './permissions';
import type { AssignTemplateInput, InviteUserInput } from './adminSchemas';

function assertAdmin(ctx: AuthContext): void {
  if (!ctx.isAdmin) throw new Error('Admin only');
}

export type AdminUserRow = {
  id: string;
  email: string;
  fullName: string | null;
  roleSlug: string;
  roleName: string;
  isAdmin: boolean;
  status: 'active' | 'suspended';
  lastLoginAt: string | null;
  /** Null when this user has no template assigned at all (falls back to the
   * global "unlisted defaults to edit" rule in `effective_grant()`). */
  templateLabel: string | null;
  /** How many `user_grants` rows this user has — combined with `templateLabel`,
   * this is the Admin Plan's three labels: "Custom" (no template, has
   * overrides), "Template: X (edited)" (template + overrides), "Template: X"
   * (template, no overrides).
   *
   * A count rather than the boolean it used to be, because Phase 6c made
   * assigning a template destructive in practice as well as in principle: the
   * confirmation has to say *how many* overrides it is about to delete, and a
   * boolean can only say "some". */
  overrideCount: number;
  /**
   * How many `record_visibility_grants` rows name this person, in EITHER
   * direction — records they were given sight of, plus people given sight of
   * theirs.
   *
   * One number for two directions, deliberately: this is a list column whose job
   * is to say "there is something configured here, go and look", and the screen
   * behind it is where the two directions are separated (they are different
   * questions and are never merged there). A zero here means the person is in no
   * grant at all, which is the only state this column has to be exact about.
   */
  visibilityGrantCount: number;
};

/** `isAdmin` is carried so callers can pick a role by what it GRANTS rather
 *  than by its name — the specification forbids auth logic naming a role, and
 *  a default chosen by slug breaks the moment that row is renamed. */
export type RoleOption = { id: string; slug: string; name: string; isAdmin: boolean };

export async function listUsers(ctx: AuthContext): Promise<AdminUserRow[]> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const [profilesRes, rolesRes, userTemplatesRes, templatesRes, grantsRes, visibilityRes] = await Promise.all([
    supabase.from('profiles').select('id, email, full_name, role_id, status, last_login_at').is('deleted_at', null).order('created_at'),
    supabase.from('roles').select('id, slug, name, is_admin'),
    supabase.from('user_templates').select('user_id, template_id'),
    supabase.from('permission_templates').select('id, label'),
    supabase.from('user_grants').select('user_id'),
    // Both id columns in one read, tallied per person below — the table is one
    // row per (owner, viewer) pair and is small by nature, so a second query
    // per direction would buy nothing.
    supabase.from('record_visibility_grants').select('owner_id, viewer_id'),
  ]);
  for (const r of [profilesRes, rolesRes, userTemplatesRes, templatesRes, grantsRes, visibilityRes]) if (r.error) throw r.error;

  const roleById = new Map((rolesRes.data ?? []).map((r) => [r.id, r]));
  const templateById = new Map((templatesRes.data ?? []).map((t) => [t.id, t]));
  const templateIdByUser = new Map((userTemplatesRes.data ?? []).map((ut) => [ut.user_id, ut.template_id as string | null]));

  const overridesByUser = new Map<string, number>();
  for (const g of grantsRes.data ?? []) {
    const id = g.user_id as string;
    overridesByUser.set(id, (overridesByUser.get(id) ?? 0) + 1);
  }

  const visibilityByUser = new Map<string, number>();
  for (const g of visibilityRes.data ?? []) {
    for (const id of [g.owner_id as string, g.viewer_id as string]) {
      visibilityByUser.set(id, (visibilityByUser.get(id) ?? 0) + 1);
    }
  }

  return (profilesRes.data ?? []).map((p) => {
    const role = roleById.get(p.role_id);
    const templateId = templateIdByUser.get(p.id) ?? null;
    const template = templateId ? templateById.get(templateId) : undefined;
    return {
      id: p.id,
      email: p.email,
      fullName: p.full_name,
      roleSlug: role?.slug ?? 'unknown',
      roleName: role?.name ?? 'Unknown role',
      isAdmin: role?.is_admin ?? false,
      status: p.status,
      lastLoginAt: p.last_login_at,
      templateLabel: template?.label ?? null,
      overrideCount: overridesByUser.get(p.id) ?? 0,
      visibilityGrantCount: visibilityByUser.get(p.id) ?? 0,
    };
  });
}

export async function listRoles(ctx: AuthContext): Promise<RoleOption[]> {
  assertAdmin(ctx);
  const { data, error } = await supabaseAdmin().from('roles').select('id, slug, name, is_admin').order('name');
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id, slug: r.slug, name: r.name, isAdmin: r.is_admin }));
}

/* `listTemplates` and `TemplateOption` moved to `adminTemplates.ts` in Phase
 * 6a — that module owns `permission_templates`, and this screen is now one of
 * two readers of the same list. Moved rather than duplicated, per
 * `remaining-plan.md` § Phase 6: two functions of that name over one table is
 * the kind of divergence this build has already been bitten by. */

/** Ports `scripts/invite.mjs`'s exact logic into a real, UI-callable path —
 * still an INVITE only, never an account or password (this project's own
 * standing invariant: "no default credential can ever be left behind"). The
 * invited person still completes the normal signup flow at `/signup`. */
export async function inviteUser(
  ctx: AuthContext,
  input: InviteUserInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();
  // Trimmed and lower-cased by the schema (Phase 6c) rather than here — the
  // address is the invite's unique key, so normalising it is a boundary
  // concern, and the partial unique index below depends on it.
  const normalizedEmail = input.email;

  const { data: existing, error: existingErr } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', normalizedEmail)
    .is('deleted_at', null)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing) return { ok: false, message: `${normalizedEmail} already has an account.` };

  // The partial unique index (`invites_one_pending_per_email`) allows only
  // one PENDING invite per address, so an existing one is superseded rather
  // than duplicated — same as the script.
  const { error: revokeErr } = await supabase
    .from('invites')
    .update({ status: 'revoked' })
    .eq('email', normalizedEmail)
    .eq('status', 'pending');
  if (revokeErr) throw revokeErr;

  const { error: insertErr } = await supabase
    .from('invites')
    .insert({ email: normalizedEmail, invited_by: ctx.userId, role_id: input.roleId, status: 'pending' });
  if (insertErr) return { ok: false, message: insertErr.message };

  return { ok: true };
}

/** Sets `status = 'suspended'` AND bumps `sessions_valid_from` — the second
 * part matters: `proxy.ts` rejects any access token issued before that
 * instant on every request, so this takes effect immediately, not just on
 * the paused user's next login attempt. Both columns and their enforcement
 * already existed (Phase 1); this is the first thing that ever sets them. */
export async function pauseUser(ctx: AuthContext, userId: string): Promise<void> {
  assertAdmin(ctx);
  if (userId === ctx.userId) throw new Error('You cannot pause your own account.');
  const { error } = await supabaseAdmin()
    .from('profiles')
    .update({ status: 'suspended', sessions_valid_from: new Date().toISOString() })
    .eq('id', userId);
  if (error) throw error;
}

export async function resumeUser(ctx: AuthContext, userId: string): Promise<void> {
  assertAdmin(ctx);
  const { error } = await supabaseAdmin().from('profiles').update({ status: 'active' }).eq('id', userId);
  if (error) throw error;
}

/**
 * Assigns a permission template to a user — and deletes every one of that
 * user's own overrides in the same breath.
 *
 * ── WHY THE CLEAR STAYS ──────────────────────────────────────────────────
 * It is load-bearing, and it predates Phase 6. "Template: X" *without*
 * "(edited)" has to mean the person has no personal overrides — that is the
 * whole distinction between two of the client's three labels
 * (`CLIENT-SPEC-BY-MODULE.md` §8) — and an override left over from a DIFFERENT
 * template's context would otherwise apply silently on top of the new one, on a
 * scope the admin was not even looking at. Dropping the clear would make the
 * badge lie; narrowing it to "only scopes the new template mentions" would leave
 * exactly the stale overrides it exists to remove.
 *
 * ── WHY IT NOW REFUSES INSTEAD ───────────────────────────────────────────
 * Until 6c, nothing in this build could create a `user_grants` row, so the
 * delete destroyed nothing and cost nothing. The moment the grant matrix could
 * write overrides it became a live data-loss path with no warning anywhere: an
 * admin sets a dozen per-user grants, later changes that user's template here,
 * and all twelve vanish while the badge simply flips back to "Template: X".
 * Nothing errors, nothing looks broken — the exact failure shape `CLAUDE.md` is
 * written against.
 *
 * So the destruction is not reachable without acknowledging it. The caller must
 * pass `confirmClearOverrides` when the user actually has overrides; the count
 * comes back in the refusal so the UI can say what it is about to delete rather
 * than guessing. `remaining-plan.md` § 6c asked for one of "confirm first, and
 * say how many" or "narrow the clear" — this is the first, because the second
 * breaks the label semantics above.
 *
 * `templateId` `''`/null clears the assignment entirely (back to the global
 * "unlisted defaults to Edit" rule).
 */
export async function assignTemplate(
  ctx: AuthContext,
  input: AssignTemplateInput,
): Promise<{ ok: true } | { ok: false; message: string; overrideCount?: number }> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();
  const templateId = input.templateId || null;

  // Counted server-side, never taken from the request: the number the UI
  // rendered may be minutes old, and it is the number in the DATABASE that is
  // about to be deleted.
  const { count, error: countErr } = await supabase
    .from('user_grants')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', input.userId);
  if (countErr) throw countErr;
  const overrideCount = count ?? 0;

  if (overrideCount > 0 && !input.confirmClearOverrides) {
    return {
      ok: false,
      overrideCount,
      message: `This person has ${overrideCount} personal permission override${
        overrideCount === 1 ? '' : 's'
      }. Assigning a template deletes ${overrideCount === 1 ? 'it' : 'them all'} — that is what keeps "Template: X" meaning "no personal changes". Confirm to continue.`,
    };
  }

  if (overrideCount > 0) {
    const { error: clearErr } = await supabase.from('user_grants').delete().eq('user_id', input.userId);
    if (clearErr) throw clearErr;
  }

  const { error } = await supabase.from('user_templates').upsert({ user_id: input.userId, template_id: templateId });
  if (error) throw error;
  // Both writes above change what `effective_grants()` returns for this user.
  // Drop the request-scoped grant cache so nothing re-rendered inside this
  // action's own response resolves permissions from before the change.
  invalidateGrants();
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Invites — Login spec §2, and Admin Plan §2.1's "Add users"                 */
/*                                                                            */
/* "the invite management UI arrives in Phase 3 (Admin Panel)". Sending one    */
/* existed; SEEING and CANCELLING them did not, so an invite that went to the  */
/* wrong address could not be taken back and pending invites were invisible.   */
/* -------------------------------------------------------------------------- */

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type AdminInviteRow = {
  id: string;
  email: string;
  roleName: string;
  status: InviteStatus;
  invitedByName: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  /** Past its expiry while still marked pending. `find_pending_invite` filters
   *  on the DATE, not the status, so such a row genuinely cannot be used to
   *  sign up — but it reads as live until `expire_stale_invites()` runs, and a
   *  screen that shows it as pending would be lying. */
  isStale: boolean;
};

/**
 * Every invite, newest first, with the stale ones marked.
 *
 * `supabaseAdmin()` because `invites` is admin-only and not readable by the
 * request-scoped client at all — the same reason `listDeletedUsers` uses it.
 */
export async function listInvites(ctx: AuthContext): Promise<AdminInviteRow[]> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const [invitesRes, rolesRes, profilesRes] = await Promise.all([
    supabase
      .from('invites')
      .select('id, email, role_id, status, invited_by, created_at, expires_at, accepted_at')
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('roles').select('id, name'),
    supabase.from('profiles').select('id, email, full_name'),
  ]);
  if (invitesRes.error) throw invitesRes.error;
  if (rolesRes.error) throw rolesRes.error;
  if (profilesRes.error) throw profilesRes.error;

  const roleById = new Map((rolesRes.data ?? []).map((r) => [r.id, r.name as string]));
  const personById = new Map(
    (profilesRes.data ?? []).map((p) => [p.id, (p.full_name as string | null) ?? (p.email as string)]),
  );
  const now = Date.now();

  return (invitesRes.data ?? []).map((i) => ({
    id: i.id,
    email: i.email,
    roleName: roleById.get(i.role_id) ?? 'Unknown role',
    status: i.status as InviteStatus,
    invitedByName: i.invited_by ? (personById.get(i.invited_by) ?? null) : null,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    acceptedAt: i.accepted_at,
    isStale: i.status === 'pending' && new Date(i.expires_at).getTime() <= now,
  }));
}

/**
 * Cancel a pending invite.
 *
 * Scoped to `status = 'pending'` in the WHERE clause, so an already-accepted
 * invite can never be flipped to revoked: that row is the audit record of how
 * a real account came to exist, and rewriting it would make the trail lie.
 * Revoking takes effect immediately — `find_pending_invite` only ever returns
 * pending rows, so the next signup attempt with that address is refused.
 */
export async function revokeInvite(
  ctx: AuthContext,
  inviteId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { data, error } = await supabase
    .from('invites')
    .update({ status: 'revoked' })
    .eq('id', inviteId)
    .eq('status', 'pending')
    .select('id');
  if (error) return { ok: false, message: error.message };
  if (!data?.length) {
    return { ok: false, message: 'That invite is no longer pending, so there is nothing to cancel.' };
  }
  return { ok: true };
}

/**
 * Give an invite another 7 days, and put it back in play.
 *
 * The client's model has no "resend" of the invite EMAIL — there is no invite
 * email in this build at all. Signup is the person going to /signup and asking
 * for a code, and the invite is only the permission for that to work. So the
 * useful action on a stale invite is more time, which is what an admin actually
 * wants when someone says "my invite expired".
 *
 * ⚠️ IT MUST ACCEPT AN ALREADY-EXPIRED INVITE, AND SET THE STATUS BACK.
 * This first matched `status = 'pending'` only, which made the whole control
 * unreachable: `sweepExpiredInvites()` runs when the Users screen loads and
 * flips every past-due pending row to 'expired', so by the time an admin could
 * see a Renew button the row it applied to no longer qualified. Renewing is
 * precisely the expired case, so 'expired' is the status this exists for.
 *
 * 'accepted' and 'revoked' are deliberately NOT renewable. An accepted invite is
 * the audit record of how a real account came to exist, and a revoked one was
 * cancelled on purpose — reviving either silently would undo a decision
 * somebody made. Inviting the address again is the way back, and it creates a
 * new row that says so.
 *
 * 7 days from NOW rather than from the original date, matching the column's own
 * default, so a renewed invite behaves exactly like one created today.
 */
export async function renewInvite(
  ctx: AuthContext,
  inviteId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { data, error } = await supabase
    .from('invites')
    .update({
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      // Back to pending, or the signup lookup still will not find it: it
      // filters on status AND date, and the sweep already changed the status.
      status: 'pending',
    })
    .eq('id', inviteId)
    .in('status', ['pending', 'expired'])
    .select('id');
  if (error) return { ok: false, message: error.message };
  if (!data?.length) {
    return {
      ok: false,
      message: 'Only a pending or expired invite can be renewed. Invite the address again instead.',
    };
  }
  return { ok: true };
}

/**
 * Mark every past-due pending invite as expired.
 *
 * `expire_stale_invites()` has existed since migration 1 and nothing has ever
 * called it, so an invite past its date still reads "pending" forever. It is
 * housekeeping, not a security boundary — the signup lookup filters on
 * `expires_at`, so a stale row is already unusable — but a list that shows it
 * as pending is telling the admin something untrue.
 *
 * Called when the Users screen loads rather than on a schedule: this project
 * has no job runner, and the only person who needs the column to be accurate is
 * the admin looking at it right now.
 */
export async function sweepExpiredInvites(ctx: AuthContext): Promise<number> {
  if (!ctx.isAdmin) return 0;
  const { data, error } = await supabaseAdmin().rpc('expire_stale_invites');
  if (error) {
    // Never let housekeeping take the screen down with it.
    console.error('[invites] expiry sweep failed', error.message);
    return 0;
  }
  return Number(data ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Login history — Admin Plan §2.2                                            */
/*                                                                            */
/* "Login visibility: the user list shows a last-login column; clicking        */
/*  through opens the user's full login history (timestamps, IP addresses,     */
/*  user agents) sourced from the auth audit log."                             */
/*                                                                            */
/* The column existed and led nowhere. Everything the sentence asks for was    */
/* already being written — `auth_audit_log` has carried ip and user_agent on   */
/* every authentication event since migration 1 — so this is a read, not a     */
/* new capture.                                                               */
/* -------------------------------------------------------------------------- */

export type LoginEvent = {
  id: string;
  eventType: string;
  at: string;
  ip: string | null;
  userAgent: string | null;
  /** True for the events that mean somebody tried and did not get in. Drives
   *  the row's tone, so a page of failures is visible at a glance rather than
   *  needing to be read event type by event type. */
  failed: boolean;
};

/** Which audit events are a failed attempt rather than a step that worked.
 *  Listed explicitly: an unknown event type is NOT assumed to be a failure,
 *  because colouring a future success red is worse than leaving it neutral. */
const FAILURE_EVENTS = new Set([
  'login_failure',
  'otp_failed',
  'otp_rate_limited',
  'otp_resend_cooldown',
  'signup_rejected_no_invite',
]);

/**
 * One person's authentication history, newest first.
 *
 * ── WHY IT MATCHES ON BOTH THE ID AND THE EMAIL ──────────────────────────
 * `actor_id` is null on the events that happen BEFORE there is a session to
 * attribute — a failed login, a rejected signup, a rate-limited OTP. Those are
 * exactly the rows an admin opening a login history is most likely to be
 * looking for, and matching on `actor_id` alone silently omits every one of
 * them. `email_attempted` is what carries identity there, and `profiles.email`
 * is unique, so the two together are this person and nobody else.
 *
 * ⚠️ One consequence worth knowing: a person whose email was CHANGED keeps only
 * the id-matched half of their history under the old address. Nothing in the
 * build changes an email today except `purge_user`, which is meant to sever
 * exactly this link.
 *
 * `supabaseAdmin()` because `auth_audit_log` is admin-only and not readable by
 * the request-scoped client at all.
 */
export async function listLoginHistory(
  ctx: AuthContext,
  userId: string,
  limit = 200,
): Promise<LoginEvent[]> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) return [];

  const { data, error } = await supabase
    .from('auth_audit_log')
    .select('id, event_type, created_at, ip, user_agent')
    .or(`actor_id.eq.${userId},email_attempted.eq.${profile.email}`)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((r) => ({
    id: String(r.id),
    eventType: r.event_type,
    at: r.created_at,
    ip: r.ip,
    userAgent: r.user_agent,
    failed: FAILURE_EVENTS.has(r.event_type),
  }));
}

/* -------------------------------------------------------------------------- */
/* Offboarding — Admin Plan §2.1's three levels                               */
/*                                                                            */
/* "Remove users — three levels: Pause … Soft delete — the user moves to the   */
/*  Recycle Bin and is restorable … Full delete — permanent removal.           */
/*                                                                            */
/*  Forced reassignment: before a soft or full delete can proceed, the admin   */
/*  must complete a reassignment flow covering every record on which the       */
/*  departing user is the Team member (a bulk 'reassign all of X's records     */
/*  to …' action). A delete is blocked until reassignment is complete."        */
/*                                                                            */
/* Pause was the only level that existed. The other two, and the reassignment  */
/* that gates them, are migration 55 — and the BLOCK lives there rather than   */
/* here on purpose: Team member is the only field that grants record           */
/* visibility (Admin §2.3), so deleting the last one on a record makes it      */
/* invisible to every non-admin with no error at all. That is not a rule a     */
/* screen should be trusted to remember.                                       */
/*                                                                            */
/* ⚠️ ALL FOUR GO THROUGH THE REQUEST-SCOPED CLIENT, unlike everything above.  */
/* The functions are `security definer` and check `auth_is_admin()`, which     */
/* resolves through `auth.uid()`. The service-role key carries no `sub`, so    */
/* `auth.uid()` is NULL under `supabaseAdmin()` and every one of them would    */
/* refuse an actual admin with "Admin only". `restoreRecord`/`purgeRecord`     */
/* follow the same rule for the same reason.                                   */
/* -------------------------------------------------------------------------- */

export type OffboardResult = { ok: true } | { ok: false; message: string };

/**
 * How many live records this person is a Team member on — the number the
 * reassignment flow is about.
 *
 * Read fresh every time the dialog opens rather than carried on `AdminUserRow`:
 * it is the input to a destructive decision, and a number rendered with the
 * page could be minutes old by the time anyone acts on it. `soft_delete_user`
 * re-counts at write time regardless, so a stale count here can only ever
 * mislead the admin, never corrupt the outcome.
 */
export async function getUserRecordCount(ctx: AuthContext, userId: string): Promise<number> {
  assertAdmin(ctx);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('count_user_records', { p_user: userId });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Bulk "reassign all of X's records to Y".
 *
 * Writes the `team_members_assigned` FIELD, not `record_team_members` — that
 * table is a trigger-maintained projection of the field, so a direct write
 * would be overwritten by the next value edit with nothing to show for it.
 * Every record moved is activity-logged individually, because "who can see
 * this record" changing is exactly what the log is for.
 */
export async function reassignUserRecords(
  ctx: AuthContext,
  fromUserId: string,
  toUserId: string,
): Promise<OffboardResult & { moved?: number }> {
  assertAdmin(ctx);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('reassign_user_records', {
    p_from: fromUserId,
    p_to: toUserId,
  });
  if (error) return { ok: false, message: error.message };
  // Visibility just changed for the person receiving the records, and possibly
  // for the one losing them. Drop the request-scoped grant cache so nothing
  // rendered inside this action's own response answers from before the move.
  invalidateGrants();
  return { ok: true, moved: Number(data ?? 0) };
}

/** Soft delete → the Recycle Bin. Refused while the person still holds
 *  records; the message names how many. */
export async function softDeleteUser(ctx: AuthContext, userId: string): Promise<OffboardResult> {
  assertAdmin(ctx);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('soft_delete_user', { p_user: userId });
  if (error) return { ok: false, message: error.message };
  invalidateGrants();
  return { ok: true };
}

/** Back out of the bin — SUSPENDED, never straight to active. Restoring an
 *  account and re-enabling sign-in are two decisions, and the second one is
 *  Resume. */
export async function restoreUser(ctx: AuthContext, userId: string): Promise<OffboardResult> {
  assertAdmin(ctx);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('restore_user', { p_user: userId });
  if (error) return { ok: false, message: error.message };
  invalidateGrants();
  return { ok: true };
}

/**
 * Full delete — Admin §2.1's third level, and the only one with no way back.
 *
 * Returns WHICH of two things happened, because they are genuinely different
 * and the admin has to be told:
 *
 *   'deleted'     nothing referenced this person, so the row is gone;
 *   'anonymised'  they had written something, so the login is destroyed and the
 *                 profile is emptied, but the id survives to sign their old
 *                 notes and files.
 *
 * `purge_user` decides by attempting the delete, not by guessing. Reporting the
 * outcome rather than saying "permanently deleted" both times is the point: an
 * admin may have a legal duty to be right about which one they got.
 */
export type PurgeOutcome = 'deleted' | 'anonymised';

export async function purgeUser(
  ctx: AuthContext,
  userId: string,
): Promise<OffboardResult & { outcome?: PurgeOutcome }> {
  assertAdmin(ctx);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('purge_user', { p_user: userId });
  if (error) return { ok: false, message: error.message };
  invalidateGrants();
  return { ok: true, outcome: data as PurgeOutcome };
}

export type DeletedUserRow = {
  id: string;
  email: string;
  fullName: string | null;
  roleName: string;
  deletedAt: string | null;
};

/**
 * The users sitting in the Recycle Bin.
 *
 * `supabaseAdmin()` here and not the request-scoped client, opposite to the
 * four writers above and for the mirror-image reason: a soft-deleted profile is
 * invisible to the RLS'd client by design (every policy filters
 * `deleted_at is null`), so the bin would always render empty. Same rule
 * `listDeletedRecords` follows.
 */
export async function listDeletedUsers(ctx: AuthContext): Promise<DeletedUserRow[]> {
  if (!ctx.isAdmin) return [];
  const supabase = supabaseAdmin();
  const [profilesRes, rolesRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, email, full_name, role_id, deleted_at')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false }),
    supabase.from('roles').select('id, name'),
  ]);
  if (profilesRes.error) throw profilesRes.error;
  if (rolesRes.error) throw rolesRes.error;

  const roleById = new Map((rolesRes.data ?? []).map((r) => [r.id, r.name as string]));
  return (profilesRes.data ?? []).map((p) => ({
    id: p.id,
    email: p.email,
    fullName: p.full_name,
    roleName: roleById.get(p.role_id) ?? 'Unknown role',
    deletedAt: p.deleted_at,
  }));
}
