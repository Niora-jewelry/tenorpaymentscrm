/** GET /api/msteams/messages: one conversation's messages, polled while it is open. */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { routeGate } from '@/lib/mail/routeGate';
import { TeamsError } from '@/lib/msteams/access';
import { messagesPage } from '@/lib/msteams/chat';
import { RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Query = z.object({ key: z.string().min(1).max(600), cursor: z.string().max(2000).optional() });

export async function GET(req: NextRequest) {
  const gate = await routeGate('teams_read', RATE_LIMITS.teamsReadPerUser);
  if ('response' in gate) return gate.response;
  const sp = req.nextUrl.searchParams;
  const parsed = Query.safeParse({ key: sp.get('key'), cursor: sp.get('cursor') ?? undefined });
  if (!parsed.success) return NextResponse.json({ message: 'Not found.' }, { status: 400 });
  try {
    return NextResponse.json(await messagesPage(gate.ctx, parsed.data), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof TeamsError) return NextResponse.json({ message: e.message }, { status: 403 });
    throw e;
  }
}
