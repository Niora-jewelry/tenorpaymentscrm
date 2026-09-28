/**
 * POST /api/twilio/ivr/discover — after the settlement message.
 *
 * The document: pressing 1, or waiting thirty seconds, transfers to a
 * representative. Q13 settled the rest: any other key is an invalid entry.
 *
 * PUBLIC — the `X-Twilio-Signature` check in `withIvr` is the only gate, and
 * it fails closed.
 */
import type { NextRequest } from 'next/server';
import { withIvr, ringTargets } from '@/lib/phone/ivrRoute';
import { enqueueTwiml, invalidTwiml, noTargetsTwiml } from '@/lib/phone/ivr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return withIvr(request, async ({ params, query, state }) => {
    const digits = params.Digits || query.get('Digits') || '';
    const timedOut = query.get('timedOut') === '1';

    // Anything other than 1, when they did press something, is invalid.
    if (!timedOut && digits && digits !== '1') {
      return invalidTwiml(state.config, { open: state.open });
    }

    if (state.targets.length === 0) {
      return noTargetsTwiml(state.config, { closed: !state.open });
    }

    const callerId = state.mainNumberE164 ?? params.To ?? '';
    await ringTargets(state, state.targets, callerId);
    return enqueueTwiml(state.config, { closed: !state.open });
  });
}
