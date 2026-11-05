/**
 * GET /api/msteams/record-chats?record=: the chats linked to a record.
 *
 * Asked when the sub-tab opens rather than with the page, so Microsoft being slow or
 * down cannot hold up the drawer. Not `routeGate`: the cards are for anyone who can
 * open the sub-tab, including someone with no Email grant or signed in as another
 * user. Those two are worked out in `recordChats` and simply read nothing.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { TeamsError } from '@/lib/msteams/access';
import { recordChats } from '@/lib/msteams/recordLinks';
import { authorize, NotAuthenticatedError } from '@/lib/records/permissions';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const noStore = { 'Cache-Control': 'no-store' };

export async function GET(req: NextRequest) {
  const record = z.uuid().safeParse(req.nextUrl.searchParams.get('record'));
  if (!record.success) return NextResponse.json({ message: 'Not found.' }, { status: 400, headers: noStore });

  let ctx;
  try {
    ctx = await authorize();
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return NextResponse.json({ message: 'Sign in again.' }, { status: 401, headers: noStore });
    throw e;
  }
  const limit = await rateLimit(userKey('teams_read', ctx.userId), RATE_LIMITS.teamsReadPerUser);
  if (!limit.allowed) return NextResponse.json({ message: 'Too many requests.' }, { status: 429, headers: { ...noStore, 'Retry-After': String(limit.retryAfterSeconds) } });

  try {
    return NextResponse.json(await recordChats(ctx, record.data), { headers: noStore });
  } catch (e) {
    if (e instanceof TeamsError) return NextResponse.json({ message: e.message }, { status: 404, headers: noStore });
    throw e;
  }
}
