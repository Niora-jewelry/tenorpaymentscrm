/**
 * POST /api/twilio/inbound-status — the inbound `<Dial action>` finaliser.
 *
 * ── THE BUG THIS ROUTE EXISTS TO PREVENT ─────────────────────────────────
 * The obvious way to offer voicemail is to put `<Record>` after `<Dial>` and
 * rely on TwiML fall-through. Donny's notes call that "the highest-consequence
 * unverified item for INBOUND calling", and he was right to distrust it: it
 * left voicemails after ANSWERED calls, and an action-less `<Record>` defaulted
 * to re-requesting its document URL, which re-ran the inbound branch of
 * /api/twilio/voice and inserted a SECOND call row.
 *
 * So the decision is made explicitly instead, from `DialCallStatus`:
 *   no-answer | busy | failed  → record a voicemail
 *   completed (answered)       → hang up, record nothing
 *   canceled (caller gone)     → hang up, record nothing
 *
 * He verified all four inbound cases live on 2026-07-27: voicemail appeared
 * only on ring-out and reject, never on answered, and no duplicate row.
 *
 * ⚠ One residue he flagged, carried over: the exact DialCallStatus a BROWSER
 * REJECT produces (as opposed to a PSTN no-answer) was never logged. Behaviour
 * was correct, but if `VOICEMAIL_DIAL_STATUSES` is ever tuned, re-confirm which
 * status a reject yields before trusting the set.
 */
import { NextResponse, type NextRequest } from 'next/server';
import twilio from 'twilio';
import {
  isValidTwilioSignature,
  publicOrigin,
  readTwilioForm,
  reconstructPublicUrl,
} from '@/lib/twilio/webhook-request';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { notifyAboutCall } from '@/lib/phone/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Nobody picked up and the caller is still on the line. */
const VOICEMAIL_DIAL_STATUSES = new Set(['no-answer', 'busy', 'failed']);
const VOICEMAIL_MAX_LENGTH_SECONDS = 120;

export async function POST(request: NextRequest) {
  const params = await readTwilioForm(request);
  const url = reconstructPublicUrl(request);
  if (!isValidTwilioSignature(request, url, params)) {
    return new NextResponse('Invalid signature', { status: 403 });
  }

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const callId = request.nextUrl.searchParams.get('callId');
  const phase = request.nextUrl.searchParams.get('phase');

  /*
   * PHASE 2 — the voicemail <Record>'s own terminal action. The message has
   * already been delivered to /api/twilio/recording by its own callback, and
   * the row is already terminal. Write NOTHING; just end the call. This phase
   * exists purely so <Record> can never fall back to re-requesting its document.
   */
  if (phase === 'voicemail-end') {
    response.hangup();
    return xml(response);
  }

  // PHASE 1 — the <Dial> action.
  const dialStatus = params.DialCallStatus ?? '';
  const dialSid = params.DialCallSid || null;
  const dialDurationRaw = params.DialCallDuration;
  const dialDuration = dialDurationRaw ? Number.parseInt(dialDurationRaw, 10) : null;

  if (callId && dialStatus) {
    // UPDATE only, NEVER insert. Exactly one inbound row exists — the one
    // /api/twilio/voice created — and this handler only finalises it.
    const { error } = await supabaseAdmin()
      .from('phone_calls')
      .update({
        status: dialStatus,
        ended_at: new Date().toISOString(),
        duration_seconds: dialDuration != null && !Number.isNaN(dialDuration) ? dialDuration : null,
        ...(dialSid ? { twilio_call_sid: dialSid } : {}),
      })
      .eq('id', callId)
      .is('deleted_at', null);

    if (error) console.error('[twilio/inbound-status] finalize failed', error);

    /*
     * The bell entry for an inbound call. A missed one matters most — it is by
     * definition the call nobody was present for, so the notification is the
     * only thing that will bring anyone back to it.
     */
    const answered = dialStatus === 'completed';
    await notifyAboutCall(supabaseAdmin(), callId, 'call', (peer) =>
      answered ? `Call with ${peer} ended` : `Missed call from ${peer}`,
    );
  }

  if (VOICEMAIL_DIAL_STATUSES.has(dialStatus)) {
    const origin = publicOrigin(request);
    const vmCb = callId ? `?callId=${encodeURIComponent(callId)}&kind=voicemail` : '?kind=voicemail';
    const vmDoneCb = callId
      ? `?callId=${encodeURIComponent(callId)}&phase=voicemail-end`
      : '?phase=voicemail-end';

    response.say('Please leave a message after the tone.');
    response.record({
      maxLength: VOICEMAIL_MAX_LENGTH_SECONDS,
      playBeep: true,
      recordingStatusCallback: `${origin}/api/twilio/recording${vmCb}`,
      recordingStatusCallbackEvent: ['completed'],
      // Explicit, never action-less. See the header.
      action: `${origin}/api/twilio/inbound-status${vmDoneCb}`,
      method: 'POST',
    });
    return xml(response);
  }

  response.hangup();
  return xml(response);
}

function xml(response: InstanceType<typeof twilio.twiml.VoiceResponse>): NextResponse {
  return new NextResponse(response.toString(), {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}
