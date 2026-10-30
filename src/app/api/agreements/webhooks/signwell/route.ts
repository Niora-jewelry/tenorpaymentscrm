/**
 * POST /api/agreements/webhooks/signwell — SignWell's document events.
 *
 * Public in `proxy.ts` (SignWell has no session). The event's hash — an
 * HMAC of its type and time, keyed by our webhook id — is the
 * authentication, compared in constant time. Beyond that:
 *
 *   · unconfigured → 202 and nothing (a deployment without SignWell does
 *     not log an error per event);
 *   · too big, unparsable, unverifiable or stale → 202 and dropped; each
 *     failure counts against the sender's address so a guesser is slowed;
 *   · answered 202 at once, applied in `after()` — SignWell retries on
 *     anything else, and a replay is a no-op in the database anyway.
 */
import { NextResponse, after, type NextRequest } from 'next/server';
import { agreementsConfigured } from '@/lib/env.server';
import { vendor } from '@/lib/agreements/vendor';
import { handleVerifiedEvent } from '@/lib/agreements/webhook';
import { getClientIp } from '@/lib/security/request';
import { ipKey, rateLimit } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BYTES = 1_000_000;
const accepted = (note: string) => NextResponse.json({ accepted: true, note }, { status: 202, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: NextRequest) {
  if (!agreementsConfigured) return accepted('not_configured');
  const ip = getClientIp(req.headers) ?? 'unknown';
  const flood = await rateLimit(ipKey('agreement_webhook', ip), { limit: 600, windowSeconds: 60 });
  if (!flood.allowed) return NextResponse.json({ error: 'too_many' }, { status: 429 });

  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_BYTES) return accepted('too_large');
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return accepted('too_large');

  const ev = vendor().verifyWebhook(raw);
  if (!ev) {
    // Only failures spend this budget; the real sender never does.
    const bad = await rateLimit(ipKey('agreement_webhook_bad', ip), { limit: 20, windowSeconds: 900 });
    if (!bad.allowed) return NextResponse.json({ error: 'too_many' }, { status: 429 });
    return accepted('unverified');
  }

  after(async () => {
    try {
      const outcome = await handleVerifiedEvent(ev);
      if (outcome === 'applied' || outcome === 'unknown') console.log('[agreements] webhook', ev.type, outcome);
    } catch (e) {
      console.error('[agreements] webhook failed', ev.type, e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    }
  });
  return accepted('ok');
}
