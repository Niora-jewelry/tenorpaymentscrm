/**
 * POST /api/twilio/message — an inbound SMS arrived.
 *
 * Configured PER NUMBER in the Twilio console: Phone number → Messaging →
 * "A MESSAGE COMES IN". Every new number needs this set before inbound texts
 * work on it — it is not an account-level setting.
 *
 * ── THE EMPTY TwiML IS DELIBERATE ────────────────────────────────────────
 * Returning `<Response></Response>` acknowledges the message without sending an
 * auto-reply. Returning nothing, or an error, makes Twilio retry.
 *
 * ── NOTE ON INBOUND VERSUS OUTBOUND GATING ───────────────────────────────
 * Inbound SMS is NOT gated by A2P 10DLC or toll-free registration — those
 * govern outbound application-to-person traffic only. So a working inbound
 * thread proves nothing about whether sending will work. Do not read one as
 * evidence of the other; Donny flagged this specifically.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  isValidTwilioSignature,
  readTwilioForm,
  reconstructPublicUrl,
} from '@/lib/twilio/webhook-request';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { resolveNumberOwnerId } from '@/lib/phone/numbers';
import { resolveRecordByPhone } from '@/lib/phone/records';
import { fileAutoContact } from '@/lib/phone/autoContact';
import { isStartKeyword, isStopKeyword } from '@/lib/sms/consentText';
import { recordConsent, revokeConsent } from '@/lib/sms/consent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const params = await readTwilioForm(request);
  const url = reconstructPublicUrl(request);
  if (!isValidTwilioSignature(request, url, params)) {
    return new NextResponse('Invalid signature', { status: 403 });
  }

  const from = params.From || '';
  const to = params.To || '';
  const body = params.Body ?? '';
  const messageSid = params.MessageSid || '';

  if (!from || !messageSid) {
    console.warn('[twilio/message] missing From/MessageSid; ignoring');
    return emptyTwiml();
  }

  const supabase = supabaseAdmin();

  /*
   * ── OPT-OUT AND OPT-IN ────────────────────────────────────────────────
   * Twilio acts on STOP at its own layer, so a merchant who replies STOP
   * stops receiving messages whether or not this runs. That is NOT a reason
   * to skip recording it: Twilio's copy of the fact is not in our audit
   * trail, and without this the CRM would go on showing the person as
   * consented and offering a Text button while the carrier silently refused
   * every message.
   *
   * Recorded before the message is stored, so the two cannot disagree if the
   * insert below fails. The message itself is still logged either way — an
   * opt-out is part of the conversation and deleting it would hide why the
   * thread stopped.
   */
  if (isStopKeyword(body)) {
    const n = await revokeConsent(from, 'replied STOP');
    console.info('[sms] opt-out recorded', { from, revoked: n });
  } else if (isStartKeyword(body)) {
    /*
     * START restores consent, and the wording stored is the verbal script
     * rather than the web form's: what they actually agreed to was a text
     * message asking them to reply START, not a checkbox they never saw.
     */
    await recordConsent({
      e164: from,
      source: 'verbal',
      note: 'Re-subscribed by replying START to a text message.',
    });
    console.info('[sms] opt-in restored by START', { from });
  }

  // Idempotency, same shape as the recording route: pre-check, insert, tolerate
  // a 23505 from a concurrent retry.
  const { data: existing } = await supabase
    .from('phone_messages')
    .select('id')
    .eq('twilio_message_sid', messageSid)
    .is('deleted_at', null)
    .maybeSingle();

  if (!existing) {
    // Owner is whoever holds the number this was sent TO. Null for an unowned
    // number — recorded anyway, admin-visible, rather than dropped.
    const ownerUserId = to ? await resolveNumberOwnerId(supabase, to) : null;
    const recordId = await resolveRecordByPhone(supabase, from);

    const insert = await supabase.from('phone_messages').insert({
      direction: 'in',
      status: 'received',
      from_e164: from,
      to_e164: to,
      body,
      thread_key: from, // the other party's number — the conversation key
      twilio_message_sid: messageSid,
      owner_id: ownerUserId,
      created_by_id: null,
      record_id: recordId,
      sent_at: new Date().toISOString(),
    });

    // An inbound text from a number the CRM knows files a contact for the
    // owner of the number it came in on. Awaited, because a promise left in
    // flight when the response returns is killed on a serverless runtime.
    await fileAutoContact(supabase, ownerUserId, from, recordId);

    if (insert.error && insert.error.code !== '23505') {
      console.error('[twilio/message] insert failed', insert.error);
    }
  }

  return emptyTwiml();
}

/** Acknowledge without auto-replying. */
function emptyTwiml(): NextResponse {
  return new NextResponse('<Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}
