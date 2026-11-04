/** GET /api/msteams/counts: the two sidebar numbers. Own only, whoever is asking. */
import { NextResponse } from 'next/server';
import { routeGate } from '@/lib/mail/routeGate';
import { refreshCounts } from '@/lib/msteams/counts';
import { RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  const gate = await routeGate('teams_counts', RATE_LIMITS.teamsReadPerUser);
  if ('response' in gate) return gate.response;
  return NextResponse.json(await refreshCounts(gate.ctx), { headers: { 'Cache-Control': 'no-store' } });
}
