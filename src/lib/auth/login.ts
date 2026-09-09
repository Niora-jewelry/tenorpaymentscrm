/**
 * Login.
 *
 * Spec §3: "Failed login returns the generic message 'Invalid email or password'
 * — never reveals whether the email exists. (Note: signup deliberately uses an
 * explicit message per Section 4; login stays generic.)"
 *
 * Two things make that guarantee real:
 *   1. one message for every failure mode, including a suspended account
 *   2. a uniform response floor, so the DELAY carries no signal either
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { logAuthEvent, AUTH_EVENTS } from '@/lib/audit/log';
import { rateLimitAll, RATE_LIMITS, emailKey, ipKey } from '@/lib/security/rate-limit';
import { withMinimumDuration } from '@/lib/security/timing';
import { AUTH_MESSAGES } from '@/lib/auth/messages';
import { isDemoAuthEnabled, demoCredentialsMatch, demoCredentials } from '@/lib/auth/demo-mode';
import { setDemoSession, clearDemoSession } from '@/lib/auth/session';
import type { RequestContext } from '@/lib/security/request';

export type LoginResult =
  | { status: 'ok'; userId: string }
  | { status: 'failed'; message: string };

export async function login(
  rawEmail: string,
  password: string,
  context: RequestContext,
): Promise<LoginResult> {
  const email = rawEmail.trim().toLowerCase();

  return withMinimumDuration(async () => {
    /*
     * Demo mode — development only, and unreachable in production (the gate
     * throws rather than silently disabling). Still rate limited, still audited
     * where possible, and still checks a FIXED credential pair: there is no
     * branch here in which an unknown password succeeds.
     */
    if (isDemoAuthEnabled()) {
      const limit = await rateLimitAll([
        { key: emailKey('login', email), rule: RATE_LIMITS.loginPerEmail },
      ]).catch(() => ({ allowed: true, retryAfterSeconds: 0 }));

      if (!limit.allowed) {
        return { status: 'failed', message: AUTH_MESSAGES.invalidCredentials };
      }

      if (demoCredentialsMatch(email, password)) {
        await setDemoSession(email, demoCredentials()?.email.split('@')[0] ?? 'Demo user');
        return { status: 'ok', userId: 'demo-user' };
      }

      // Same generic message as the real path.
      return { status: 'failed', message: AUTH_MESSAGES.invalidCredentials };
    }

    const limit = await rateLimitAll([
      { key: emailKey('login', email), rule: RATE_LIMITS.loginPerEmail },
      { key: ipKey('login', context.ip), rule: RATE_LIMITS.loginPerIp },
    ]);
    if (!limit.allowed) {
      await logAuthEvent({ event: AUTH_EVENTS.loginRateLimited, email, context });
      // Same generic message. Saying "you are rate limited" would confirm that
      // this address is worth attacking.
      return { status: 'failed', message: AUTH_MESSAGES.invalidCredentials };
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.user) {
      await logAuthEvent({
        event: AUTH_EVENTS.loginFailure,
        email,
        context,
        metadata: { reason: error?.message ?? 'unknown' },
      });
      return { status: 'failed', message: AUTH_MESSAGES.invalidCredentials };
    }

    const userId = data.user.id;

    // A suspended or soft-deleted user must not hold a session. Sign them back
    // out immediately, and return the SAME generic message.
    const { data: state } = await supabaseAdmin().rpc('session_state_for', {
      p_user_id: userId,
    });
    const profile = state?.[0] as
      | { status: 'active' | 'suspended'; deleted_at: string | null }
      | undefined;

    if (!profile || profile.status !== 'active' || profile.deleted_at !== null) {
      await supabase.auth.signOut();
      await logAuthEvent({
        event: AUTH_EVENTS.loginSuspended,
        actorId: userId,
        email,
        context,
      });
      return { status: 'failed', message: AUTH_MESSAGES.invalidCredentials };
    }

    await supabaseAdmin().rpc('mark_login', { p_user_id: userId });
    await logAuthEvent({
      event: AUTH_EVENTS.loginSuccess,
      actorId: userId,
      email,
      context,
    });

    return { status: 'ok', userId };
  });
}

export async function logout(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  await clearDemoSession();
}
