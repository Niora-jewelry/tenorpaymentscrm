/**
 * POST /api/twilio/ivr/queue-done — the caller has left the queue.
 *
 * Twilio requests this when the <Enqueue> ends, and `QueueResult` says why.
 * Only one outcome needs TwiML: the caller left without being connected, and
 * is still on the line waiting to be told something. A bridged call must be
 * left alone — returning anything here would cut into a live conversation.
 *
 * PUBLIC — the `X-Twilio-Signature` check in `withIvr` is the only gate, and
 * it fails closed.
 */
import type { NextRequest } from 'next/server';
import { withIvr } from '@/lib/phone/ivrRoute';
import { voicemailTwiml } from '@/lib/phone/ivr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return withIvr(request, ({ params, query, state }) => {
    const result = params.QueueResult ?? '';
    const closed = query.get('closed') === '1';
    const callId = query.get('callId');

    // 'bridged' means an agent took the call: it is over, and it is not ours
    // to interrupt. 'hangup' means the caller is gone.
    if (result === 'bridged' || result === 'hangup') {
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
    }

    /*
     * Everything else — 'leave', 'redirected', 'error', 'system-error' — means
     * the caller is still there and nobody picked up. They were already told
     * why (the high-volume prompt, or the after-hours message), so the
     * voicemail announcement is suppressed and they go straight to the beep.
     */
    return voicemailTwiml(state.config, { callId, closed, announce: false });
  });
}
