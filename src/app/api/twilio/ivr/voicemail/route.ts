/**
 * POST /api/twilio/ivr/voicemail — record a message.
 *
 * Reached from a direct extension that nobody answered, and from anywhere else
 * that runs out of options. The recording callback files it and emails it.
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
  return withIvr(request, ({ query, state }) =>
    voicemailTwiml(state.config, {
      callId: query.get('callId'),
      closed: !state.open,
    }),
  );
}
