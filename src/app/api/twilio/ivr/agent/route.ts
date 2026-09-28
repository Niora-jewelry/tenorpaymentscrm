/**
 * POST /api/twilio/ivr/agent — what an answering phone hears.
 *
 * The other half of the queue: this bridges whoever answered to the
 * longest-waiting caller. Everyone else's phone stops ringing by itself once
 * the queue empties.
 *
 * PUBLIC — the `X-Twilio-Signature` check in `withIvr` is the only gate, and
 * it fails closed.
 */
import type { NextRequest } from 'next/server';
import { withIvr, queueDepth } from '@/lib/phone/ivrRoute';
import { agentTwiml } from '@/lib/phone/ivr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return withIvr(request, async ({ state }) => {
    /*
     * Two people can answer within the same second, and the second one would
     * otherwise be bridged to an empty queue and hear silence — which sounds
     * exactly like a broken phone system. Checking first turns that into a
     * clean hang-up.
     */
    if ((await queueDepth()) === 0) {
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
    }
    return agentTwiml(state.config);
  });
}
