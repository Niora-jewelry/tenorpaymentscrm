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
   * Transactional email, over SMTP.
   *
   * Spec 8 asked for "a production-grade transactional sender" and named
   * Resend as a suggestion, not a requirement. The client supplied a Microsoft
   * 365 mailbox instead, so that is what this sends through: verified working
   * on smtp-mail.outlook.com:587 with STARTTLS and an app password.
   *
   * A blank host is treated as "not configured" rather than invalid, so local
   * development works with nothing set - codes print to the server console
   * instead. In production a missing host makes sending fail LOUDLY; it never
   * silently swallows a login code.
   *
   * SMTP_PASSWORD is an APP PASSWORD, not the mailbox password. Microsoft
   * refuses the account password outright once MFA is on, which is the failure
   * that looks like "wrong credentials" and is not.
   */
  SMTP_HOST: optionalString,
  SMTP_PORT: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt((v ?? '').trim(), 10);
      // 587 is the submission port and the one Microsoft 365 supports.
      // Anything unparseable falls back rather than throwing, because a typo
      // here must not stop the whole app booting.
      return Number.isFinite(n) && n > 0 ? n : 587;
    }),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
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

  /**
   * The Email module — Outlook / Microsoft 365 over Microsoft Graph.
   *
   * Optional for the same reason Twilio's are: the CRM must boot without
   * them, and `mailConfigured` below is the single switch. Delegated
   * permissions only — the app can never reach a mailbox nobody connected.
   *
   *   MAIL_CLIENT_ID / MAIL_CLIENT_SECRET   the Azure app registration
   *   MAIL_STATE_SIGNING_SECRET              HMAC key for the OAuth state cookie
   *   MAIL_TOKEN_ENC_KEY                     AES-256-GCM key for stored refresh/access
   *                                          tokens, 32 random bytes base64. Kept OUT of
   *                                          the database on purpose: the DB URL is in
   *                                          every script and test, and a leaked one must
   *                                          yield ciphertext only. Changing it orphans
   *                                          every stored token — rotate with the script.
   *   CRON_SECRET                            Vercel sends it as `Authorization: Bearer` on
   *                                          cron calls; the tick route checks it.
   */
  MAIL_CLIENT_ID: optionalString,
  MAIL_CLIENT_SECRET: optionalString,
  MAIL_STATE_SIGNING_SECRET: optionalString,
  MAIL_TOKEN_ENC_KEY: optionalString,
  /** Comma-separated Entra tenant ids allowed to connect. Blank = any work tenant. */
  MAIL_ALLOWED_TENANT_IDS: optionalString,
  /** Override for a local tunnel only. Default: `${NEXT_PUBLIC_APP_URL}/api/mail/oauth/callback`. */
  MAIL_REDIRECT_URI: optionalString,
  /** Graph change notifications. Only 'true' turns them on, and only in production. */
  MAIL_WEBHOOKS_ENABLED: optionalString,
  /** Kill switch: 'false' hides the module without touching configuration. */
  MAIL_MODULE_ENABLED: optionalString,
  /** 'graph' (default) or 'mock' — the local Graph stand-in. Refused in production. */
  MAIL_PROVIDER: z.enum(['graph', 'mock']).optional(),
  MAIL_MOCK_BASE_URL: optionalString,
  /** ISO date the Azure client secret expires, for the 30-day warning. */
  MAIL_CLIENT_SECRET_EXPIRES_AT: optionalString,
  CRON_SECRET: optionalString,

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = serverSchema.safeParse({
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  OTP_PEPPER: process.env.OTP_PEPPER,
  LOGIN_ENC_KEY: process.env.LOGIN_ENC_KEY,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  EMAIL_FROM: process.env.EMAIL_FROM,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID: process.env.TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET: process.env.TWILIO_API_KEY_SECRET,
  TWILIO_TWIML_APP_SID: process.env.TWILIO_TWIML_APP_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  MAIL_CLIENT_ID: process.env.MAIL_CLIENT_ID,
  MAIL_CLIENT_SECRET: process.env.MAIL_CLIENT_SECRET,
  MAIL_STATE_SIGNING_SECRET: process.env.MAIL_STATE_SIGNING_SECRET,
  MAIL_TOKEN_ENC_KEY: process.env.MAIL_TOKEN_ENC_KEY,
  MAIL_ALLOWED_TENANT_IDS: process.env.MAIL_ALLOWED_TENANT_IDS,
  MAIL_REDIRECT_URI: process.env.MAIL_REDIRECT_URI,
  MAIL_WEBHOOKS_ENABLED: process.env.MAIL_WEBHOOKS_ENABLED,
  MAIL_MODULE_ENABLED: process.env.MAIL_MODULE_ENABLED,
  MAIL_PROVIDER: process.env.MAIL_PROVIDER || undefined,
  MAIL_MOCK_BASE_URL: process.env.MAIL_MOCK_BASE_URL,
  MAIL_CLIENT_SECRET_EXPIRES_AT: process.env.MAIL_CLIENT_SECRET_EXPIRES_AT,
  CRON_SECRET: process.env.CRON_SECRET,
  NODE_ENV: process.env.NODE_ENV,
});

if (!parsed.success) {
  throw new Error(
    `Invalid server environment variables:\n${z.prettifyError(parsed.error)}`,
  );
}

export const serverEnv = parsed.data;

export const isProduction = serverEnv.NODE_ENV === 'production';

/*
 * The mock Graph server is a development and CI tool. In production it would
 * mean every mailbox action talks to a fake — refused at boot rather than
 * discovered later, the same posture as the demo-auth switch.
 */
if (isProduction && serverEnv.MAIL_PROVIDER === 'mock') {
  throw new Error('MAIL_PROVIDER=mock is not allowed in production.');
}

/** Which Graph the Email module talks to. */
export const mailProvider: 'graph' | 'mock' = serverEnv.MAIL_PROVIDER ?? 'graph';

/**
 * Is the Email module configured?
 *
 * One definition, like `phoneConfigured`. The module needs the Azure app
 * (id + secret), the state-signing key and the token-encryption key; without
 * any one of them connecting a mailbox cannot work, so the module is off
 * rather than half on. The mock provider replaces the Azure app outside
 * production, but still needs the two keys — they protect real data paths.
 */
export const mailConfigured =
  serverEnv.MAIL_MODULE_ENABLED !== 'false' &&
  Boolean(serverEnv.MAIL_STATE_SIGNING_SECRET && serverEnv.MAIL_TOKEN_ENC_KEY) &&
  (mailProvider === 'mock'
    ? Boolean(serverEnv.MAIL_MOCK_BASE_URL)
    : Boolean(serverEnv.MAIL_CLIENT_ID && serverEnv.MAIL_CLIENT_SECRET));

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
