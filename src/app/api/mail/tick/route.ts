/**
 * /api/mail/tick — the Email sync engine's heartbeat. Vercel Cron calls it
 * every minute (`vercel.json`) with `Authorization: Bearer $CRON_SECRET`.
 *
 * Public in `proxy.ts` (cron has no user session); the bearer secret,
 * compared in constant time, IS the authentication. No secret configured →
 * refused, never open. Not configured at all → a quiet 200, so a deployment
 * with Email switched off does not log an error every minute.
 *
 * Answers 202 at once and does the work in `after()`, within this
 * function's 300-second limit. `?mailbox=<id>` runs a single mailbox
 * (operator runbook).
 */
import { NextResponse, after, type NextRequest } from 'next/server';
import { z } from 'zod';
import { mailConfigured, serverEnv } from '@/lib/env.server';
import { safeEqual } from '@/lib/mail/oauthState';
import { runTick } from '@/lib/mail/sync/tick';
import { mailLog } from '@/lib/mail/log';
import { getClientIp } from '@/lib/security/request';
import { ipKey, rateLimit, RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function handle(req: NextRequest) {
  if (!mailConfigured) return NextResponse.json({ skipped: 'not_configured' });

  const secret = serverEnv.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'cron_secret_missing' }, { status: 503 });

  const given = req.headers.get('authorization') ?? '';
  if (!safeEqual(given, `Bearer ${secret}`)) {
    // Only failures count, so a guesser is slowed and the real cron never is.
    await rateLimit(ipKey('mail_tick', getClientIp(req.headers)), RATE_LIMITS.mailTickPerIp);
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const only = req.nextUrl.searchParams.get('mailbox');
  if (only !== null && !z.uuid().safeParse(only).success) {
    return NextResponse.json({ error: 'bad_mailbox' }, { status: 400 });
  }

  after(async () => {
    try {
      const summary = await runTick({ only: only ?? undefined, trigger: only ? 'manual' : 'tick' });
      mailLog('info', 'tick', 'done', summary);
    } catch (e) {
      mailLog('error', 'tick', 'crashed', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}

export const GET = handle;
export const POST = handle;
