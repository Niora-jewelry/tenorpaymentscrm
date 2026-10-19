/**
 * The gate every Email byte-serving route passes first (attachments, inline
 * images, the image proxy): signed in, not impersonating, holding the email
 * grant, under the rate limit. Visibility of the specific item is then the
 * route's own RLS read.
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { authorize, NotAuthenticatedError, type AuthContext } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { mailConfigured } from '@/lib/env.server';
import { requireEmailAccess, EmailAccessError } from './access';
import { rateLimit, userKey, type RateLimitRule } from '@/lib/security/rate-limit';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const notFound = () => new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function routeGate(scope: string, rule: RateLimitRule): Promise<{ ctx: AuthContext } | { response: Response }> {
  if (!mailConfigured) return { response: notFound() };
  let ctx: AuthContext;
  try {
    ctx = await authorize();
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { response: new NextResponse('Sign in again.', { status: 401 }) };
    throw e;
  }
  if (await currentImpersonation()) return { response: new NextResponse('Hidden while signed in as another user.', { status: 403 }) };
  try {
    await requireEmailAccess(ctx, 'view');
  } catch (e) {
    if (e instanceof EmailAccessError) return { response: new NextResponse('Not permitted.', { status: 403 }) };
    throw e;
  }
  const limit = await rateLimit(userKey(scope, ctx.userId), rule);
  if (!limit.allowed) {
    return { response: new NextResponse('Too many requests.', { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }) };
  }
  return { ctx };
}

/** Headers for bytes from someone else's mail: never sniffed, never framed as a page, never cached shared. */
export function untrustedHeaders(extra: Record<string, string>): Headers {
  return new Headers({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
}

/** RFC 6266 filename: an ASCII fallback plus the UTF-8 original. */
export function contentDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 200) || 'attachment';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["%;]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
