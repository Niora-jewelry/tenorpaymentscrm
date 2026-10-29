/**
 * /api/housekeeping/tick — nightly retention. Vercel Cron calls it once a
 * day (`vercel.json`) with `Authorization: Bearer $CRON_SECRET`; the same
 * constant-time check as `/api/mail/tick`. Public in `proxy.ts` because cron
 * has no user session.
 *
 * Today: notifications older than 90 days (the client's retention), revoked
 * mentions a day after they were revoked, and returned-application uploads
 * that were staged but never taken (plain PDFs — they hold SSNs — so an
 * abandoned one must not linger). Safe to run twice.
 */
import { NextResponse, after, type NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env.server';
import { safeEqual } from '@/lib/mail/oauthState';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getClientIp } from '@/lib/security/request';
import { ipKey, rateLimit, RATE_LIMITS } from '@/lib/security/rate-limit';
import { pruneStagedUploads } from '@/lib/applications/housekeeping';

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
      const { data, error } = await supabaseAdmin().rpc('notifications_prune');
      if (error) console.error('[housekeeping] notifications_prune failed', error.code);
      else if (Number(data ?? 0) > 0) console.log('[housekeeping] notifications pruned', Number(data));
      const staged = await pruneStagedUploads();
      if (staged > 0) console.log('[housekeeping] abandoned application uploads removed', staged);
    } catch (e) {
      console.error('[housekeeping] crashed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}

export const GET = handle;
export const POST = handle;
