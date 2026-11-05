/**
 * /api/phone/broadcast-tick: sends queued broadcast texts. Vercel Cron calls it
 * every minute (`vercel.json`) with `Authorization: Bearer $CRON_SECRET`. Public in
 * `proxy.ts` because cron has no session. Safe to run twice: each number is claimed
 * before it is sent, and the pace is held by the claim.
 */
import { NextResponse, after, type NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env.server';
import { drainBroadcasts } from '@/lib/phone/broadcasts';
import { safeEqual } from '@/lib/mail/oauthState';
import { getClientIp } from '@/lib/security/request';
import { ipKey, rateLimit, RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const secret = serverEnv.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron_secret_missing' }, { status: 503 });

  const given = req.headers.get('authorization') ?? '';
  if (!safeEqual(given, `Bearer ${secret}`)) {
    await rateLimit(ipKey('mail_tick', getClientIp(req.headers)), RATE_LIMITS.mailTickPerIp);
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  after(async () => {
    try {
      await drainBroadcasts(45_000);
    } catch (e) {
      console.error('[broadcast] tick crashed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}

export const GET = handle;
export const POST = handle;
