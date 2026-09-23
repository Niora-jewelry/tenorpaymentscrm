'use server';

/**
 * The two ends of "sign in as", as Server Actions.
 *
 * Kept in their own file rather than added to `actions.ts` because both of
 * them REPLACE the caller's session. Everything in `actions.ts` assumes the
 * session it started with is the session it finishes with; mixing the one pair
 * that breaks that assumption into the same module invites someone to call
 * them in the middle of a longer flow.
 *
 * The admin check lives in `authorize()` here and in `startImpersonation`'s own
 * guards — the app layer decides who may ask, the library decides who may be
 * asked for. Neither trusts the browser for either half.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import { userIdSchema, firstIssueMessage } from '@/lib/records/adminSchemas';
import { startImpersonation, stopImpersonation } from '@/lib/auth/impersonation';
import { headers } from 'next/headers';
import { requestContext } from '@/lib/security/request';

export type ImpersonateState = { ok: boolean; message?: string };

export async function startImpersonationAction(userId: string): Promise<ImpersonateState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Only an administrator can do that.' };

  const parsed = userIdSchema.safeParse({ userId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await startImpersonation(ctx.userId, parsed.data.userId, requestContext(await headers()));
  if (!result.ok) return result;

  /*
   * Everything cached for the admin belongs to a different person now. Not
   * revalidating leaves the previous account's dashboard on screen under the
   * new session, which is the one outcome this feature must never produce.
   */
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function stopImpersonationAction(): Promise<ImpersonateState> {
  // Deliberately NOT gated on `ctx.isAdmin`: while impersonating, the caller
  // IS the non-admin target. Gating on admin would strand them as that person
  // with no way back. The stash cookie is the authority here — without it
  // there is nothing to return to, and it is HTTP-only so nothing in the page
  // can forge one.
  const result = await stopImpersonation(requestContext(await headers()));
  revalidatePath('/', 'layout');
  if (!result.ok) {
    // The admin's own session had expired; they have been signed out.
    redirect('/login');
  }
  return { ok: true };
}
