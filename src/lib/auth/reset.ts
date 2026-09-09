/**
 * Password reset.
 *
 * Spec §5: "Reset flow uses the neutral pattern: never confirms whether an
 * account exists."
 *
 * Neutrality here is stricter than in signup and is enforced three ways:
 *   1. one response for every path — unknown address, known address, rate
 *      limited, send failure
 *   2. a uniform response floor, so timing does not answer the question
 *   3. no code is issued for an unknown address, but the work still LOOKS the
 *      same from outside
 *
 * "On password change, all other active sessions for that user are invalidated."
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { validatePassword } from '@/lib/security/password';
import { logAuthEvent, AUTH_EVENTS } from '@/lib/audit/log';
import { rateLimitAll, RATE_LIMITS, emailKey, ipKey } from '@/lib/security/rate-limit';
import { withMinimumDuration } from '@/lib/security/timing';
import { issueOtp, verifyOtp, redeemTicket } from '@/lib/auth/otp-flow';
import { AUTH_MESSAGES } from '@/lib/auth/messages';
import type { RequestContext } from '@/lib/security/request';

/**
 * Step 1 — request a reset code.
 *
 * ALWAYS returns the same shape. There is intentionally no failure variant:
 * every branch produces the identical neutral message.
 */
export async function startPasswordReset(
  rawEmail: string,
  context: RequestContext,
): Promise<{ message: string }> {
  const email = rawEmail.trim().toLowerCase();

  return withMinimumDuration(async () => {
    const neutral = { message: AUTH_MESSAGES.resetRequested };

    const limit = await rateLimitAll([
      { key: emailKey('reset_otp', email), rule: RATE_LIMITS.resetOtpPerEmail },
      { key: ipKey('reset_otp', context.ip), rule: RATE_LIMITS.resetOtpPerIp },
    ]);
    if (!limit.allowed) {
      await logAuthEvent({
        event: AUTH_EVENTS.otpRateLimited,
        email,
        context,
        metadata: { purpose: 'reset' },
      });
      return neutral;
    }

    const { data: registered } = await supabaseAdmin().rpc('email_is_registered', {
      p_email: email,
    });

    if (registered === true) {
      // Failures are swallowed on purpose — surfacing them would distinguish a
      // real account from an unknown one.
      await issueOtp(email, 'reset', context);
    }

    return neutral;
  });
}

export type VerifyResetOtpResult =
  | { status: 'ok'; ticket: string }
  | { status: 'failed'; message: string };

/** Step 2 — verify the code. */
export async function verifyResetOtp(
  rawEmail: string,
  code: string,
  context: RequestContext,
): Promise<VerifyResetOtpResult> {
  const email = rawEmail.trim().toLowerCase();

  const limit = await rateLimitAll([
    { key: emailKey('otp_verify', email), rule: RATE_LIMITS.otpVerifyPerEmail },
  ]);
  if (!limit.allowed) {
    return { status: 'failed', message: AUTH_MESSAGES.tooManyRequests };
  }

  const result = await verifyOtp(email, 'reset', code, context);

  switch (result.status) {
    case 'ok':
      return { status: 'ok', ticket: result.ticket };
    case 'expired':
      return { status: 'failed', message: AUTH_MESSAGES.otpExpired };
    case 'too_many_attempts':
      return { status: 'failed', message: AUTH_MESSAGES.otpTooManyAttempts };
    case 'no_challenge':
      return { status: 'failed', message: AUTH_MESSAGES.otpNoChallenge };
    default:
      return { status: 'failed', message: AUTH_MESSAGES.otpInvalid };
  }
}

export type CompleteResetResult =
  | { status: 'ok' }
  | { status: 'failed'; message: string };

/**
 * Step 3 — set the new password.
 *
 * Reset can NEVER create an account: if no profile exists for this address the
 * flow stops. Nothing is created, and the message stays neutral.
 */
export async function completePasswordReset(params: {
  email: string;
  ticket: string;
  password: string;
  confirmPassword: string;
  context: RequestContext;
}): Promise<CompleteResetResult> {
  const email = params.email.trim().toLowerCase();

  if (params.password !== params.confirmPassword) {
    return { status: 'failed', message: AUTH_MESSAGES.passwordsDoNotMatch };
  }

  // Validate BEFORE spending the ticket. It is single-use, so redeeming it
  // ahead of a check that can fail for an ordinary reason (weak or breached
  // password) would strand the user on "verification expired" with no way to
  // retry. Same fix as the signup flow.
  const passwordCheck = await validatePassword(params.password, email);
  if (!passwordCheck.ok) {
    return { status: 'failed', message: passwordCheck.message };
  }

  const admin = supabaseAdmin();

  // Resolve the user without ever exposing whether they exist.
  const { data: profiles, error: lookupError } = await admin
    .from('profiles')
    .select('id, status, deleted_at')
    .eq('email', email)
    .is('deleted_at', null)
    .limit(1);

  if (lookupError) {
    console.error('[reset] profile lookup failed', lookupError.message);
    return { status: 'failed', message: AUTH_MESSAGES.unexpected };
  }

  const profile = profiles?.[0];
  if (!profile) {
    return { status: 'failed', message: AUTH_MESSAGES.verificationExpired };
  }

  const ticketValid = await redeemTicket(email, 'reset', params.ticket);
  if (!ticketValid) {
    return { status: 'failed', message: AUTH_MESSAGES.verificationExpired };
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(profile.id, {
    password: params.password,
  });
  if (updateError) {
    console.error('[reset] password update failed', updateError.message);
    return { status: 'failed', message: AUTH_MESSAGES.unexpected };
  }

  await revokeOtherSessions(profile.id);

  await logAuthEvent({
    event: AUTH_EVENTS.passwordResetCompleted,
    actorId: profile.id,
    email,
    context: params.context,
  });

  return { status: 'ok' };
}

/**
 * Invalidates every other session for a user.
 *
 * Two mechanisms, and both are needed:
 *   1. `signOut(userId, 'others')` revokes the other REFRESH tokens
 *   2. the `sessions_valid_from` epoch invalidates already-issued ACCESS tokens
 *
 * Without (2), a device holding a valid access token would keep working until
 * that token expired — up to an hour after the password changed.
 */
export async function revokeOtherSessions(userId: string): Promise<void> {
  const admin = supabaseAdmin();
  await admin.rpc('revoke_other_sessions', { p_user_id: userId });
  await admin.auth.admin.signOut(userId, 'others').catch(() => undefined);
}

/** Password change for an already-signed-in user. */
export async function changePassword(params: {
  userId: string;
  email: string;
  password: string;
  confirmPassword: string;
  context: RequestContext;
}): Promise<CompleteResetResult> {
  if (params.password !== params.confirmPassword) {
    return { status: 'failed', message: AUTH_MESSAGES.passwordsDoNotMatch };
  }

  const passwordCheck = await validatePassword(params.password, params.email);
  if (!passwordCheck.ok) {
    return { status: 'failed', message: passwordCheck.message };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({ password: params.password });
  if (error) {
    return { status: 'failed', message: AUTH_MESSAGES.unexpected };
  }

  await revokeOtherSessions(params.userId);

  await logAuthEvent({
    event: AUTH_EVENTS.passwordChanged,
    actorId: params.userId,
    email: params.email,
    context: params.context,
  });

  return { status: 'ok' };
}
