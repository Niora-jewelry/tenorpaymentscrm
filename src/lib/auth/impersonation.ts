/**
 * "Sign in as" — an admin borrowing another account to see what that person
 * sees.
 *
 * ── THE CLIENT'S ASK ─────────────────────────────────────────────────────
 *   "I need the ability to sign in as other user types to test"
 *
 * ── WHY THIS MINTS A REAL SESSION INSTEAD OF FAKING ONE IN THE APP ───────
 * The obvious implementation is a cookie saying "pretend to be user X" that
 * `authorize()` honours. It would be wrong, and quietly so.
 *
 * Permissions in this build are enforced in the DATABASE as well as the app:
 * RLS reads `auth.uid()` from the JWT, and `auth_is_admin()` short-circuits
 * every grant to Edit. An app-level pretence leaves the real admin's JWT in
 * place, so the screen would render a Sales Rep's restricted tabs while the
 * database happily returned every record in the CRM. The admin would be shown
 * a view no Sales Rep could ever have, and would sign off on it.
 *
 * So this exchanges the admin's session for a genuine one belonging to the
 * target, minted through the admin API. Everything downstream — RLS, the grant
 * chain, `record_visible()`, the storage policies — runs as that person,
 * because for the length of the session the request IS that person.
 *
 * ── WHAT MAKES IT SAFE TO HAND SOMEBODY ──────────────────────────────────
 *   * Admin only, checked on the server, never from anything the client sends.
 *   * Never another admin. There is nothing to learn from it and it would make
 *     the audit trail ambiguous about which admin acted.
 *   * Never a suspended or deleted account — those must not hold a session at
 *     all, which is the rule `login.ts` already enforces.
 *   * Both ends are written to `auth_audit_log`, naming the admin AND the
 *     target, so "who actually did this" is answerable afterwards.
 *   * The admin's own session is kept in an HTTP-only cookie and restored on
 *     exit, so returning is one click rather than a fresh login.
 *
 * ── THE HONEST LIMITATION ────────────────────────────────────────────────
 * While impersonating, actions really are performed BY the target: anything
 * written carries their id, and `touch_last_seen` updates their last-seen
 * time. That is the price of a faithful view — a pretend session would not
 * show the truth — and it is why the banner is loud and always on screen. It
 * is a tool for LOOKING, and the banner says so.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { logAuthEvent, AUTH_EVENTS } from '@/lib/audit/log';
import type { RequestContext } from '@/lib/security/request';

/**
 * Where the ADMIN's own session waits while they are someone else.
 *
 * It holds the admin's access and refresh tokens — the same pair already
 * living in their session cookie, so this is not new exposure, just a second
 * copy under a different name. HTTP-only so no script can read it.
 */
const STASH_COOKIE = 'tapdash-impersonator';

type Stash = {
  adminId: string;
  adminEmail: string;
  targetId: string;
  targetEmail: string;
  accessToken: string;
  refreshToken: string;
};

export type ImpersonationState = {
  adminEmail: string;
  targetEmail: string;
} | null;

/** Who is really driving, when somebody is. Read by the banner. */
export async function currentImpersonation(): Promise<ImpersonationState> {
  const raw = (await cookies()).get(STASH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const stash = JSON.parse(Buffer.from(raw, 'base64').toString()) as Stash;
    return { adminEmail: stash.adminEmail, targetEmail: stash.targetEmail };
  } catch {
    // A malformed cookie must not break every page. Treat it as absent; the
    // admin's worst case is signing in again.
    return null;
  }
}

export type StartResult = { ok: true } | { ok: false; message: string };

export async function startImpersonation(
  adminId: string,
  targetUserId: string,
  context?: RequestContext,
): Promise<StartResult> {
  if (adminId === targetUserId) {
    return { ok: false, message: 'You are already signed in as yourself.' };
  }

  const admin = supabaseAdmin();

  const [{ data: adminRow }, { data: target }] = await Promise.all([
    admin.from('profiles').select('email').eq('id', adminId).maybeSingle(),
    admin
      .from('profiles')
      .select('id, email, status, deleted_at, role_id')
      .eq('id', targetUserId)
      .maybeSingle(),
  ]);

  if (!target || target.deleted_at !== null) {
    return { ok: false, message: 'That account no longer exists.' };
  }
  if (target.status !== 'active') {
    // Same rule as `login.ts`: a suspended account must not hold a session,
    // and borrowing one would go round that.
    return { ok: false, message: 'That account is paused, so it cannot hold a session.' };
  }

  const { data: role } = await admin
    .from('roles')
    .select('is_admin, name')
    .eq('id', target.role_id as string)
    .maybeSingle();
  if (role?.is_admin) {
    return {
      ok: false,
      message: `${role.name} is an admin role, which sees everything you already see. Signing in as one would only make the audit trail ambiguous.`,
    };
  }

  // The admin's current session, kept so they can come back.
  const supabase = await createSupabaseServerClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const current = sessionData.session;
  if (!current) return { ok: false, message: 'Your session has expired. Sign in again.' };

  /*
   * A one-time link for the target, exchanged immediately for a session.
   * `generateLink` does NOT send mail — it returns the token — which matters
   * here twice over: the target must not be emailed about a login they did not
   * ask for, and this deployment has no mail provider configured anyway.
   */
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: target.email as string,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    return { ok: false, message: 'Could not start the session for that account.' };
  }

  // Exchanged on a throwaway client so the cookie jar is only written once,
  // below, after everything that can fail has succeeded.
  const exchange = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: verified, error: verifyError } = await exchange.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  });
  if (verifyError || !verified.session) {
    return { ok: false, message: 'Could not start the session for that account.' };
  }

  const stash: Stash = {
    adminId,
    adminEmail: (adminRow?.email as string) ?? 'your account',
    targetId: targetUserId,
    targetEmail: target.email as string,
    accessToken: current.access_token,
    refreshToken: current.refresh_token,
  };

  const jar = await cookies();
  jar.set(STASH_COOKIE, Buffer.from(JSON.stringify(stash)).toString('base64'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Long enough for a testing session, short enough that a forgotten one
    // expires rather than lingering for ever.
    maxAge: 60 * 60 * 8,
  });

  // Only now does the admin stop being themselves.
  await supabase.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });

  await logAuthEvent({
    event: AUTH_EVENTS.impersonationStarted,
    actorId: adminId,
    email: target.email as string,
    context,
    metadata: { target_id: targetUserId, target_email: target.email },
  });

  return { ok: true };
}

export type StopResult = { ok: true } | { ok: false; message: string };

export async function stopImpersonation(context?: RequestContext): Promise<StopResult> {
  const jar = await cookies();
  const raw = jar.get(STASH_COOKIE)?.value;
  if (!raw) return { ok: false, message: 'You are not signed in as anyone else.' };

  let stash: Stash;
  try {
    stash = JSON.parse(Buffer.from(raw, 'base64').toString()) as Stash;
  } catch {
    jar.delete(STASH_COOKIE);
    return { ok: false, message: 'That session could not be restored. Sign in again.' };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.setSession({
    access_token: stash.accessToken,
    refresh_token: stash.refreshToken,
  });

  // Cleared either way. Leaving it would keep the banner up over a session
  // that is no longer borrowed, which is worse than asking for a fresh login.
  jar.delete(STASH_COOKIE);

  await logAuthEvent({
    event: AUTH_EVENTS.impersonationEnded,
    actorId: stash.adminId,
    email: stash.targetEmail,
    context,
    metadata: { target_id: stash.targetId, target_email: stash.targetEmail },
  });

  if (error) {
    // The stashed session expired while they were away. Signing out is the
    // honest end state — they are nobody now, and the login page says so.
    await supabase.auth.signOut();
    return { ok: false, message: 'Your own session had expired. Please sign in again.' };
  }

  return { ok: true };
}
