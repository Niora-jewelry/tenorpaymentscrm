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

async function send(
  to: string,
  subject: string,
  html: string,
  text: string,
  headers?: Record<string, string>,
): Promise<SendResult> {
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
    await api.sendMail({ from: serverEnv.EMAIL_FROM, to, subject, html, text, headers });
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

/*
 * -- WHY THIS IS TABLES AND INLINE STYLES ---------------------------------
 * Outlook on Windows renders mail through Word, not a browser. Flexbox, grid
 * and margins on a div are ignored there, and a layout built with them
 * collapses into one left-aligned column. Nested tables with inline styles
 * are the only construction that survives Outlook, Gmail, Apple Mail and the
 * mobile clients alike. It looks dated because it is; it is also the only
 * thing that works everywhere.
 *
 * -- THE LOGO IS DRAWN, NOT LOADED ----------------------------------------
 * There is no TapDash logo file in this repository. The brand mark in the app
 * is CSS: a tinted tile with a "T" in it (`Wordmark` in
 * `src/app/(auth)/ui.tsx`, and the sidebar's brand block). This reproduces
 * that mark with a table cell and a background colour rather than an image,
 * which is better than an image would be for a security email:
 *
 *   - Outlook and many corporate clients block remote images by default, so
 *     an <img> logo renders as a broken placeholder directly above a login
 *     code - which reads as a forgery to a careful user.
 *   - A remote image is a tracking pixel as far as a spam filter is
 *     concerned, and image-heavy mail carrying little text scores worse.
 *   - Nothing to host, so it cannot break when a domain or CDN moves.
 *
 * If a real logo file ever arrives, an <img> can sit here INSTEAD of the
 * tile, but it should keep this markup as its alt fallback.
 */
const BRAND = {
  accent: '#d5ff4a',
  accentInk: '#012740',
  ink: '#08202f',
  muted: '#5e7a8d',
  line: '#d9e3ec',
  canvas: '#f6f9fb',
  panel: '#eef3f8',
} as const;

const FONT = 'Segoe UI,Helvetica,Arial,sans-serif';

function codeEmailHtml(code: string, purpose: 'signup' | 'reset', stamp: string): string {
  const heading = purpose === 'signup' ? 'Finish setting up your account' : 'Reset your password';
  const lede =
    purpose === 'signup'
      ? 'Enter this code to finish creating your TapDash account.'
      : 'Enter this code to choose a new password for your TapDash account.';

  /*
   * The preheader is the grey line an inbox shows after the subject. Left
   * unset, clients scrape it from the first text in the body - which here
   * would be the "T" of the logo followed by "TapDash", telling the reader
   * nothing they cannot already see in the sender name. The zero-width
   * spaces after it stop Gmail dragging later body text in behind it.
   */
  const preheader = `Your ${MINUTES}-minute code is ${code}`;
  const pad = '&#8203;&nbsp;'.repeat(12);

  return `<!doctype html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${heading}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;width:100%;background:${BRAND.canvas};">

<div style="display:none;font-size:1px;color:${BRAND.canvas};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}${pad}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.canvas};">
<tr><td align="center" style="padding:32px 16px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

  <tr><td style="padding:0 4px 20px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="34" height="34" align="center" valign="middle" bgcolor="${BRAND.accent}"
          style="width:34px;height:34px;background:${BRAND.accent};border-radius:9px;font-family:${FONT};font-size:16px;font-weight:700;color:${BRAND.accentInk};text-align:center;">T</td>
      <td style="padding-left:10px;font-family:${FONT};font-size:18px;font-weight:600;letter-spacing:-.01em;color:${BRAND.ink};">TapDash</td>
    </tr></table>
  </td></tr>

  <tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${BRAND.line};border-radius:14px;padding:36px 32px;">

    <h1 style="margin:0 0 10px;font-family:${FONT};font-size:21px;line-height:1.3;font-weight:600;color:${BRAND.ink};">${heading}</h1>

    <p style="margin:0 0 26px;font-family:${FONT};font-size:15px;line-height:1.6;color:${BRAND.muted};">${lede}</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td align="center" bgcolor="${BRAND.panel}" style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:12px;padding:22px 12px;">
        <div style="font-family:Consolas,Menlo,Courier New,monospace;font-size:36px;font-weight:700;letter-spacing:.2em;line-height:1.1;color:${BRAND.ink};text-indent:.2em;">${code}</div>
      </td></tr>
    </table>

    <p style="margin:22px 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:${BRAND.muted};">
      It expires in <strong style="color:${BRAND.ink};">${MINUTES} minutes</strong> and can only be used once.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;">
      <tr><td style="border-top:1px solid ${BRAND.line};padding-top:18px;font-family:${FONT};font-size:13px;line-height:1.65;color:${BRAND.muted};">
        <strong style="color:${BRAND.ink};">TapDash will never ask you for this code.</strong>
        Not by phone, not by email, not over chat. If you did not request it you can ignore
        this message &mdash; nothing changes until the code is entered.
      </td></tr>
    </table>

  </td></tr>

  <tr><td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${BRAND.muted};">
    TapDash &mdash; merchant services CRM<br>
    <span style="color:#8aa3b5;">Automated message, sent ${stamp}. Replies to this address are not monitored.</span>
  </td></tr>

</table>

</td></tr>
</table>
</body>
</html>`;
}

function codeEmailText(code: string, purpose: 'signup' | 'reset', stamp: string): string {
  const heading = purpose === 'signup' ? 'Finish setting up your account' : 'Reset your password';
  return [
    `TapDash - ${heading}`,
    '',
    `Your code: ${code}`,
    '',
    `It expires in ${MINUTES} minutes and can only be used once.`,
    '',
    'TapDash will never ask you for this code - not by phone, not by email,',
    'not over chat. If you did not request it, ignore this message; nothing',
    'changes until the code is entered.',
    '',
    `Automated message, sent ${stamp}. Replies are not monitored.`,
  ].join('\n');
}

export function sendOtpEmail(
  to: string,
  code: string,
  purpose: 'signup' | 'reset',
): Promise<SendResult> {
  /*
   * The send time goes in the body, and it is not decoration.
   *
   * Gmail hides text that repeats across similar messages behind a "..."
   * control. That is what swallowed the security notice in the first of these
   * that went out, because three near-identical codes arrived within minutes
   * of each other. A line that differs every time keeps each message whole.
   * Separately, it lets someone holding two unexpired codes tell which is the
   * newer one - which is exactly the situation a resend creates.
   */
  const stamp =
    new Date().toLocaleString('en-GB', {
      timeZone: 'UTC',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' UTC';

  const subject =
    purpose === 'signup' ? 'Your TapDash signup code' : 'Your TapDash password reset code';

  return send(
    to,
    subject,
    codeEmailHtml(code, purpose, stamp),
    codeEmailText(code, purpose, stamp),
    {
      /*
       * `Auto-Submitted` tells a correspondent's autoresponder that this is
       * machine-generated and must not be replied to (RFC 3834).
       * `X-Auto-Response-Suppress` is Microsoft's equivalent, and stops an
       * out-of-office reply landing back on the alerts mailbox.
       *
       * Deliberately NOT here: List-Unsubscribe. It belongs on bulk mail, and
       * attaching it to a login code tells a filter this is marketing - the
       * opposite of how a one-time passcode should be classified, and a way
       * to end up in exactly the folder we are trying to stay out of.
       */
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
    },
  );
}
