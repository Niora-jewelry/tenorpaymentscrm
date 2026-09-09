/**
 * Server-only environment.
 *
 * `server-only` makes importing this from a client component a build error.
 * That is the guard that stops SUPABASE_SERVICE_ROLE_KEY or OTP_PEPPER from
 * ever reaching a browser bundle.
 *
 * NEVER import this file from `src/middleware.ts` — middleware runs on the Edge
 * runtime and must never hold the service-role key.
 */
import 'server-only';
import { z } from 'zod';

const serverSchema = z.object({
  /** Bypasses RLS entirely. Trusted server code only. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  /**
   * HMAC key for OTP hashing. 32 random bytes, base64.
   * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  OTP_PEPPER: z.string().min(32),

  /**
   * Symmetric key for Logins password envelope encryption (pgp_sym_encrypt/
   * decrypt, called from `store_login_password`/`reveal_password`). Same
   * posture as OTP_PEPPER — a server env secret today, not a database-stored
   * key; KMS-backed rotation is explicitly deferred (Module 2 plan, "the 19
   * August amendment... uses a server env secret today").
   * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  LOGIN_ENC_KEY: z.string().min(32),

  /**
   * Transactional email. Supabase's built-in SMTP is dev-only (spec §8).
   *
   * A blank value is treated as "not configured" rather than invalid, so local
   * development works with an empty key — codes print to the server console.
   * In production a missing key makes sending fail LOUDLY; it never silently
   * swallows a login code.
   */
  RESEND_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  EMAIL_FROM: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : 'TapDash <no-reply@example.com>')),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = serverSchema.safeParse({
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  OTP_PEPPER: process.env.OTP_PEPPER,
  LOGIN_ENC_KEY: process.env.LOGIN_ENC_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  NODE_ENV: process.env.NODE_ENV,
});

if (!parsed.success) {
  throw new Error(
    `Invalid server environment variables:\n${z.prettifyError(parsed.error)}`,
  );
}

export const serverEnv = parsed.data;

export const isProduction = serverEnv.NODE_ENV === 'production';
