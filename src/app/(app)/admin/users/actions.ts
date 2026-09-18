'use server';

/**
 * Admin → Users server actions.
 *
 * ── ZOD, RETRO-FITTED (Phase 6c) ─────────────────────────────────────────
 * These read `FormData` and bare arguments, and until now did it with raw
 * `String(...)` casts — the same CLAUDE.md §6 gap Phase 0 retro-fixed for
 * Presets, on endpoints that pause an account and reassign a permission
 * template. A Server Action is a public HTTP endpoint whatever the form in front
 * of it looks like, and "the dropdown only sends real ids" is not a security
 * property. Fixed here because 6c adds two more actions to this file and adds
 * `adminUsers.ts` to `adminConfig.test.ts`'s watch list, which fails the build
 * for an unparsed one.
 *
 * ── AND NO `revalidateConfig()`, EVER ────────────────────────────────────
 * Same rule as `templates/actions.ts`, same reason: a user's grants must
 * resolve at call time so that editing a template reaches every attached person
 * on their next request with no push step (`CLIENT-SPEC-BY-MODULE.md` §8).
 * `revalidatePath` is a rendering concern and is fine. The guard test pins both
 * halves.
 */
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import {
  inviteUser, pauseUser, resumeUser, assignTemplate,
  getUserRecordCount, reassignUserRecords, softDeleteUser, restoreUser, purgeUser,
  revokeInvite, renewInvite,
  type PurgeOutcome,
} from '@/lib/records/adminUsers';
import { clearUserGrant, setUserGrant, type GrantResult } from '@/lib/records/adminGrants';
import {
  grantRecordVisibility,
  revokeRecordVisibility,
  type VisibilityResult,
} from '@/lib/records/adminVisibility';
import {
  inviteUserSchema,
  userIdSchema,
  assignTemplateSchema,
  setUserGrantSchema,
  clearUserGrantSchema,
  recordVisibilityGrantSchema,
  revokeVisibilityGrantSchema,
  reassignUserRecordsSchema,
  inviteIdSchema,
  firstIssueMessage,
} from '@/lib/records/adminSchemas';
import type { Grant, GrantScope } from '@/lib/records/grantRules';

export type InviteState = { ok: boolean; message?: string };

export async function inviteUserAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const ctx = await authorize();

  const parsed = inviteUserSchema.safeParse({
    email: formData.get('email'),
    roleId: formData.get('roleId'),
    templateId: formData.get('templateId') ?? undefined,
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await inviteUser(ctx, parsed.data);
  if (!result.ok) return result;

  revalidatePath('/admin/users');
  return { ok: true };
}

export async function pauseUserAction(userId: string): Promise<InviteState> {
  const ctx = await authorize();

  const parsed = userIdSchema.safeParse({ userId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  await pauseUser(ctx, parsed.data.userId);
  revalidatePath('/admin/users');
  return { ok: true };
}

export async function resumeUserAction(userId: string): Promise<InviteState> {
  const ctx = await authorize();

  const parsed = userIdSchema.safeParse({ userId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  await resumeUser(ctx, parsed.data.userId);
  revalidatePath('/admin/users');
  return { ok: true };
}

/**
 * Assigning a template DELETES every one of that user's personal overrides —
 * see `assignTemplate` for why that is deliberate and why it stays.
 *
 * `confirm` is what makes the destruction deliberate rather than incidental: the
 * data layer refuses without it whenever overrides exist, and hands back the
 * count so the table can say what it is about to delete. Two calls, not one, and
 * the second one is the admin's answer — not a flag the first call sets for
 * itself.
 */
export type AssignTemplateState =
  | { ok: true }
  | { ok: false; message: string; overrideCount?: number };

export async function assignTemplateAction(
  userId: string,
  templateId: string,
  confirm = false,
): Promise<AssignTemplateState> {
  const ctx = await authorize();

  const parsed = assignTemplateSchema.safeParse({ userId, templateId, confirmClearOverrides: confirm });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await assignTemplate(ctx, parsed.data);
  if (!result.ok) return result;

  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${parsed.data.userId}/permissions`);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Per-user grant overrides — Phase 6c                                        */
/* -------------------------------------------------------------------------- */

/**
 * The branch of `effective_grant()`'s coalesce that nothing in this build could
 * reach until now, and the reason two of the client's three permission labels
 * were unreachable states (`remaining-plan.md` § The scope question).
 */
function revalidateUserGrants(userId: string): void {
  revalidatePath(`/admin/users/${userId}/permissions`);
  // The badge on the list is computed from the override count, so it changes
  // the moment the first override is written or the last one cleared.
  revalidatePath('/admin/users');
}

export async function setUserGrantAction(
  userId: string,
  scopeKind: GrantScope,
  scopeId: string,
  level: Grant,
): Promise<GrantResult> {
  const ctx = await authorize();

  const parsed = setUserGrantSchema.safeParse({ userId, scopeKind, scopeId, level });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setUserGrant(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateUserGrants(parsed.data.userId);
  return { ok: true };
}

/** Back to the template's value — which is not Hidden, and not Edit either,
 * unless the template happens to say so. Clearing an override on a scope the
 * template does not mention falls all the way through to Edit. */
export async function clearUserGrantAction(
  userId: string,
  scopeKind: GrantScope,
  scopeId: string,
): Promise<GrantResult> {
  const ctx = await authorize();

  const parsed = clearUserGrantSchema.safeParse({ userId, scopeKind, scopeId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await clearUserGrant(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateUserGrants(parsed.data.userId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Record visibility grants                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The OTHER half of "who can see this record", and the one that had no screen at
 * all until now: `record_visibility_grants` existed from migration 7, was read
 * by `can_see_record()` from migration 1, and had zero references anywhere in
 * `src/`. The mechanism was complete and unreachable.
 *
 * These live in THIS file, next to the per-user grant actions, rather than beside
 * the page that uses them — `adminConfig.test.ts` only scans
 * `admin/<route>/actions.ts`, so an action tucked under a dynamic segment escapes
 * the "parses its input" and "never caches a permission" guards entirely. Same
 * reasoning as 6c's grant actions.
 *
 * `revalidatePath` only, never `revalidateConfig()`: a visibility grant is
 * evaluated by Postgres inside an RLS predicate on every statement, so it takes
 * effect on the viewer's next query with nothing to propagate — and a cache in
 * front of a permission is the failure this codebase keeps writing tests about.
 */
function revalidateVisibility(ownerId: string, viewerId: string): void {
  revalidatePath(`/admin/users/${ownerId}/record-access`);
  revalidatePath(`/admin/users/${viewerId}/record-access`);
}

export async function grantRecordVisibilityAction(
  ownerId: string,
  viewerId: string,
): Promise<VisibilityResult> {
  const ctx = await authorize();

  const parsed = recordVisibilityGrantSchema.safeParse({ ownerId, viewerId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await grantRecordVisibility(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateVisibility(parsed.data.ownerId, parsed.data.viewerId);
  return { ok: true };
}

/**
 * Revoke, by grant id. The two people are read from the row inside
 * `revokeRecordVisibility`, so the caller's own idea of who the grant is between
 * cannot decide what gets deleted — but both pages still need revalidating, and
 * the client already knows the pair it is looking at. Passing them for the
 * REVALIDATE is not the same as passing them for the DELETE.
 */
export async function revokeRecordVisibilityAction(
  grantId: string,
  ownerId: string,
  viewerId: string,
): Promise<VisibilityResult> {
  const ctx = await authorize();

  const parsed = revokeVisibilityGrantSchema.safeParse({ grantId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await revokeRecordVisibility(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateVisibility(ownerId, viewerId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Offboarding — Admin §2.1's three levels                                    */
/*                                                                            */
/* No `revalidateConfig()` here either, for this file's standing reason: none  */
/* of these writes a `loadConfig()` table, and a user's permissions must       */
/* resolve live. `revalidatePath` is a rendering concern and is what these     */
/* need — a deleted user has to leave the Users list AND appear in the Recycle */
/* Bin, which are two routes.                                                  */
/* -------------------------------------------------------------------------- */

/** How many records the person is a Team member on. Read at the moment the
 *  dialog opens rather than carried with the page, because it is the input to
 *  a destructive decision. */
export async function userRecordCountAction(userId: string): Promise<number> {
  const ctx = await authorize();

  const parsed = userIdSchema.safeParse({ userId });
  if (!parsed.success) return 0;

  return getUserRecordCount(ctx, parsed.data.userId);
}

export async function reassignUserRecordsAction(
  fromUserId: string,
  toUserId: string,
): Promise<InviteState & { moved?: number }> {
  const ctx = await authorize();

  const parsed = reassignUserRecordsSchema.safeParse({ fromUserId, toUserId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await reassignUserRecords(ctx, parsed.data.fromUserId, parsed.data.toUserId);
  if (!result.ok) return result;

  // Every module route, not just this screen: the records changed hands, so who
  // can see them changed too, and the dashboards those records appear on are
  // rendered from that.
  revalidatePath('/', 'layout');
  return { ok: true, moved: result.moved };
}

export async function softDeleteUserAction(userId: string): Promise<InviteState> {
  const ctx = await authorize();

  const parsed = userIdSchema.safeParse({ userId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await softDeleteUser(ctx, parsed.data.userId);
  if (!result.ok) return result;

  revalidatePath('/admin/users');
  revalidatePath('/admin/recycle-bin');
  return { ok: true };
}

export async function restoreUserAction(userId: string): Promise<InviteState> {
  const ctx = await authorize();

  const parsed = userIdSchema.safeParse({ userId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await restoreUser(ctx, parsed.data.userId);
  if (!result.ok) return result;

  revalidatePath('/admin/users');
  revalidatePath('/admin/recycle-bin');
  return { ok: true };
}

/**
 * Permanent. Only from the Recycle Bin, and the outcome is handed back so the
 * screen can say which of the two things happened rather than claiming the
 * stronger one both times.
 */
export async function purgeUserAction(userId: string): Promise<InviteState & { outcome?: PurgeOutcome }> {
  const ctx = await authorize();

  const parsed = userIdSchema.safeParse({ userId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await purgeUser(ctx, parsed.data.userId);
  if (!result.ok) return result;

  revalidatePath('/admin/users');
  revalidatePath('/admin/recycle-bin');
  return { ok: true, outcome: result.outcome };
}

/* -------------------------------------------------------------------------- */
/* Invites — Login spec §2                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cancel a pending invite.
 *
 * Only pending invites can be cancelled, enforced in the data layer's WHERE
 * clause rather than here: an accepted invite is the audit record of how a real
 * account came to exist, and it must stay as it is.
 */
export async function revokeInviteAction(inviteId: string): Promise<InviteState> {
  const ctx = await authorize();

  const parsed = inviteIdSchema.safeParse({ inviteId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await revokeInvite(ctx, parsed.data.inviteId);
  if (!result.ok) return result;

  revalidatePath('/admin/users');
  return { ok: true };
}

/** Give a pending invite another 7 days. */
export async function renewInviteAction(inviteId: string): Promise<InviteState> {
  const ctx = await authorize();

  const parsed = inviteIdSchema.safeParse({ inviteId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await renewInvite(ctx, parsed.data.inviteId);
  if (!result.ok) return result;

  revalidatePath('/admin/users');
  return { ok: true };
}
