/**
 * POST /api/twilio/ivr/hold-choice — pressing 1 while on hold.
 *
 * "If you would like to leave a voicemail, please press 1. Otherwise, simply
 * remain on the line." Anything that is not 1 returns to the music, because
 * the document gives waiting callers no other option and dropping them for a
 * mistyped key would be the wrong reading.
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
  return withIvr(request, ({ params, query, state }) => {
    const closed = query.get('closed') === '1';

    if ((params.Digits || '') === '1') {
      /*
       * <Leave> takes the caller out of the queue and hands control to the
       * <Enqueue action>, which is where voicemail happens. Recording here
       * instead would leave them queued while they spoke, so an agent could
       * be bridged into the middle of their own voicemail.
       */
      return '<?xml version="1.0" encoding="UTF-8"?><Response><Leave/></Response>';
    }

    // Back to the music, and the offer comes round again next minute.
    return holdTwiml(state.config, { loop: 1, closed });
  });
}
