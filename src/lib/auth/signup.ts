/**
 * Invite-only signup.
 *
 * Spec §2: "A user can only complete signup if a valid, unconsumed invite exists
 * for their email. Enforced at the API layer — the signup endpoint is publicly
 * reachable and must reject uninvited emails regardless of what the UI shows."
 *
 * ATOMICITY (spec §4): the auth.users row is created ONLY when a password is
 * actually set. Abandoning after the OTP therefore leaves no account at all and
 * the invite stays `pending` — "no half-usable account may exist".
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { validatePassword } from '@/lib/security/password';
import { logAuthEvent, AUTH_EVENTS } from '@/lib/audit/log';
import { rateLimitAll, RATE_LIMITS, emailKey, ipKey } from '@/lib/security/rate-limit';
import { issueOtp, verifyOtp, redeemTicket } from '@/lib/auth/otp-flow';
import { AUTH_MESSAGES } from '@/lib/auth/messages';
import type { RequestContext } from '@/lib/security/request';

export type StartSignupResult =
  | { status: 'otp_sent' }
  | { status: 'not_invited'; message: string }
  | { status: 'already_registered'; message: string }
  | { status: 'cooldown'; message: string }
  | { status: 'rate_limited'; message: string }
  | { status: 'error'; message: string };

/**
 * Step 1 — email in, code out.
 *
 * The three outcomes are exactly as specified. Note that this deliberately
 * DISCLOSES invite status (Decision A). Rate limiting is what stops that
 * accepted, targeted disclosure from becoming a bulk enumeration API.
 */
export async function startSignup(
  rawEmail: string,
  context: RequestContext,
): Promise<StartSignupResult> {
  const email = rawEmail.trim().toLowerCase();

  const limit = await rateLimitAll([
    { key: emailKey('signup_otp', email), rule: RATE_LIMITS.signupOtpPerEmail },
    { key: ipKey('signup_otp', context.ip), rule: RATE_LIMITS.signupOtpPerIp },
  ]);
  if (!limit.allowed) {
    await logAuthEvent({
      event: AUTH_EVENTS.otpRateLimited,
      email,
      context,
      metadata: { purpose: 'signup' },
    });
    return { status: 'rate_limited', message: AUTH_MESSAGES.tooManyRequests };
  }

  const admin = supabaseAdmin();

  // Already has an account -> send them to /login. No code is sent. (spec §4)
  const { data: registered, error: registeredError } = await admin.rpc(
    'email_is_registered',
    { p_email: email },
  );
  if (registeredError) {
    console.error('[signup] registration check failed', registeredError.message);
    return { status: 'error', message: AUTH_MESSAGES.unexpected };
  }
  if (registered === true) {
    return { status: 'already_registered', message: AUTH_MESSAGES.alreadyRegistered };
  }

  // No pending, unexpired invite -> explicit message, no code sent. (spec §4)
  const { data: invites, error: inviteError } = await admin.rpc('find_pending_invite', {
    p_email: email,
  });
  if (inviteError) {
    console.error('[signup] invite lookup failed', inviteError.message);
    return { status: 'error', message: AUTH_MESSAGES.unexpected };
  }
  if (!invites || invites.length === 0) {
    await logAuthEvent({ event: AUTH_EVENTS.signupNoInvite, email, context });
    return { status: 'not_invited', message: AUTH_MESSAGES.notInvited };
  }

  const issued = await issueOtp(email, 'signup', context);
  if (issued.status === 'cooldown') {
    return {
      status: 'cooldown',
      message: AUTH_MESSAGES.otpResendCooldown(issued.retryAfterSeconds),
    };
  }
  if (issued.status === 'send_failed') {
    return { status: 'error', message: AUTH_MESSAGES.emailSendFailed };
  }

  return { status: 'otp_sent' };
}

export type VerifySignupOtpResult =
  | { status: 'ok'; ticket: string }
  | { status: 'failed'; message: string };

/** Step 2 — verify the code, hand back a single-use ticket. */
export async function verifySignupOtp(
  rawEmail: string,
  code: string,
  context: RequestContext,
): Promise<VerifySignupOtpResult> {
  const email = rawEmail.trim().toLowerCase();

  const limit = await rateLimitAll([
    { key: emailKey('otp_verify', email), rule: RATE_LIMITS.otpVerifyPerEmail },
  ]);
  if (!limit.allowed) {
    return { status: 'failed', message: AUTH_MESSAGES.tooManyRequests };
  }

  const result = await verifyOtp(email, 'signup', code, context);

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

export type CompleteSignupResult =
  | { status: 'ok'; userId: string }
  | { status: 'failed'; message: string };

/**
 * Step 3 — set the password and create the account.
 *
 * ORDERING IS DELIBERATE, and was wrong in the first version:
 *   1. passwords match
 *   2. password meets policy
 *   3. invite is still valid  (spec: "Invite expired or revoked mid-flow ->
 *      clear error, flow halts" — checked HERE, not only at OTP time)
 *   4. redeem the ticket      <- LAST of the checks, immediately before use
 *   5. create the auth user
 *   6. create the profile + accept the invite, in ONE transaction
 *
 * The ticket is single-use, so redeeming it before the password was validated
 * meant a rejected password burned it: the user then saw "your verification
 * expired" on every retry, with no way forward. Every check that can fail for
 * an ordinary, recoverable reason now runs first, so a retry is always possible.
 *
 * Single-use is not weakened — the ticket is still consumed exactly once, at
 * the point it is actually relied upon.
 *
 * If step 6 fails, the auth user from step 5 is deleted, so a failure can never
 * leave a login with no profile behind it.
 */
export async function completeSignup(params: {
  email: string;
  ticket: string;
  password: string;
  confirmPassword: string;
  fullName?: string;
  context: RequestContext;
}): Promise<CompleteSignupResult> {
  const email = params.email.trim().toLowerCase();

  if (params.password !== params.confirmPassword) {
    return { status: 'failed', message: AUTH_MESSAGES.passwordsDoNotMatch };
  }

  const passwordCheck = await validatePassword(params.password, email);
  if (!passwordCheck.ok) {
    return { status: 'failed', message: passwordCheck.message };
  }

  const admin = supabaseAdmin();

  const { data: invites, error: inviteError } = await admin.rpc('find_pending_invite', {
    p_email: email,
  });
  if (inviteError || !invites || invites.length === 0) {
    return { status: 'failed', message: AUTH_MESSAGES.inviteNoLongerValid };
  }

  // Everything recoverable has passed. Spend the ticket now.
  const ticketValid = await redeemTicket(email, 'signup', params.ticket);
  if (!ticketValid) {
    return { status: 'failed', message: AUTH_MESSAGES.verificationExpired };
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: params.password,
    email_confirm: true, // the OTP already proved control of this address
  });

  if (createError || !created.user) {
    console.error('[signup] user creation failed', createError?.message);
    return { status: 'failed', message: AUTH_MESSAGES.unexpected };
  }

  const userId = created.user.id;

  const { error: profileError } = await admin.rpc('complete_signup', {
    p_user_id: userId,
    p_email: email,
    p_full_name: params.fullName ?? null,
  });

  if (profileError) {
    // Never leave an auth user with no profile.
    await admin.auth.admin.deleteUser(userId).catch(() => undefined);
    console.error('[signup] profile creation failed', profileError.message);
    const message =
      profileError.message.includes('INVITE_NOT_VALID')
        ? AUTH_MESSAGES.inviteNoLongerValid
        : AUTH_MESSAGES.unexpected;
    return { status: 'failed', message };
  }

  await logAuthEvent({
    event: AUTH_EVENTS.signupCompleted,
    actorId: userId,
    email,
    context: params.context,
  });
  await logAuthEvent({
    event: AUTH_EVENTS.inviteAccepted,
    actorId: userId,
    email,
    context: params.context,
  });

  return { status: 'ok', userId };
}
