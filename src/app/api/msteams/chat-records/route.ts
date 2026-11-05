/** GET /api/msteams/chat-records?key=: the records a conversation is linked to, for the Chat module. */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { routeGate } from '@/lib/mail/routeGate';
import { TeamsError } from '@/lib/msteams/access';
import { chatRecords } from '@/lib/msteams/recordLinks';
import { RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const gate = await routeGate('teams_read', RATE_LIMITS.teamsReadPerUser);
  if ('response' in gate) return gate.response;
  const key = z.string().min(1).max(600).safeParse(req.nextUrl.searchParams.get('key'));
  if (!key.success) return NextResponse.json({ message: 'Not found.' }, { status: 400 });
  try {
    return NextResponse.json(await chatRecords(gate.ctx, key.data), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof TeamsError) return NextResponse.json({ message: e.message }, { status: 403 });
    throw e;
  }
}
