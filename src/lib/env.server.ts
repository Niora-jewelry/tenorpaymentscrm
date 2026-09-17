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

/** Blank is "not configured", not invalid — same posture as RESEND_API_KEY. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

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

  /**
   * Twilio — the phone module.
   *
   * All five are OPTIONAL at the schema level so the rest of the CRM boots
   * without them. Telephony is a feature that can be switched off by removing
   * its configuration, exactly like RESEND_API_KEY above; a missing key must
   * not stop someone signing in.
   *
   * `phoneConfigured` below is the single place that decides whether the
   * feature is on, so no call site has to re-derive it from five separate
   * checks and get it subtly wrong.
   */
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_API_KEY_SID: optionalString,
  TWILIO_API_KEY_SECRET: optionalString,
  TWILIO_TWIML_APP_SID: optionalString,
  /**
   * ⚠ NOT the API key secret. Webhook signatures are HMAC-SHA1 with the
   * ACCOUNT auth token, and this was missing from the original handoff list —
   * `isValidTwilioSignature` fails CLOSED without it, so every signed webhook
   * route rejects its request and the whole callback surface stops. Correct,
   * but total, and it looks like Twilio being broken rather than a missing
   * variable.
   */
  TWILIO_AUTH_TOKEN: optionalString,

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = serverSchema.safeParse({
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  OTP_PEPPER: process.env.OTP_PEPPER,
  LOGIN_ENC_KEY: process.env.LOGIN_ENC_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET,
  TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  NODE_ENV: process.env.NODE_ENV,
});

if (!parsed.success) {
  throw new Error(
    `Invalid server environment variables:\n${z.prettifyError(parsed.error)}`,
  );
}

export const serverEnv = parsed.data;

export const isProduction = serverEnv.NODE_ENV === 'production';

/**
 * Is the phone module configured?
 *
 * One definition, so a half-configured deployment fails the same way
 * everywhere instead of half-working. The browser Device needs the three token
 * variables; the webhooks need the auth token; the TwiML app ties the Device
 * to the voice route. Missing any one of them means telephony is off, not
 * degraded.
 */
export const phoneConfigured = Boolean(
  serverEnv.TWILIO_ACCOUNT_SID &&
    serverEnv.TWILIO_API_KEY_SID &&
    serverEnv.TWILIO_API_KEY_SECRET &&
    serverEnv.TWILIO_TWIML_APP_SID &&
    serverEnv.TWILIO_AUTH_TOKEN,
);
