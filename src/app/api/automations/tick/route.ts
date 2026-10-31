/**
 * /api/automations/tick — runs what is due. Vercel Cron calls it every minute
 * (`vercel.json`) with `Authorization: Bearer $CRON_SECRET`; the same constant-time
 * check as `/api/mail/tick`. Public in `proxy.ts` because cron has no user session.
 * Safe to run twice: rows are claimed, and an email is keyed to its run and step.
 */
import { NextResponse, after, type NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env.server';
import { runAutomations } from '@/lib/automations/engine';
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
      await runAutomations(45_000);
    } catch (e) {
      console.error('[automations] tick crashed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}

export const GET = handle;
export const POST = handle;
