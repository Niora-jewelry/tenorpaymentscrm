/**
 * POST /api/twilio/voice — TwiML for BOTH outbound and inbound calls.
 *
 * Twilio fetches this one URL for two different flows, and it is configured in
 * two different places in the console:
 *   • the TwiML App's "Voice Request URL"   → OUTBOUND, from the browser Device
 *   • the phone number's "A CALL COMES IN"  → INBOUND, from the PSTN
 *
 * ── THE DISCRIMINATOR ────────────────────────────────────────────────────
 * A call the Voice SDK places arrives with `From = client:<identity>`; an
 * inbound PSTN call has `From = <caller E.164>`. So a `client:` prefix means
 * outbound. Donny's choice, and the documented Twilio shape — he verified it
 * live on 2026-07-27.
 *
 * ── WHAT CHANGED FOR TAPDASH ─────────────────────────────────────────────
 * The routing is his, unchanged in substance. Two things differ:
 *   • the lead lookup is gone. Where his code resolved the caller against
 *     `lead_gen_threads`, this resolves against sync-enabled phone fields on
 *     `records` (migration 69) — the CRM's own identity rule, already written
 *     on the Communication tab.
 *   • column names and the direction enum follow this schema (`from_e164`,
 *     `to_e164`, `'in'` / `'out'`).
 *
 * PUBLIC — the `X-Twilio-Signature` check is the only gate, and it fails closed.
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
import { resolveNumberOwnerId, resolveUserActiveNumber } from '@/lib/phone/numbers';
import { resolveRecordByPhone } from '@/lib/phone/records';
import { fileAutoContact } from '@/lib/phone/autoContact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ring the browser this long before giving up and offering voicemail. */
const INBOUND_RING_TIMEOUT_SECONDS = 20;
/** Cap on one voicemail message. */
const VOICEMAIL_MAX_LENGTH_SECONDS = 120;

export async function POST(request: NextRequest) {
  const params = await readTwilioForm(request);
  const url = reconstructPublicUrl(request);
  if (!isValidTwilioSignature(request, url, params)) {
    return new NextResponse('Invalid signature', { status: 403 });
  }

  const origin = publicOrigin(request);
  const from = params.From ?? '';
  const isOutbound = from.startsWith('client:');

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  // Service role: a webhook has no `auth.uid()`, so RLS cannot be the mechanism
  // here. Every write below is one this route is solely responsible for.
  const supabase = supabaseAdmin();

  if (isOutbound) {
    const to = params.To ?? '';
    if (!to) return new NextResponse('Missing To', { status: 400 });

    /*
     * Caller id is the ACTING USER'S OWN number, resolved from the Device
     * identity in `From` — the authoritative "who is dialling", independent of
     * whatever row the browser created. No assigned number means no valid
     * caller id, and we refuse rather than borrowing someone else's number.
     */
    const actingUserId = parseClientUserId(from);
    const myNumber = actingUserId ? await resolveUserActiveNumber(supabase, actingUserId) : null;

    if (!myNumber) {
      response.say('Your account has no phone number assigned. Please contact an administrator.');
      response.hangup();
      return xml(response);
    }

    // Our own row id round-trips on both callbacks. It is the reliable
    // correlation key — NOT the CallSid, because a <Dial>'s recording belongs
    // to the parent leg while the <Number> status callback reports the child,
    // and those SIDs differ.
    const callId = params.CallId ?? '';
    const cb = callId ? `?callId=${encodeURIComponent(callId)}` : '';

    /*
     * ⚠ STAMP THE PARENT CallSid NOW, not at the end of the call.
     *
     * `createOutboundCall` inserts the row BEFORE the browser dials, so it has
     * no SID. Nothing else wrote one until `/api/twilio/status` fired — and
     * that only fires on `completed`. So for the entire duration of a live
     * call the row read `status='queued', twilio_call_sid=null`, which is
     * character-for-character what a dial that never left the browser looks
     * like.
     *
     * Migration 89's sweep uses exactly that signature to retire dead dials,
     * so a real conversation lasting over two minutes would have been marked
     * 'failed' while it was still in progress. The final callback would later
     * correct it, but anyone watching the history mid-call saw a lie, and a
     * lost callback would have made it permanent.
     *
     * This is the first moment Twilio and our row id are both in hand, so it
     * is the right place. `status` is left alone — `/api/twilio/status` owns
     * that, and writing a guess here would race it.
     *
     * Failure is non-fatal: the call is worth more than the log entry.
     */
    if (callId && params.CallSid) {
      const { error: stampErr } = await supabase
        .from('phone_calls')
        .update({ twilio_call_sid: params.CallSid })
        .eq('id', callId)
        .is('twilio_call_sid', null);
      if (stampErr) console.error('[twilio/voice] could not stamp outbound CallSid', stampErr);
    }

    const dial = response.dial({
      callerId: myNumber.e164,
      answerOnBridge: true,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${origin}/api/twilio/recording${cb}`,
      recordingStatusCallbackEvent: ['completed'],
    });
    dial.number(
      {
        statusCallback: `${origin}/api/twilio/status${cb}`,
        statusCallbackEvent: ['completed'],
        statusCallbackMethod: 'POST',
      },
      to,
    );

    return xml(response);
  }

  // ── INBOUND ─────────────────────────────────────────────────────────────
  const caller = from;
  const dialedNumber = params.To ?? '';

  // One lookup drives both the row's owner and which browser rings. An unowned
  // number rings nobody and goes straight to voicemail — but the call is still
  // logged, with owner_id null, so it is admin-visible rather than lost.
  const ownerUserId = dialedNumber ? await resolveNumberOwnerId(supabase, dialedNumber) : null;
  // TapDash's identity rule: match the caller against sync-enabled phone fields.
  const recordId = await resolveRecordByPhone(supabase, caller);

  /*
   * An inbound call from a number the CRM already knows files a contact in
   * the number-owner's address book, per the client's rule. Awaited rather
   * than fired and forgotten: on a serverless runtime the response ends the
   * invocation, and a promise still in flight is simply killed. It never
   * throws, so it cannot cost the call.
   */
  await fileAutoContact(supabase, ownerUserId, caller, recordId);

  const identity = ownerUserId ? `user_${ownerUserId}` : null;

  const { data: inserted, error: insertErr } = await supabase
    .from('phone_calls')
    .insert({
      direction: 'in',
      /*
       * With an owner we ring, and the <Dial action> finalises the row from
       * DialCallStatus. With NO owner there is nobody to ring, so the row is
       * born terminal — otherwise it would sit at 'ringing' forever with
       * nothing ever coming to close it.
       */
      status: identity ? 'ringing' : 'no-answer',
      from_e164: caller,
      to_e164: dialedNumber,
      started_at: new Date().toISOString(),
      owner_id: ownerUserId,
      created_by_id: null,
      record_id: recordId,
      // Known here, unlike on an outbound row, and recorded immediately for
      // the same reason: without it a ringing inbound call is indistinguishable
      // from a dial that never happened, and migration 89's sweep would retire
      // it mid-conversation.
      twilio_call_sid: params.CallSid || null,
    })
    .select('id')
    .single();

  if (insertErr) {
    // Non-fatal: still ring the browser. The correlation callbacks simply will
    // not match, which loses the log entry rather than the call.
    console.error('[twilio/voice] inbound row insert failed', insertErr);
  }

  const rowId = (inserted?.id as string | undefined) ?? '';
  const cb = rowId ? `?callId=${encodeURIComponent(rowId)}` : '';
  const vmCb = rowId ? `?callId=${encodeURIComponent(rowId)}&kind=voicemail` : '?kind=voicemail';
  const vmDoneCb = rowId
    ? `?callId=${encodeURIComponent(rowId)}&phase=voicemail-end`
    : '?phase=voicemail-end';

  if (identity) {
    /*
     * The <Dial> carries an `action` URL so /inbound-status decides
     * voicemail-vs-hangup from DialCallStatus. Donny replaced post-<Dial>
     * fall-through with this, and it is the fix for the worst bug in the
     * module: fall-through left a voicemail after ANSWERED calls, and an
     * action-less <Record> re-requested this document and inserted a second row.
     */
    const dial = response.dial({
      callerId: caller,
      answerOnBridge: true,
      timeout: INBOUND_RING_TIMEOUT_SECONDS,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${origin}/api/twilio/recording${cb}`,
      recordingStatusCallbackEvent: ['completed'],
      action: `${origin}/api/twilio/inbound-status${cb}`,
      method: 'POST',
    });
    const client = dial.client(
      {
        statusCallback: `${origin}/api/twilio/status${cb}`,
        statusCallbackEvent: ['completed'],
        statusCallbackMethod: 'POST',
      },
      identity,
    );
    // These ride to the browser as `call.customParameters`, so the incoming-call
    // bar knows which row to finalise and who is calling.
    client.parameter({ name: 'CallId', value: rowId });
    client.parameter({ name: 'From', value: caller });

    return xml(response);
  }

  // Nobody to ring. Straight to voicemail, with an EXPLICIT terminal action —
  // never action-less, for the duplicate-row reason above.
  response.say('Please leave a message after the tone.');
  response.record({
    maxLength: VOICEMAIL_MAX_LENGTH_SECONDS,
    playBeep: true,
    recordingStatusCallback: `${origin}/api/twilio/recording${vmCb}`,
    recordingStatusCallbackEvent: ['completed'],
    action: `${origin}/api/twilio/inbound-status${vmDoneCb}`,
    method: 'POST',
  });

  return xml(response);
}

/** `client:user_<uuid>` → the uuid. Null when the shape does not match. */
function parseClientUserId(from: string): string | null {
  const prefix = 'client:user_';
  return from.startsWith(prefix) ? from.slice(prefix.length) : null;
}

function xml(response: InstanceType<typeof twilio.twiml.VoiceResponse>): NextResponse {
  return new NextResponse(response.toString(), {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}
