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
  attachments?: { filename: string; content: Buffer }[],
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
    await api.sendMail({ from: serverEnv.EMAIL_FROM, to, subject, html, text, headers, attachments });
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

/**
 * The timestamp carried by every email.
 *
 * Gmail hides text that repeats across similar messages behind a "..."
 * control, which swallowed the security notice when several codes arrived
 * together. A line that differs every time keeps each message whole, and lets
 * someone holding two unexpired codes tell which is newer.
 */
function sendStamp(): string {
  return (
    new Date().toLocaleString('en-GB', {
      timeZone: 'UTC',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }) + ' UTC'
  );
}

/**
 * The origin that links in emails are built from.
 *
 * `NEXT_PUBLIC_APP_URL` is the configured answer and is used whenever it is
 * sensible. The fallback exists for one specific, silent failure: that
 * variable is `http://localhost:3000` in local development, and a deployment
 * that inherits it unchanged sends every invited person a button pointing at
 * their OWN machine. The link is not broken in a way anyone can see - it
 * opens a browser, fails to connect, and looks like the recipient's problem.
 *
 * So in production a localhost value is refused in favour of the deployment's
 * own hostname, which the platform sets and nobody has to remember to.
 */
function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const platform =
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();

  const looksLocal = !configured || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(configured);

  if (isProduction && looksLocal && platform) {
    console.warn(
      '[email] NEXT_PUBLIC_APP_URL is unset or points at localhost in production; ' +
        `using ${platform} for email links instead. Set it to the real site URL.`,
    );
    return `https://${platform.replace(/\/+$/, '')}`;
  }

  return (configured || 'http://localhost:3000').replace(/\/+$/, '');
}



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

/**
 * The official TapDash logo, as supplied by the client.
 *
 * Its natural size is 1457x1251. Rendered at 132px wide it is a shade over
 * 11x down, so it stays sharp on a 2x display without shipping a second
 * asset. `width` and `height` are set as ATTRIBUTES as well as in the style:
 * Outlook ignores CSS sizing on an image, and an unsized 1457px-wide logo
 * would blow the 600px layout apart.
 *
 * -- WHAT HAPPENS WHEN IT DOES NOT LOAD ----------------------------------
 * Outlook and most corporate clients block remote images until the reader
 * allows them, so this WILL sometimes render as nothing. The alt text is
 * therefore styled, not left bare: with images off the header still reads
 * "TapDash" in the brand colour at a sensible size, rather than showing a
 * broken-image icon above a login code - which is what phishing looks like.
 */
const LOGO_URL = 'https://tapdash.co/wp-content/uploads/2024/08/cropped-TapDash-Logo-PNG.png';
const LOGO_W = 132;
const LOGO_H = 113;

/** Minimal escaping for the few values that come from a database row rather
 *  than from this file - an inviter's display name, a role label. None of it
 *  is attacker-controlled today, but it is interpolated into markup, and a
 *  name containing an apostrophe or an ampersand should not be able to break
 *  the email it appears in. */
function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Every email this app sends is this shell with a different middle.
 *
 * Having one of these is the point: the logo, the width, the card, the
 * footer and the Outlook workarounds are decided once. A second template
 * written alongside the first is how two emails from the same product end up
 * looking like they came from different companies.
 */
function emailShell(opts: {
  title: string;
  preheader: string;
  bodyHtml: string;
  stamp: string;
}): string {
  // Zero-width spaces after the preheader stop Gmail dragging body text in
  // behind it in the inbox list.
  const pad = '&#8203;&nbsp;'.repeat(12);

  return `<!doctype html>
<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(opts.title)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="margin:0;padding:0;width:100%;background:${BRAND.canvas};">

<div style="display:none;font-size:1px;color:${BRAND.canvas};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(opts.preheader)}${pad}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.canvas};">
<tr><td align="center" style="padding:32px 16px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

  <tr><td align="center" style="padding:0 4px 22px;">
    <img src="${LOGO_URL}" width="${LOGO_W}" height="${LOGO_H}" alt="TapDash"
         style="display:block;width:${LOGO_W}px;height:${LOGO_H}px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:19px;font-weight:700;color:${BRAND.ink};">
  </td></tr>

  <tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${BRAND.line};border-radius:14px;padding:36px 32px;">
${opts.bodyHtml}
  </td></tr>

  <tr><td align="center" style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${BRAND.muted};">
    TapDash &mdash; merchant services CRM<br>
    <span style="color:#8aa3b5;">Automated message, sent ${esc(opts.stamp)}. Replies to this address are not monitored.</span>
  </td></tr>

</table>

</td></tr>
</table>
</body>
</html>`;
}

function codeEmailHtml(code: string, purpose: 'signup' | 'reset', stamp: string): string {
  const heading = purpose === 'signup' ? 'Finish setting up your account' : 'Reset your password';
  const lede =
    purpose === 'signup'
      ? 'Enter this code to finish creating your TapDash account.'
      : 'Enter this code to choose a new password for your TapDash account.';

  const body = `
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
    </table>`;

  return emailShell({
    title: heading,
    preheader: `Your ${MINUTES}-minute code is ${code}`,
    bodyHtml: body,
    stamp,
  });
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
  const stamp = sendStamp();

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


/**
 * "You have been invited to TapDash."
 *
 * -- WHY THIS DID NOT EXIST BEFORE, AND WHY IT DOES NOW -------------------
 * `InvitesTable` carried a comment explaining that an expired invite offers
 * Renew rather than Resend, "because there is no invite email in this build".
 * That was a coherent position: an invite is permission for someone to
 * complete signup, and the code proving their address is requested BY THEM at
 * /signup, so there was nothing to resend.
 *
 * It had one hole, which is what the client hit. Nothing told the invited
 * person they had been invited. An admin filled in the dialog, chose a
 * template, tuned the permissions, pressed Done - and the other party heard
 * nothing at all, because the only notification in the system was a code they
 * could not request without first knowing to go to /signup.
 *
 * -- IT STILL CARRIES NO CREDENTIAL --------------------------------------
 * This is a notification, not a magic link. There is no token in the URL and
 * nothing here grants access: it points at /signup, where the person proves
 * their own address with a code exactly as before. Forwarding this email to
 * someone else gives them nothing, because the invite is bound to the address
 * it was issued to. That keeps the project's standing rule intact - no
 * default credential is ever left behind - while still telling the person
 * they are expected.
 */
export function sendInviteEmail(
  to: string,
  opts: { invitedBy?: string | null; roleName?: string | null; expiresAt?: string | null },
): Promise<SendResult> {
  const stamp = sendStamp();
  const signupUrl = `${appOrigin()}/signup`;

  const inviter = opts.invitedBy?.trim();
  const role = opts.roleName?.trim();

  const expires = opts.expiresAt
    ? new Date(opts.expiresAt).toLocaleDateString('en-GB', {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  const introHtml = inviter
    ? `<strong style="color:${BRAND.ink};">${esc(inviter)}</strong> has invited you to TapDash, the merchant services CRM.`
    : 'You have been invited to TapDash, the merchant services CRM.';

  const body = `
    <h1 style="margin:0 0 10px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:600;color:${BRAND.ink};">You&rsquo;re invited to TapDash</h1>

    <p style="margin:0 0 22px;font-family:${FONT};font-size:15px;line-height:1.65;color:${BRAND.muted};">
      ${introHtml}${role ? ` You&rsquo;ll join as <strong style="color:${BRAND.ink};">${esc(role)}</strong>.` : ''}
      Create your account to get started.
    </p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
      <tr><td align="center" bgcolor="${BRAND.accent}" style="background:${BRAND.accent};border-radius:10px;">
        <a href="${signupUrl}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:${BRAND.accentInk};text-decoration:none;border-radius:10px;">Create your account</a>
      </td></tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td bgcolor="${BRAND.panel}" style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;padding:16px 18px;font-family:${FONT};font-size:13.5px;line-height:1.7;color:${BRAND.muted};">
        Sign up with this address: <strong style="color:${BRAND.ink};">${esc(to)}</strong><br>
        TapDash is invite-only, so another address will not be recognised.
      </td></tr>
    </table>

    ${
      expires
        ? `<p style="margin:18px 0 0;font-family:${FONT};font-size:13.5px;line-height:1.6;color:${BRAND.muted};">
             This invitation expires on <strong style="color:${BRAND.ink};">${esc(expires)}</strong>.
           </p>`
        : ''
    }

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
      <tr><td style="border-top:1px solid ${BRAND.line};padding-top:18px;font-family:${FONT};font-size:13px;line-height:1.65;color:${BRAND.muted};">
        If the button does not work, open this link:<br>
        <span style="color:${BRAND.ink};word-break:break-all;">${esc(signupUrl)}</span><br><br>
        Not expecting this? You can ignore this email &mdash; no account exists until you create one.
      </td></tr>
    </table>`;

  const text = [
    "You're invited to TapDash",
    '',
    inviter
      ? `${inviter} has invited you to TapDash, the merchant services CRM.`
      : 'You have been invited to TapDash, the merchant services CRM.',
    role ? `You'll join as ${role}.` : null,
    '',
    `Create your account: ${signupUrl}`,
    '',
    `Sign up with this address: ${to}`,
    'TapDash is invite-only, so another address will not be recognised.',
    expires ? `This invitation expires on ${expires}.` : null,
    '',
    'Not expecting this? Ignore this email - no account exists until you create one.',
    '',
    `Automated message, sent ${stamp}. Replies are not monitored.`,
  ]
    /* `null` is an absent line, `''` a deliberate blank one. Filtering on
       falsiness collapsed both and ran the whole message into one block. */
    .filter((l): l is string => l !== null)
    .join('\n');

  return send(
    to,
    'You have been invited to TapDash',
    emailShell({
      title: "You're invited to TapDash",
      preheader: 'Create your account to get started.',
      bodyHtml: body,
      stamp,
    }),
    text,
    { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
  );
}

/**
 * A voicemail, to the inbox the client named.
 *
 * Q9 asked whether he wanted the recording attached, a link, or both. "BOTH" -
 * so this carries the audio AND a signed link. The attachment plays in the
 * mail client without anyone signing in; the link survives an archived mailbox
 * that has had its attachments stripped, which is the state every inbox
 * eventually reaches.
 *
 * Both can be absent if the storage read failed. The email still goes, because
 * "someone left a voicemail at 4:58pm and here is their number" is worth
 * knowing even when the audio has to be fetched from the CRM by hand.
 */
export function sendVoicemailEmail(
  to: string,
  opts: {
    callerE164: string | null;
    dialedE164: string | null;
    durationSeconds: number | null;
    link: string | null;
    attachment?: { filename: string; content: Buffer };
  },
): Promise<SendResult> {
  const stamp = sendStamp();
  const caller = opts.callerE164 ?? 'an unknown number';
  const mins = opts.durationSeconds === null ? null : Math.floor(opts.durationSeconds / 60);
  const secs = opts.durationSeconds === null ? null : opts.durationSeconds % 60;
  const length =
    mins === null ? 'unknown length' : mins > 0 ? `${mins} min ${secs} sec` : `${secs} sec`;

  const rows: [string, string][] = [
    ['From', caller],
    ['Length', length],
    ['Received', stamp],
  ];
  if (opts.dialedE164) rows.splice(1, 0, ['Called', opts.dialedE164]);

  const body = `
    <h1 style="margin:0 0 10px;font-family:${FONT};font-size:21px;line-height:1.3;font-weight:600;color:${BRAND.ink};">New voicemail</h1>

    <p style="margin:0 0 22px;font-family:${FONT};font-size:15px;line-height:1.6;color:${BRAND.muted};">
      Someone left a message for TapDash.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
      <tr><td bgcolor="${BRAND.panel}" style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:10px;padding:16px 18px;font-family:${FONT};font-size:14px;line-height:1.8;color:${BRAND.muted};">
        ${rows
          .map(
            ([k, v]) =>
              `${esc(k)}: <strong style="color:${BRAND.ink};">${esc(v)}</strong>`,
          )
          .join('<br>')}
      </td></tr>
    </table>

    ${
      opts.attachment
        ? `<p style="margin:0 0 18px;font-family:${FONT};font-size:13.5px;line-height:1.6;color:${BRAND.muted};">
             The recording is attached to this email.
           </p>`
        : ''
    }

    ${
      opts.link
        ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">
             <tr><td align="center" bgcolor="${BRAND.accent}" style="background:${BRAND.accent};border-radius:10px;">
               <a href="${esc(opts.link)}" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;color:${BRAND.accentInk};text-decoration:none;border-radius:10px;">Listen to the message</a>
             </td></tr>
           </table>`
        : `<p style="margin:0 0 18px;font-family:${FONT};font-size:13.5px;line-height:1.6;color:${BRAND.muted};">
             The recording could not be linked automatically. It is stored in TapDash under this call.
           </p>`
    }

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="border-top:1px solid ${BRAND.line};padding-top:18px;font-family:${FONT};font-size:13px;line-height:1.65;color:${BRAND.muted};">
        This message is also stored in TapDash, where it stays available after this link expires.
      </td></tr>
    </table>`;

  const text = [
    'New voicemail',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    opts.attachment ? 'The recording is attached to this email.' : '',
    opts.link ? `Listen: ${opts.link}` : '',
    '',
    'This message is also stored in TapDash.',
  ]
    .filter((l) => l !== '' || true)
    .join('\n');

  return send(
    to,
    `Voicemail from ${caller}`,
    emailShell({
      title: 'New voicemail',
      preheader: `${caller} - ${length}`,
      bodyHtml: body,
      stamp,
    }),
    text,
    { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    opts.attachment ? [opts.attachment] : undefined,
  );
}
