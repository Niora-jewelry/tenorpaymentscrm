/**
 * GET /api/mail/oauth/start?kind=personal|shared[&address=][&return=]
 *
 * Sends the signed-in person to Microsoft to connect a mailbox. Session-gated
 * (never in `PUBLIC_API_PATHS`); refused while an admin is signed in as
 * someone else, because the mailbox would land on the impersonated account.
 *
 * The state cookie carries the PKCE verifier, the CRM user id and — for a
 * shared mailbox — the address, all signed. Microsoft only ever sees the
 * nonce and the S256 challenge.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authorize, NotAuthenticatedError } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { mailConfigured } from '@/lib/env.server';
import { mailConfig } from '@/lib/mail/config';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { authorizeUrl } from '@/lib/mail/oauthClient';
import {
  MAIL_OAUTH_COOKIE,
  MAIL_OAUTH_COOKIE_PATH,
  STATE_MAX_AGE_MS,
  challengeFor,
  safeEmailReturnPath,
  signState,
} from '@/lib/mail/oauthState';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';
import type { ConnectErrorCode } from '@/lib/mail/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({
  kind: z.enum(['personal', 'shared']).default('personal'),
  address: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email())
    .optional()
    .or(z.literal('').transform(() => undefined)),
  return: z.string().max(512).optional(),
});

function back(req: NextRequest, path: string, code: ConnectErrorCode): NextResponse {
  const url = new URL(path, req.nextUrl.origin);
  url.searchParams.set('mail_error', code);
  const res = NextResponse.redirect(url, 303);
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

export async function GET(req: NextRequest) {
  if (!mailConfigured) return new NextResponse(null, { status: 404 });

  let ctx;
  try {
    ctx = await authorize();
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return NextResponse.redirect(new URL('/login', req.nextUrl.origin), 303);
    throw e;
  }

  const sp = req.nextUrl.searchParams;
  const returnPath = safeEmailReturnPath(sp.get('return') ?? '/email/settings');

  if (await currentImpersonation()) return back(req, returnPath, 'impersonating');
  try {
    await requireEmailAccess(ctx, 'view');
  } catch (e) {
    if (e instanceof EmailAccessError) return back(req, '/dashboard', 'not_permitted');
    throw e;
  }

  const parsed = Query.safeParse({
    kind: sp.get('kind') ?? undefined,
    address: sp.get('address') ?? undefined,
    return: sp.get('return') ?? undefined,
  });
  if (!parsed.success || (parsed.data.kind === 'shared' && !parsed.data.address)) {
    return back(req, returnPath, 'bad_address');
  }

  const limit = await rateLimit(userKey('mail_connect', ctx.userId), RATE_LIMITS.mailConnectStartPerUser);
  if (!limit.allowed) return back(req, returnPath, 'rate_limited');

  const cfg = mailConfig();
  const { cookie, nonce, verifier } = signState(
    {
      userId: ctx.userId,
      kind: parsed.data.kind,
      target: parsed.data.kind === 'shared' ? parsed.data.address : undefined,
      returnPath,
    },
    cfg.stateSecret,
  );

  const res = NextResponse.redirect(
    authorizeUrl(cfg.endpoints, {
      clientId: cfg.creds.clientId,
      redirectUri: cfg.redirectUri,
      state: nonce,
      challenge: challengeFor(verifier),
    }),
    303,
  );
  res.cookies.set(MAIL_OAUTH_COOKIE, cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax, not Strict: Microsoft's redirect back is a top-level cross-site
    // GET, and the cookie must ride along on it.
    sameSite: 'lax',
    path: MAIL_OAUTH_COOKIE_PATH,
    maxAge: Math.floor(STATE_MAX_AGE_MS / 1000),
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
