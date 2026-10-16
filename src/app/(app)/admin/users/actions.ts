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
  sendInviteNotification,
} from '@/lib/records/adminUsers';
import {
  clearUserGrant,
  setUserGrant,
  setUserGrants,
  setInviteGrants,
  type GrantBatchResult,
  clearInviteGrant,
  setInviteGrant,
  inviteGrantMatrix,
  type GrantResult,
} from '@/lib/records/adminGrants';
import type { GrantMatrix as GrantMatrixData } from '@/lib/records/adminGrants';
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
  setUserGrantsSchema,
  setInviteGrantsSchema,
  clearUserGrantSchema,
  setInviteGrantSchema,
  clearInviteGrantSchema,
  recordVisibilityGrantSchema,
  revokeVisibilityGrantSchema,
  reassignUserRecordsSchema,
  inviteIdSchema,
  firstIssueMessage,
} from '@/lib/records/adminSchemas';
import type { Grant, GrantScope } from '@/lib/records/grantRules';

export type InviteState = {
  ok: boolean;
  message?: string;
  /** Set on a successful invite, so the drawer can link straight to that
   *  invite's permission matrix — the client's "adjust permissions before
   *  sending invite". */
  inviteId?: string | null;
};

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
  return { ok: true, inviteId: result.inviteId };
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
  /** Null/omitted writes the grant that applies in EVERY module. A module id
   *  writes an override for that module alone — §2.2's per-module granularity. */
  moduleId?: string | null,
): Promise<GrantResult> {
  const ctx = await authorize();

  const parsed = setUserGrantSchema.safeParse({ userId, scopeKind, scopeId, level, moduleId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setUserGrant(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateUserGrants(parsed.data.userId);
  return { ok: true };
}

/**
 * Several of one person's overrides at once — the client's Addition 4. Same
 * writer per item as a single click; the result names every item that did
 * not land, so the matrix can roll back exactly those rows.
 */
export async function setUserGrantsAction(
  userId: string,
  items: { scopeKind: GrantScope; scopeId: string; level: Grant | null }[],
  moduleId?: string | null,
): Promise<GrantBatchResult> {
  const ctx = await authorize();

  const parsed = setUserGrantsSchema.safeParse({ userId, moduleId, items });
  if (!parsed.success) {
    return { ok: false, failed: items.map((i) => ({ ...i, message: firstIssueMessage(parsed.error) })) };
  }

  const result = await setUserGrants(ctx, parsed.data);
  revalidateUserGrants(parsed.data.userId);
  return result;
}

/** Back to the template's value — which is not Hidden, and not Edit either,
 * unless the template happens to say so. Clearing an override on a scope the
 * template does not mention falls all the way through to Edit. */
export async function clearUserGrantAction(
  userId: string,
  scopeKind: GrantScope,
  scopeId: string,
  moduleId?: string | null,
): Promise<GrantResult> {
  const ctx = await authorize();

  const parsed = clearUserGrantSchema.safeParse({ userId, scopeKind, scopeId, moduleId });
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
/**
 * Send the "you're invited" email for an invite that already exists.
 *
 * Called when the admin finishes step two of the invite dialog, and again
 * from Resend in the invites table. Separate from `inviteUserAction` on
 * purpose: the invite row has to exist before its permissions can be set, so
 * the row is created first and announced last - which is the order the client
 * asked for, "assign a template and adjust permissions BEFORE sending".
 *
 * Returns the address on success so the dialog can name it in the
 * confirmation rather than saying something vague about "the user".
 */
export async function sendInviteEmailAction(
  inviteId: string,
): Promise<InviteState & { email?: string }> {
  const ctx = await authorize();

  const parsed = inviteIdSchema.safeParse({ inviteId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await sendInviteNotification(ctx, parsed.data.inviteId);
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath('/admin/users');
  return { ok: true, email: result.email };
}

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


/* -------------------------------------------------------------------------- */
/* Invite permissions — set before the person exists                          */
/* -------------------------------------------------------------------------- */

/**
 * The same pair as `setUserGrantAction`/`clearUserGrantAction`, addressed to an
 * INVITE instead of a user. `complete_signup` copies these into `user_grants`
 * the moment the person finishes signing up, so what the admin sets here is
 * what they get — no gap where the account is live with only its template.
 */
export async function setInviteGrantAction(
  inviteId: string,
  scopeKind: GrantScope,
  scopeId: string,
  level: Grant,
  moduleId?: string | null,
): Promise<GrantResult> {
  const ctx = await authorize();

  const parsed = setInviteGrantSchema.safeParse({ inviteId, scopeKind, scopeId, level, moduleId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setInviteGrant(ctx, parsed.data);
  if (!result.ok) return result;

  revalidatePath(`/admin/users/invites/${parsed.data.inviteId}/permissions`);
  revalidatePath('/admin/users');
  return { ok: true };
}

export async function setInviteGrantsAction(
  inviteId: string,
  items: { scopeKind: GrantScope; scopeId: string; level: Grant | null }[],
  moduleId?: string | null,
): Promise<GrantBatchResult> {
  const ctx = await authorize();

  const parsed = setInviteGrantsSchema.safeParse({ inviteId, moduleId, items });
  if (!parsed.success) {
    return { ok: false, failed: items.map((i) => ({ ...i, message: firstIssueMessage(parsed.error) })) };
  }

  const result = await setInviteGrants(ctx, parsed.data);
  revalidatePath(`/admin/users/invites/${parsed.data.inviteId}/permissions`);
  revalidatePath('/admin/users');
  return result;
}

export async function clearInviteGrantAction(
  inviteId: string,
  scopeKind: GrantScope,
  scopeId: string,
  moduleId?: string | null,
): Promise<GrantResult> {
  const ctx = await authorize();

  const parsed = clearInviteGrantSchema.safeParse({ inviteId, scopeKind, scopeId, moduleId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await clearInviteGrant(ctx, parsed.data);
  if (!result.ok) return result;

  revalidatePath(`/admin/users/invites/${parsed.data.inviteId}/permissions`);
  revalidatePath('/admin/users');
  return { ok: true };
}


/**
 * The invite's permission matrix, fetched from inside the invite dialog.
 *
 * The client's ask was to adjust permissions "before sending invite", and
 * sending them to another page to do it is not that. So the dialog fetches the
 * matrix and renders it in place — which needs the data as a return value
 * rather than as page props, hence this action.
 *
 * Plain data on purpose: `GrantMatrix` is a client component and its props are
 * already serialisable, so nothing has to be rebuilt for this to cross the
 * boundary.
 */
export async function inviteMatrixAction(
  inviteId: string,
  moduleId: string | null,
): Promise<GrantMatrixData | null> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return null;

  const parsed = inviteIdSchema.safeParse({ inviteId });
  if (!parsed.success) return null;

  return inviteGrantMatrix(ctx, parsed.data.inviteId, moduleId);
}
