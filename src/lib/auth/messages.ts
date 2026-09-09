/**
 * Every user-facing auth string, in one place.
 *
 * Centralised because the spec's disclosure posture is deliberate and asymmetric,
 * and a well-meaning edit in one screen could quietly break it:
 *
 *   - SIGNUP is EXPLICIT. It tells the user their email was not invited
 *     (Decision A: "explicit over neutral; the invite-status leak is accepted
 *     for clearer UX").
 *   - LOGIN is NEUTRAL. "never reveals whether the email exists."
 *   - RESET is NEUTRAL. "never confirms whether an account exists."
 *
 * Do not "helpfully" align these. The difference is the specification.
 */

export const AUTH_MESSAGES = {
  // --- Login: neutral, always the same string --------------------------------
  invalidCredentials: 'Invalid email or password',

  // --- Signup: explicit, by accepted decision --------------------------------
  notInvited: "This email hasn't been invited — contact your administrator.",
  alreadyRegistered: 'You already have an account. Sign in below.',

  // --- Reset: neutral. Identical whether or not the account exists -----------
  resetRequested:
    'If that email has an account, a reset code is on its way. Check your inbox.',

  // --- OTP -------------------------------------------------------------------
  otpSent: 'We sent a 6-digit code to your email. It expires in 10 minutes.',
  otpInvalid: 'That code is not correct. Check it and try again.',
  otpExpired: 'That code has expired. Request a new one.',
  otpTooManyAttempts: 'Too many incorrect attempts. Request a new code.',
  otpNoChallenge: 'Request a code before entering one.',
  otpResendCooldown: (seconds: number) =>
    `You can request another code in ${seconds} second${seconds === 1 ? '' : 's'}.`,

  // --- Tickets ---------------------------------------------------------------
  verificationExpired: 'Your verification expired. Start again from the beginning.',

  // --- Invites ---------------------------------------------------------------
  inviteNoLongerValid:
    'That invitation is no longer valid. Ask your administrator for a new one.',

  // --- Rate limiting ---------------------------------------------------------
  tooManyRequests: 'Too many attempts. Try again later.',

  // --- Account state ---------------------------------------------------------
  accountSuspended: 'Your account has been paused. Contact your administrator.',

  // --- Generic ---------------------------------------------------------------
  unexpected: 'Something went wrong. Try again.',
  emailSendFailed: "We couldn't send that email. Try again in a moment.",
  passwordsDoNotMatch: 'Both passwords must match.',
  passwordChanged: 'Password updated. You have been signed out on other devices.',
} as const;
