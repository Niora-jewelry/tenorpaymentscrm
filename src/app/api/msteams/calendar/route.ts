/**
 * GET /api/msteams/calendar: the events for a date range.
 *
 * A route rather than a Server Action because the screen polls it: Next runs a page's
 * actions one at a time, so a slow read from Microsoft would hold up a Save behind it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { routeGate } from '@/lib/mail/routeGate';
import { TeamsError } from '@/lib/msteams/access';
import { calendarData } from '@/lib/msteams/calendar';
import { RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Query = z.object({
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  timeZone: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/),
  as: z.uuid().optional(),
});

export async function GET(req: NextRequest) {
  const gate = await routeGate('teams_read', RATE_LIMITS.teamsReadPerUser);
  if ('response' in gate) return gate.response;
  const sp = req.nextUrl.searchParams;
  const parsed = Query.safeParse({ start: sp.get('start'), end: sp.get('end'), timeZone: sp.get('timeZone'), as: sp.get('as') ?? undefined });
  if (!parsed.success) return NextResponse.json({ message: 'That date range is not valid.' }, { status: 400 });
  try {
    const data = await calendarData(gate.ctx, { ownerId: parsed.data.as, start: parsed.data.start, end: parsed.data.end, timeZone: parsed.data.timeZone });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof TeamsError) return NextResponse.json({ message: e.message }, { status: 403 });
    throw e;
  }
}
