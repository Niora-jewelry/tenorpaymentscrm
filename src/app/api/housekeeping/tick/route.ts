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
import { expireStaleAgreements, reconcileOpenAgreements } from '@/lib/agreements/housekeeping';
import { remindDueSigners } from '@/lib/agreements/outlook';
import { runSystem } from '@/lib/automations/system';

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

  // Each job is a hard-coded automation (Automations › Hard-coded automations):
  // it runs only while switched on, and its result feeds Last run and History.
  // One failing never stops the next.
  after(async () => {
    try {
      await runSystem('notifications_cleanup', async () => {
        const { data, error } = await supabaseAdmin().rpc('notifications_prune');
        if (error) throw new Error(`notifications_prune ${error.code}`);
        const n = Number(data ?? 0);
        return { count: n, note: n ? `${n} removed` : null };
      });
      await runSystem('upload_cleanup', async () => {
        const n = await pruneStagedUploads();
        return { count: n, note: n ? `${n} removed` : null };
      });
      await runSystem('agreement_expiry', async () => {
        const n = await expireStaleAgreements();
        return { count: n, note: n ? `${n} expired` : null };
      });
      await runSystem('agreement_status_check', async () => {
        const r = await reconcileOpenAgreements();
        return { count: r.changed, note: `${r.checked} checked, ${r.changed} updated` };
      });
      // Agreements sent through Outlook: day 3, 6 and 10 reminders (SignWell sends its own otherwise).
      await runSystem('agreement_reminders', async () => {
        const n = await remindDueSigners();
        return { count: n, note: n ? `${n} reminders sent` : null };
      });
      await runSystem('automation_history_cleanup', async () => {
        const { error } = await supabaseAdmin().rpc('automation_prune');
        if (error) throw new Error(`automation_prune ${error.code}`);
        return { count: 0 };
      });
    } catch (e) {
      console.error('[housekeeping] crashed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}

export const GET = handle;
export const POST = handle;
