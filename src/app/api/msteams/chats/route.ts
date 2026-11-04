/** GET /api/msteams/chats: the chat list, polled. A route for the reason in ../calendar/route.ts. */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { routeGate } from '@/lib/mail/routeGate';
import { TeamsError } from '@/lib/msteams/access';
import { chatList } from '@/lib/msteams/chat';
import { RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const gate = await routeGate('teams_read', RATE_LIMITS.teamsReadPerUser);
  if ('response' in gate) return gate.response;
  const as = z.uuid().optional().safeParse(req.nextUrl.searchParams.get('as') ?? undefined);
  if (!as.success) return NextResponse.json({ message: 'Not found.' }, { status: 400 });
  try {
    return NextResponse.json(await chatList(gate.ctx, as.data), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof TeamsError) return NextResponse.json({ message: e.message }, { status: 403 });
    throw e;
  }
}
