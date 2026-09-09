/**
 * Shared OTP machinery for both signup and password reset.
 *
 * Both flows use identical code hygiene (spec §5: "same hygiene rules as
 * signup"), so it lives here once. What differs between them — whether an
 * invite is required, and whether the response is explicit or neutral — stays
 * in the individual flows.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  generateOtpCode,
  hashOtpCode,
  generateTicket,
  hashTicket,
  toPostgresBytea,
  normaliseOtpInput,
  OTP_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  TICKET_TTL_SECONDS,
} from '@/lib/security/otp';
import { sendOtpEmail } from '@/lib/email/send';
import { logAuthEvent, AUTH_EVENTS } from '@/lib/audit/log';
import type { RequestContext } from '@/lib/security/request';

export type OtpPurpose = 'signup' | 'reset';

export type IssueOutcome =
  | { status: 'sent' }
  | { status: 'cooldown'; retryAfterSeconds: number }
  | { status: 'send_failed' };

/**
 * Issues a code and emails it.
 *
 * The cooldown is enforced against DATABASE time, not a client clock.
 * If the email fails to send we report it, so the caller can surface a real
 * error rather than leaving the user waiting for a code that never arrives.
 */
export async function issueOtp(
  email: string,
  purpose: OtpPurpose,
  context: RequestContext,
): Promise<IssueOutcome> {
  const normalised = email.trim().toLowerCase();
  const code = generateOtpCode();

  const { data, error } = await supabaseAdmin().rpc('issue_otp_challenge', {
    p_email: normalised,
    p_purpose: purpose,
    p_code_hash: toPostgresBytea(hashOtpCode(code)),
    p_ttl_seconds: OTP_TTL_SECONDS,
    p_cooldown_seconds: OTP_RESEND_COOLDOWN_SECONDS,
    p_ip: context.ip,
  });

  if (error || !data || data.length === 0) {
    console.error('[otp] issue failed', error?.message);
    return { status: 'send_failed' };
  }

  const row = data[0] as { issued: boolean; cooldown_remaining: number };

  if (!row.issued) {
    await logAuthEvent({
      event: AUTH_EVENTS.otpCooldown,
      email: normalised,
      context,
      metadata: { purpose },
    });
    return { status: 'cooldown', retryAfterSeconds: row.cooldown_remaining };
  }

  const sent = await sendOtpEmail(normalised, code, purpose);

  if (!sent.ok) {
    // Roll the challenge back so the user can retry immediately rather than
    // sitting out a 60-second cooldown for a code that was never delivered.
    await supabaseAdmin().rpc('issue_otp_challenge', {
      p_email: normalised,
      p_purpose: purpose,
      p_code_hash: toPostgresBytea(hashOtpCode(generateOtpCode())),
      p_ttl_seconds: 0,
      p_cooldown_seconds: 0,
      p_ip: context.ip,
    });
    console.error('[otp] email send failed', sent.error);
    return { status: 'send_failed' };
  }

  await logAuthEvent({
    event: AUTH_EVENTS.otpRequested,
    email: normalised,
    context,
    metadata: { purpose },
  });

  return { status: 'sent' };
}

export type VerifyOutcome =
  | { status: 'ok'; ticket: string }
  | { status: 'invalid'; attemptsRemaining: number }
  | { status: 'expired' }
  | { status: 'too_many_attempts' }
  | { status: 'no_challenge' };

/**
 * Verifies a submitted code.
 *
 * The check-and-consume is a single atomic database operation, so two
 * concurrent submissions of a valid code cannot both succeed — the spec's
 * "OTPs are single-use; double-submission is rejected".
 *
 * On success the caller receives a ticket. Only its HASH is stored, and it is
 * good for one use within 15 minutes.
 */
export async function verifyOtp(
  email: string,
  purpose: OtpPurpose,
  submittedCode: string,
  context: RequestContext,
): Promise<VerifyOutcome> {
  const normalised = email.trim().toLowerCase();
  const code = normaliseOtpInput(submittedCode);
  const ticket = generateTicket();

  const { data, error } = await supabaseAdmin().rpc('verify_otp_challenge', {
    p_email: normalised,
    p_purpose: purpose,
    p_code_hash: toPostgresBytea(hashOtpCode(code)),
    p_ticket_hash: toPostgresBytea(hashTicket(ticket)),
    p_max_attempts: OTP_MAX_ATTEMPTS,
    p_ticket_ttl_seconds: TICKET_TTL_SECONDS,
  });

  if (error || !data || data.length === 0) {
    console.error('[otp] verify failed', error?.message);
    return { status: 'no_challenge' };
  }

  const row = data[0] as { ok: boolean; reason: string; attempts_remaining: number };

  if (row.ok) {
    await logAuthEvent({
      event: AUTH_EVENTS.otpVerified,
      email: normalised,
      context,
      metadata: { purpose },
    });
    return { status: 'ok', ticket };
  }

  await logAuthEvent({
    event: AUTH_EVENTS.otpFailed,
    email: normalised,
    context,
    metadata: { purpose, reason: row.reason },
  });

  switch (row.reason) {
    case 'EXPIRED':
      return { status: 'expired' };
    case 'TOO_MANY_ATTEMPTS':
      return { status: 'too_many_attempts' };
    case 'NO_CHALLENGE':
      return { status: 'no_challenge' };
    default:
      return { status: 'invalid', attemptsRemaining: row.attempts_remaining ?? 0 };
  }
}

/**
 * Redeems a ticket. Single-use — a second call with the same ticket fails,
 * which is what stops a replayed password-set step.
 */
export async function redeemTicket(
  email: string,
  purpose: OtpPurpose,
  ticket: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('redeem_signup_ticket', {
    p_email: email.trim().toLowerCase(),
    p_purpose: purpose,
    p_ticket_hash: toPostgresBytea(hashTicket(ticket)),
  });

  if (error) {
    console.error('[otp] ticket redeem failed', error.message);
    return false;
  }
  return data === true;
}
