/**
 * The single writer to auth_audit_log.
 *
 * Nothing else in the codebase touches that table. One writer means one place
 * that guarantees redaction, and one place to change if the shape evolves.
 *
 * The table is append-only at the database (UPDATE and DELETE are blocked by
 * trigger and revoked from every role). An audit log an attacker can tidy up is
 * not an audit log.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { redactMetadata } from '@/lib/audit/redact';
import type { RequestContext } from '@/lib/security/request';

export { redactMetadata, REDACTED } from '@/lib/audit/redact';

export const AUTH_EVENTS = {
  loginSuccess: 'login_success',
  loginFailure: 'login_failure',
  loginRateLimited: 'login_rate_limited',
  loginSuspended: 'login_rejected_suspended',
  otpRequested: 'otp_requested',
  otpVerified: 'otp_verified',
  otpFailed: 'otp_failed',
  otpRateLimited: 'otp_rate_limited',
  otpCooldown: 'otp_resend_cooldown',
  signupNoInvite: 'signup_rejected_no_invite',
  signupCompleted: 'signup_completed',
  inviteAccepted: 'invite_accepted',
  passwordChanged: 'password_changed',
  passwordResetCompleted: 'password_reset_completed',
  /* An admin borrowing another account to see what that person sees. Both ends
   * are recorded, naming the admin AND the target, so "who actually did this"
   * stays answerable — the whole reason the feature is safe to hand over. */
  impersonationStarted: 'impersonation_started',
  impersonationEnded: 'impersonation_ended',
  sessionRejectedSuspended: 'session_rejected_suspended',
  sessionRejectedEpoch: 'session_rejected_epoch',
  sessionRejectedIdle: 'session_rejected_idle',
} as const;

export type AuthEvent = (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS];

export type AuditEntry = {
  event: AuthEvent;
  actorId?: string | null;
  email?: string | null;
  context?: RequestContext;
  metadata?: Record<string, unknown>;
};

/**
 * Writes one audit row.
 *
 * Never throws: an audit failure must not break a user's login. It is reported
 * to the server log so the gap is visible.
 */
export async function logAuthEvent(entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin().rpc('log_auth_event', {
      p_event_type: entry.event,
      p_actor_id: entry.actorId ?? null,
      p_email_attempted: entry.email ? entry.email.trim().toLowerCase() : null,
      p_ip: entry.context?.ip ?? null,
      p_user_agent: entry.context?.userAgent ?? null,
      p_metadata: (redactMetadata(entry.metadata ?? {}) ?? {}) as Record<string, unknown>,
    });

    if (error) {
      console.error('[audit] write failed', { event: entry.event, error: error.message });
    }
  } catch (cause) {
    console.error('[audit] write threw', { event: entry.event, cause });
  }
}
