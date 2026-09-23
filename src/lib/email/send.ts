/**
 * Transactional email, over SMTP.
 *
 * Spec 8: "OTP and invite emails require a production-grade transactional
 * sender from day one - Supabase's built-in SMTP is dev-only. Configure a
 * dedicated provider (Resend or Postmark recommended)."
 *
 * Resend and Postmark were the spec's SUGGESTIONS. The client supplied a
 * Microsoft 365 mailbox instead, so that is what this sends through. The
 * requirement the sentence actually makes - a real sender, not Supabase's
 * dev SMTP - is met either way.
 *
 * OTP mail carries a CODE, never a link. Nothing in the message is a bearer
 * token that survives forwarding, and there is no link to phish.
 *
 * -- WHY NODEMAILER AND NOT A HAND-ROLLED SOCKET --------------------------
 * A raw SMTP conversation is easy to get working and hard to get right:
 * header folding, quoted-printable for non-ASCII subjects, dot-stuffing a
 * body line that begins with ".", CRLF discipline, connection reuse. Every
 * one of those is a silent corruption rather than an error, and a mangled
 * login code is indistinguishable from a wrong one. This is a solved problem
 * and not worth re-solving inside an auth path.
 *
 * -- THE TRANSPORT IS CREATED ONCE ---------------------------------------
 * `pool: true` keeps one authenticated connection rather than reconnecting
 * per message. Microsoft throttles aggressively on new connections, and OTP
 * sends arrive in bursts (request, resend, a colleague signing up minutes
 * later).
 */
import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';
import { serverEnv, isProduction } from '@/lib/env.server';
import { OTP_TTL_SECONDS } from '@/lib/security/otp';

let transport: Transporter | null = null;

function client(): Transporter | null {
  /*
   * THE TEST SUITE NEVER SENDS REAL MAIL.
   *
   * `flow.integration.test.ts` drives the genuine signup path against the live
   * database using addresses at @tapdash.test, which is not a real domain. The
   * moment SMTP was configured those tests began failing at RCPT TO — the
   * server was right to reject them, and the suite was right to notice, but a
   * test run must not be attempting delivery to invented addresses at all.
   *
   * Checked before the host so it holds however the environment is configured.
   */
  if (serverEnv.NODE_ENV === 'test') return null;

  // The host is the switch. Without it there is no mail provider at all, and
  // the caller falls back to printing the code locally.
  if (!serverEnv.SMTP_HOST) return null;

  transport ??= nodemailer.createTransport({
    host: serverEnv.SMTP_HOST,
    port: serverEnv.SMTP_PORT,
    /*
     * `secure: false` with port 587 means STARTTLS, not plaintext - the
     * connection opens unencrypted and is upgraded before AUTH. Microsoft 365
     * does not offer implicit TLS on 465, so 587 + STARTTLS is the only shape
     * that works there. `requireTLS` makes the upgrade mandatory rather than
     * opportunistic, so a server that declines it fails instead of sending
     * the password in the clear.
     */
    secure: serverEnv.SMTP_PORT === 465,
    requireTLS: serverEnv.SMTP_PORT !== 465,
    auth: { user: serverEnv.SMTP_USER, pass: serverEnv.SMTP_PASSWORD },
    pool: true,
    maxConnections: 2,
    // An auth path must not hang on a slow mail server. Failing in seconds
    // and telling the user beats a request that never returns.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transport;
}

export type SendResult = { ok: true } | { ok: false; error: string };

async function send(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  const api = client();

  if (!api) {
    if (isProduction) {
      /*
       * Silently "succeeding" here would mean users never receive codes while
       * the app reports success. Fail loudly instead.
       *
       * -- AND SAY SO IN THE LOG ------------------------------------------
       * This branch used to return without a word, which made it the hardest
       * of the failure modes to diagnose: the user sees the same polite
       * "try again in a moment" they would see for a rejected password or a
       * throttled connection, and the server says nothing to tell the three
       * apart. It is also the likeliest of them, because it is what a
       * deployment with the variables unset does, and what a long-running
       * process started BEFORE they were set does -- the environment is read
       * once at boot, so editing .env under a running server changes nothing
       * until it is restarted.
       */
      const missing = (
        [
          ['SMTP_HOST', serverEnv.SMTP_HOST],
          ['SMTP_USER', serverEnv.SMTP_USER],
          ['SMTP_PASSWORD', serverEnv.SMTP_PASSWORD],
        ] as const
      )
        .filter(([, v]) => !v)
        .map(([k]) => k);

      console.error(
        '[email] not configured - nothing was sent.',
        missing.length
          ? `Missing in this process's environment: ${missing.join(', ')}. ` +
              'If these are set in .env, the server was started before they were ' +
              'added and needs restarting; on a hosted deployment they must be set ' +
              'in the project settings and the app redeployed.'
          : 'The transport could not be created.',
        { to, subject },
      );
      return { ok: false, error: 'Email is not configured' };
    }
    /*
     * Local development without a key: print the mail so the flow is testable
     * without a verified sending domain. Boxed and loud, because a 6-digit code
     * buried in Next.js request logs is genuinely hard to spot.
     */
    const code = text.match(/Your code:\s*(\d{6})/)?.[1];
    const line = '─'.repeat(52);
    console.info(
      [
        '',
        `┌${line}┐`,
        `  EMAIL (dev - no SMTP_HOST set, nothing was sent)`,
        `  To:      ${to}`,
        `  Subject: ${subject}`,
        code ? `  CODE:    ${code}` : '',
        `└${line}┘`,
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return { ok: true };
  }

  try {
    await api.sendMail({ from: serverEnv.EMAIL_FROM, to, subject, html, text });
    return { ok: true };
  } catch (cause) {
    /*
     * Reported, never thrown. The caller decides what the user sees, and an
     * OTP request that 500s tells an attacker more than one that fails
     * politely. The reason is logged server-side because "email is not
     * arriving" is otherwise a blind investigation - a rejected app password
     * and a throttled connection look identical from the outside.
     */
    const error = cause instanceof Error ? cause.message : 'Send failed';
    console.error('[email] SMTP send failed', { to, subject, error });
    return { ok: false, error };
  }
}

const MINUTES = Math.round(OTP_TTL_SECONDS / 60);

function codeEmailHtml(code: string, purpose: 'signup' | 'reset'): string {
  const heading = purpose === 'signup' ? 'Finish setting up your account' : 'Reset your password';
  return `<!doctype html>
<html><body style="margin:0;padding:32px;background:#f6f9fb;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#08202f">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d9e3ec;border-radius:12px;padding:32px">
    <h1 style="margin:0 0 8px;font-size:20px;font-weight:600">${heading}</h1>
    <p style="margin:0 0 24px;color:#5e7a8d;font-size:15px;line-height:1.6">
      Enter this code to continue. It expires in ${MINUTES} minutes and can only be used once.
    </p>
    <div style="font-family:Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:.22em;
                background:#eef3f8;border:1px solid #d9e3ec;border-radius:10px;
                padding:18px;text-align:center;color:#08202f">${code}</div>
    <p style="margin:24px 0 0;color:#5e7a8d;font-size:13px;line-height:1.6">
      If you didn't request this, you can ignore this email — nothing will change.
      Never share this code with anyone.
    </p>
  </div>
</body></html>`;
}

function codeEmailText(code: string, purpose: 'signup' | 'reset'): string {
  const heading = purpose === 'signup' ? 'Finish setting up your account' : 'Reset your password';
  return [
    heading,
    '',
    `Your code: ${code}`,
    '',
    `It expires in ${MINUTES} minutes and can only be used once.`,
    "If you didn't request this, ignore this email. Never share this code with anyone.",
  ].join('\n');
}

export function sendOtpEmail(
  to: string,
  code: string,
  purpose: 'signup' | 'reset',
): Promise<SendResult> {
  const subject =
    purpose === 'signup' ? 'Your TapDash signup code' : 'Your TapDash password reset code';
  return send(to, subject, codeEmailHtml(code, purpose), codeEmailText(code, purpose));
}
