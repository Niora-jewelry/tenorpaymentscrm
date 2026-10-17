/**
 * Rate limiting.
 *
 * The spec specifies only the OTP attempt cap and the resend cooldown. Every
 * limit here beyond those is added, because without them:
 *   - the login endpoint is an unlimited password-guessing oracle
 *   - the signup endpoint is a free mail relay and a bulk invite-existence probe
 *
 * The spec ACCEPTS that signup reveals invite status (Decision A). It does not
 * accept that being turned into an enumeration API — rate limiting is what keeps
 * a targeted disclosure from becoming a bulk one.
 *
 * Backed by Postgres, so no extra infrastructure. Swap for Upstash Redis if
 * request volume ever warrants it; the interface stays the same.
 *
 * FAILS CLOSED: if the limiter errors, the request is denied.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type RateLimitRule = {
  /** Max hits allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

export const RATE_LIMITS = {
  /** Requesting a signup OTP, per email address. */
  signupOtpPerEmail: { limit: 5, windowSeconds: 3600 },
  /** Requesting a signup OTP, per IP. */
  signupOtpPerIp: { limit: 20, windowSeconds: 3600 },
  /** Requesting a password-reset OTP, per email address. */
  resetOtpPerEmail: { limit: 5, windowSeconds: 3600 },
  /** Requesting a password-reset OTP, per IP. */
  resetOtpPerIp: { limit: 20, windowSeconds: 3600 },
  /** Password attempts, per email address. */
  loginPerEmail: { limit: 10, windowSeconds: 900 },
  /** Password attempts, per IP. */
  loginPerIp: { limit: 30, windowSeconds: 900 },
  /** OTP verification submissions, per email. Backstop to the 5-attempt cap. */
  otpVerifyPerEmail: { limit: 15, windowSeconds: 900 },

  /*
   * ── Email module ───────────────────────────────────────────────────────
   * Generous for a person, tight for a script. Sending is the one with a cost
   * outside this app (a mailbox that sends too much is blocked by Microsoft),
   * so it has a daily cap as well as a per-minute one.
   */
  mailSendPerUserMinute: { limit: 30, windowSeconds: 60 },
  mailSendPerUserDay: { limit: 500, windowSeconds: 86400 },
  /** Read/unread, move, delete, pin, folders, rules — each bulk call counts once. */
  mailActionPerUser: { limit: 120, windowSeconds: 60 },
  mailConnectStartPerUser: { limit: 10, windowSeconds: 3600 },
  mailImagePerUser: { limit: 600, windowSeconds: 60 },
  mailAttachmentPerUser: { limit: 120, windowSeconds: 60 },
  mailSearchPerUser: { limit: 60, windowSeconds: 60 },
  mailBackfillPerMailbox: { limit: 6, windowSeconds: 3600 },
  mailTickPerIp: { limit: 120, windowSeconds: 60 },
  mailNotifyPerSubscription: { limit: 600, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

/**
 * Records one hit against `key` and reports whether it is allowed.
 *
 * @param key  Stable identifier, e.g. `login:email:someone@example.com`.
 */
export async function rateLimit(
  key: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  try {
    const { data, error } = await supabaseAdmin().rpc('rate_limit_hit', {
      p_key: key,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });

    if (error || !data || data.length === 0) {
      // Fail closed. A broken limiter must not become an open door.
      return { allowed: false, retryAfterSeconds: rule.windowSeconds };
    }

    const row = data[0] as { allowed: boolean; retry_after_seconds: number };
    return {
      allowed: row.allowed,
      retryAfterSeconds: row.retry_after_seconds ?? rule.windowSeconds,
    };
  } catch {
    return { allowed: false, retryAfterSeconds: rule.windowSeconds };
  }
}

/**
 * Applies several limits at once. All must pass.
 * Every rule is evaluated (not short-circuited) so counters stay accurate.
 */
export async function rateLimitAll(
  checks: Array<{ key: string; rule: RateLimitRule }>,
): Promise<RateLimitResult> {
  const results = await Promise.all(checks.map((c) => rateLimit(c.key, c.rule)));
  const blocked = results.filter((r) => !r.allowed);

  if (blocked.length === 0) return { allowed: true, retryAfterSeconds: 0 };

  return {
    allowed: false,
    retryAfterSeconds: Math.max(...blocked.map((r) => r.retryAfterSeconds)),
  };
}

export function emailKey(scope: string, email: string): string {
  return `${scope}:email:${email.trim().toLowerCase()}`;
}

export function ipKey(scope: string, ip: string | null): string {
  return `${scope}:ip:${ip ?? 'unknown'}`;
}

/** Per signed-in person — the key for actions that already require a session. */
export function userKey(scope: string, userId: string): string {
  return `${scope}:user:${userId}`;
}
