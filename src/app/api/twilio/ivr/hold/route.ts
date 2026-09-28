/**
 * POST /api/twilio/ivr/hold — one pass of the hold loop.
 *
 * Twilio requests this repeatedly for as long as the caller waits, so each
 * request is ONE iteration. `loop` counts them, which is how "after one
 * minute, and every minute after that" is expressed without a timer.
 *
 * PUBLIC — the `X-Twilio-Signature` check in `withIvr` is the only gate, and
 * it fails closed.
 */
import type { NextRequest } from 'next/server';
import { withIvr } from '@/lib/phone/ivrRoute';
import { holdTwiml } from '@/lib/phone/ivr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return withIvr(request, ({ query, state }) => {
    const loop = Number.parseInt(query.get('loop') ?? '0', 10);
    return holdTwiml(state.config, {
      loop: Number.isFinite(loop) && loop >= 0 ? loop : 0,
      closed: query.get('closed') === '1',
    });
  });
}
