/**
 * Transactional email.
 *
 * Spec §8: "OTP and invite emails require a production-grade transactional
 * sender from day one — Supabase's built-in SMTP is dev-only. Configure a
 * dedicated provider (Resend or Postmark recommended) in Phase 1; Outlook
 * integration on the roadmap does not cover transactional auth email."
 *
 * OTP mail carries a CODE, never a link. Nothing in the message is a bearer
 * token that survives forwarding, and there is no link to phish.
 */
import 'server-only';
import { Resend } from 'resend';
import { serverEnv, isProduction } from '@/lib/env.server';
import { OTP_TTL_SECONDS } from '@/lib/security/otp';

let resend: Resend | null = null;

function client(): Resend | null {
  if (!serverEnv.RESEND_API_KEY) return null;
  resend ??= new Resend(serverEnv.RESEND_API_KEY);
  return resend;
}

export type SendResult = { ok: true } | { ok: false; error: string };

async function send(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  const api = client();

  if (!api) {
    if (isProduction) {
      // Silently "succeeding" here would mean users never receive codes while
      // the app reports success. Fail loudly instead.
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
        `  EMAIL (dev — no RESEND_API_KEY set, nothing was sent)`,
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
    const { error } = await api.emails.send({
      from: serverEnv.EMAIL_FROM,
      to,
      subject,
      html,
      text,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : 'Send failed' };
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
