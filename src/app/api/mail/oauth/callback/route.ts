/**
 * GET /api/mail/oauth/callback — Microsoft sends the person back here.
 *
 * Session-gated like `start`. Every state check (`verifyState`) runs before
 * the code is even read; the cookie is cleared on every outcome so a state
 * can be used at most once. Outcomes reach the page as fixed CODES
 * (`CONNECT_ERRORS`), never as text from the URL or from Microsoft.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { authorize, NotAuthenticatedError } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { mailConfigured } from '@/lib/env.server';
import { mailConfig } from '@/lib/mail/config';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { MAIL_OAUTH_COOKIE, MAIL_OAUTH_COOKIE_PATH, verifyState } from '@/lib/mail/oauthState';
import { completeConnect } from '@/lib/mail/connect';
import { mailLog } from '@/lib/mail/log';
import type { ConnectErrorCode } from '@/lib/mail/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Exchange + proof + folder tree of a large mailbox. */
export const maxDuration = 60;

const FALLBACK = '/email/settings';

function finish(req: NextRequest, path: string, params: Record<string, string>): NextResponse {
  const url = new URL(path, req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url, 303);
  res.cookies.set(MAIL_OAUTH_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: MAIL_OAUTH_COOKIE_PATH,
    maxAge: 0,
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

const fail = (req: NextRequest, path: string, code: ConnectErrorCode, extra: Record<string, string> = {}) =>
  finish(req, path, { mail_error: code, ...extra });

export async function GET(req: NextRequest) {
  if (!mailConfigured) return new NextResponse(null, { status: 404 });

  let ctx;
  try {
    ctx = await authorize();
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return finish(req, '/login', {});
    throw e;
  }

  if (await currentImpersonation()) return fail(req, FALLBACK, 'impersonating');

  const sp = req.nextUrl.searchParams;
  const raw = (await cookies()).get(MAIL_OAUTH_COOKIE)?.value;
  const check = verifyState(raw, sp.get('state'), ctx.userId, mailConfig().stateSecret);
  if (!check.ok) {
    mailLog('warn', 'oauth', 'state_rejected', { reason: check.reason });
    return fail(req, FALLBACK, 'state_invalid');
  }
  const state = check.payload;
  const shared: Record<string, string> = state.kind === 'shared' && state.target ? { shared: state.target } : {};

  const msError = sp.get('error');
  if (msError) {
    const description = sp.get('error_description') ?? '';
    // AADSTS65004 = the person pressed Cancel on the consent screen; 65001 /
    // 90094 = the tenant requires an admin to approve the app first.
    const code: ConnectErrorCode =
      msError === 'consent_required' || /AADSTS65001|AADSTS90094/.test(description)
        ? 'consent_required'
        : /AADSTS50020|AADSTS500200/.test(description)
          ? 'personal_account'
          : msError === 'access_denied'
            ? 'cancelled'
            : 'failed';
    mailLog('info', 'oauth', 'microsoft_error', { error: msError, mapped: code });
    return fail(req, state.returnPath, code, shared);
  }

  try {
    await requireEmailAccess(ctx, 'view');
  } catch (e) {
    if (e instanceof EmailAccessError) return fail(req, '/dashboard', 'not_permitted');
    throw e;
  }

  const code = sp.get('code');
  if (!code || code.length > 8192) return fail(req, state.returnPath, 'state_invalid');

  let result;
  try {
    result = await completeConnect({
      userId: ctx.userId,
      kind: state.kind,
      target: state.target,
      code,
      verifier: state.verifier,
    });
  } catch (e) {
    mailLog('error', 'oauth', 'connect_threw', { message: e instanceof Error ? e.name : 'unknown' });
    return fail(req, state.returnPath, 'failed', shared);
  }

  if (!result.ok) return fail(req, state.returnPath, result.reason, shared);
  return finish(req, state.returnPath, {
    connected: result.mailboxId,
    ...(result.reconnected ? { reconnected: '1' } : {}),
    ...(result.degraded ? { degraded: '1' } : {}),
  });
}
