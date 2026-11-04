/**
 * /api/processors/sync — the processor's daily sync (Maverick Integration spec:
 * "Runs automatically every day at 7:00 AM Eastern"). Vercel Cron calls it at
 * 11:00 and 12:00 UTC with `Authorization: Bearer $CRON_SECRET`; only the call
 * that lands on 7 o'clock in New York runs, and once a day at most. Public in
 * `proxy.ts` because cron has no user session.
 */
import { NextResponse, after, type NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env.server';
import { safeEqual } from '@/lib/mail/oauthState';
import { getClientIp } from '@/lib/security/request';
import { ipKey, rateLimit, RATE_LIMITS } from '@/lib/security/rate-limit';
import { runProcessorSync } from '@/lib/processors/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
      const r = await runProcessorSync();
      if (r.ran) console.log('[processors] sync', r.outcome);
    } catch (e) {
      console.error('[processors] sync crashed', e instanceof Error ? e.name : 'unknown');
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}

export const GET = handle;
export const POST = handle;
