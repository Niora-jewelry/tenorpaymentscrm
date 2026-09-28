/**
 * POST /api/twilio/ivr/entry — the greeting.
 *
 * Reached when a call first arrives on the menu's number, and again after an
 * invalid entry. Which greeting is read is decided by `ivr_is_open` in SQL,
 * never here.
 *
 * PUBLIC — the `X-Twilio-Signature` check in `withIvr` is the only gate, and
 * it fails closed.
 */
import type { NextRequest } from 'next/server';
import { withIvr } from '@/lib/phone/ivrRoute';
import { greetingTwiml } from '@/lib/phone/ivr';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return withIvr(request, ({ state }) => greetingTwiml(state.config, { open: state.open }));
}
