/**
 * GET /api/twilio/token — a Voice SDK access token for the signed-in user.
 *
 * ⚠ THIS TOKEN CAN PLACE CALLS BILLED TO THE CLIENT'S TWILIO ACCOUNT. It is the
 * one endpoint here that is NOT public: Twilio never calls it, our own browser
 * does, so it stays session-gated and must never be added to `PUBLIC_API_PATHS`.
 *
 * ── AUTHORIZATION IS AN ASSIGNED NUMBER ──────────────────────────────────
 * Donny's design, kept: holding an active number in `phone_numbers` IS the
 * permission to use telephony, and the admin Numbers screen is therefore the
 * single control over spend. No number, no token, 403 with a reason — not a
 * silent empty token, and not a 401, which would read as "log in again".
 *
 * TapDash adds a second gate on top, because it has one and the old CRM did
 * not: the `communication/phone` SUBTAB grant. A user whose template hides that
 * subtab cannot dial, even holding a number. Both gates are cheap and answer
 * different questions — "is telephony paid for on your behalf" and "are you
 * allowed to use it".
 */
import { NextResponse } from 'next/server';
import twilio from 'twilio';
import { authorize, NotAuthenticatedError } from '@/lib/records/permissions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { resolveUserActiveNumber } from '@/lib/phone/numbers';
import { serverEnv } from '@/lib/env.server';
import { canUsePhone } from '@/lib/phone/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One hour. The browser refreshes on Twilio's `tokenWillExpire` event. */
const TOKEN_TTL_SECONDS = 3600;

export async function GET() {
  let ctx;
  try {
    ctx = await authorize();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
    }
    throw error;
  }

  if (!(await canUsePhone(ctx))) {
    return NextResponse.json({ error: 'phone_not_permitted' }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const myNumber = await resolveUserActiveNumber(supabase, ctx.userId);
  if (!myNumber) {
    return NextResponse.json({ error: 'no_phone_number_assigned' }, { status: 403 });
  }

  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID } =
    serverEnv;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
    console.error('[twilio/token] Twilio is not configured');
    return NextResponse.json({ error: 'twilio_not_configured' }, { status: 500 });
  }

  /*
   * The identity ties this token — and every call placed with it — to a CRM
   * user. It is what inbound routing dials (`<Client>user_<uuid></Client>`), so
   * it MUST match what `/api/twilio/voice` builds from `phone_numbers.user_id`.
   * If those two ever disagree the browser simply never rings, with no error
   * anywhere. Same string, built in two places, by design of the Twilio API.
   */
  const identity = `user_${ctx.userId}`;

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: TWILIO_TWIML_APP_SID,
    // Required for INBOUND: an identity is only addressable if its Device holds
    // a token granting incoming calls.
    incomingAllow: true,
  });

  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
    identity,
    ttl: TOKEN_TTL_SECONDS,
  });
  token.addGrant(voiceGrant);

  return NextResponse.json(
    { token: token.toJwt(), identity, from: myNumber.e164 },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
