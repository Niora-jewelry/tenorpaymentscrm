/**
 * POST /api/twilio/ivr/menu — what the caller pressed at the greeting.
 *
 * The one branch worth reading twice is `none`. During hours the document says
 * an unanswered menu should still reach a representative ("please stay on the
 * line"), so silence is routed to option 1. After hours there is nobody to
 * stay on the line for, so it repeats the greeting instead of abandoning the
 * caller in silence.
 *
 * PUBLIC — the `X-Twilio-Signature` check in `withIvr` is the only gate, and
 * it fails closed.
 */
import type { NextRequest } from 'next/server';
import { withIvr, ringTargets } from '@/lib/phone/ivrRoute';
import {
  discoverTwiml,
  enqueueTwiml,
  extensionTwiml,
  greetingTwiml,
  interpretDigits,
  invalidTwiml,
  noTargetsTwiml,
  supportTransferTwiml,
  voicemailTwiml,
} from '@/lib/phone/ivr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return withIvr(request, async ({ params, query, state }) => {
    // Twilio posts Digits; the timeout redirect passes them in the query.
    const digits = params.Digits || query.get('Digits') || '';
    const choice = interpretDigits(digits, state.extensions);

    if (choice.kind === 'extension') {
      const target = state.extensions.find((e) => e.digits === choice.digits);
      if (target) return extensionTwiml(state.config, { target });
      return invalidTwiml(state.config, { open: state.open });
    }

    if (choice.kind === 'invalid') {
      return invalidTwiml(state.config, { open: state.open });
    }

    if (choice.kind === 'none') {
      return state.open
        ? await toQueue(state, params)
        : greetingTwiml(state.config, { open: false });
    }

    // ── the three published options ──────────────────────────────────────
    if (choice.digit === '1') {
      return toQueue(state, params);
    }

    if (choice.digit === '2') {
      /*
       * The two documents disagree about what 2 means, and both are right:
       * during hours it is merchant support and forwards away; after hours it
       * is "to leave a voicemail, press 2". Branching on the hour is the whole
       * of the difference.
       */
      return state.open
        ? supportTransferTwiml(state.config)
        : voicemailTwiml(state.config, { closed: true });
    }

    // 3 — the Discover settlement. Offered during hours only; the closed
    // greeting sends people to the website instead and never mentions a 3.
    return state.open
      ? discoverTwiml(state.config)
      : invalidTwiml(state.config, { open: false });
  });
}

/**
 * Put the caller on hold and start everybody's phone ringing.
 *
 * With nobody configured to ring — the state the system is in until the client
 * supplies extensions — this goes straight to voicemail rather than queueing
 * someone into silence.
 */
async function toQueue(
  state: Awaited<ReturnType<typeof import('@/lib/phone/ivrConfig').loadIvrState>>,
  params: Record<string, string>,
) {
  if (state.targets.length === 0) {
    return noTargetsTwiml(state.config, { closed: !state.open });
  }

  // Caller id for the outbound legs is the number they dialled, so an agent's
  // mobile shows the office number rather than the caller's.
  const callerId = state.mainNumberE164 ?? params.To ?? '';
  await ringTargets(state, state.targets, callerId);

  return enqueueTwiml(state.config, { closed: !state.open });
}
