/**
 * POST /api/twilio/recording — pull a finished recording into our own storage.
 *
 * Wired inline by `<Dial recordingStatusCallback>` and the voicemail
 * `<Record recordingStatusCallback>`. No console configuration.
 *
 * ── THE ORDER MATTERS ────────────────────────────────────────────────────
 * Download from Twilio → upload to our private bucket → insert the row → and
 * ONLY THEN delete the Twilio-side copy. Deleting earlier, or on a failed
 * upload, destroys the only copy of a call nobody can re-record. Donny got this
 * sequence right and it is preserved exactly.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────
 * Twilio retries callbacks. The partial unique index on `twilio_recording_sid`
 * is the real guard, but PostgREST cannot express that index's WHERE clause in
 * an ON CONFLICT, so this pre-checks and then tolerates a 23505 from a
 * concurrent retry. Both halves are needed: the pre-check avoids re-downloading
 * several megabytes, the 23505 tolerance handles the race the pre-check cannot.
 *
 * ── WHICH KIND ───────────────────────────────────────────────────────────
 * The voicemail callback carries `?kind=voicemail`; the answered-call callback
 * carries no kind and defaults to 'call'. Same storage path scheme for both, so
 * the bucket policy has one shape to gate on.
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
import { loadIvrState } from '@/lib/phone/ivrConfig';
import { deliverVoicemail } from '@/lib/phone/voicemailEmail';
import { serverEnv } from '@/lib/env.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BUCKET = 'phone-recordings';

export async function POST(request: NextRequest) {
  const params = await readTwilioForm(request);
  const url = reconstructPublicUrl(request);
  if (!isValidTwilioSignature(request, url, params)) {
    return new NextResponse('Invalid signature', { status: 403 });
  }

  const accountSid = serverEnv.TWILIO_ACCOUNT_SID;
  const authToken = serverEnv.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    console.error('[twilio/recording] Twilio is not configured');
    return new NextResponse('OK', { status: 200 });
  }

  const recordingSid = params.RecordingSid || '';
  const recordingUrl = params.RecordingUrl || '';
  const durationRaw = params.RecordingDuration;
  const duration = durationRaw ? Number.parseInt(durationRaw, 10) : null;
  const callSid = params.CallSid || '';
  const callId = request.nextUrl.searchParams.get('callId');
  const origin = publicOrigin(request);
  const kind = request.nextUrl.searchParams.get('kind') === 'voicemail' ? 'voicemail' : 'call';

  if (!recordingSid || !recordingUrl) {
    console.warn('[twilio/recording] missing RecordingSid/Url; ignoring');
    return new NextResponse('OK', { status: 200 });
  }

  const supabase = supabaseAdmin();

  /*
   * Correlate. Primary key is OUR row id from the query string, which sidesteps
   * the parent/child leg-SID ambiguity entirely: a <Dial> recording belongs to
   * the parent leg while the status callback reports the child, so matching on
   * CallSid across the two is fragile. The SID is a fallback only.
   */
  let callRowId: string | null = null;

  if (callId) {
    const { data } = await supabase
      .from('phone_calls')
      .select('id')
      .eq('id', callId)
      .is('deleted_at', null)
      .maybeSingle();
    callRowId = (data?.id as string | undefined) ?? null;
  }
  if (!callRowId && callSid) {
    const { data } = await supabase
      .from('phone_calls')
      .select('id')
      .eq('twilio_call_sid', callSid)
      .is('deleted_at', null)
      .maybeSingle();
    callRowId = (data?.id as string | undefined) ?? null;
  }
  if (!callRowId) {
    console.warn(`[twilio/recording] no phone_calls row for callId=${callId} callSid=${callSid}`);
    return new NextResponse('OK', { status: 200 });
  }

  const { data: existing } = await supabase
    .from('phone_recordings')
    .select('id')
    .eq('twilio_recording_sid', recordingSid)
    .is('deleted_at', null)
    .maybeSingle();

  // `calls/<phone_calls.id>/<sid>.mp3` — the bucket policy reads the call id out
  // of segment 2, so this shape is load-bearing, not cosmetic.
  const storagePath = `calls/${callRowId}/${recordingSid}.mp3`;

  if (!existing) {
    const mp3Url = `${recordingUrl}.mp3`;
    const basic = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    let audio: Buffer;
    try {
      const res = await fetch(mp3Url, { headers: { Authorization: `Basic ${basic}` } });
      if (!res.ok) {
        console.error(`[twilio/recording] download failed: ${res.status}`);
        return new NextResponse('OK', { status: 200 });
      }
      audio = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      console.error('[twilio/recording] download threw', err);
      return new NextResponse('OK', { status: 200 });
    }

    const upload = await supabase.storage.from(BUCKET).upload(storagePath, audio, {
      contentType: 'audio/mpeg',
      upsert: true, // overwrite a partial earlier attempt
    });
    if (upload.error) {
      console.error('[twilio/recording] upload failed', upload.error);
      return new NextResponse('OK', { status: 200 });
    }

    const insert = await supabase.from('phone_recordings').insert({
      call_id: callRowId,
      kind,
      storage_path: storagePath,
      twilio_recording_sid: recordingSid,
      duration_seconds: duration != null && !Number.isNaN(duration) ? duration : null,
      transcript: null,
    });
    if (insert.error && insert.error.code !== '23505') {
      console.error('[twilio/recording] insert failed', insert.error);
      return new NextResponse('OK', { status: 200 });
    }

    /*
     * Announced only after a CONFIRMED store — not when Twilio finishes
     * recording. A bell entry offering to play audio that is not in our bucket
     * yet sends the listener to a spinner. The duplicate-key branch above
     * deliberately falls through to here without notifying twice: 23505 means
     * this callback is a retry of one already handled.
     */
    if (!insert.error) {
      await notifyAboutCall(supabaseAdmin(), callRowId, kind === 'voicemail' ? 'voicemail' : 'recording', (peer) =>
        kind === 'voicemail'
          ? `New voicemail from ${peer}`
          : `Recording ready for your call with ${peer}`,
      );

      /*
       * ── THE VOICEMAIL EMAIL ───────────────────────────────────────────
       * Both of the client's documents say voicemail goes to info@tapdash.co,
       * in capitals, twice each. This is the only place that can send it: the
       * audio is not ours until the upload above succeeds, so emailing any
       * earlier would attach a file that does not exist yet.
       *
       * Inside the `!insert.error` branch on purpose — a 23505 means this
       * callback is a retry of one already handled, and the caller should not
       * receive two copies of the same voicemail.
       */
      if (kind === 'voicemail') {
        const { data: rec } = await supabase
          .from('phone_recordings')
          .select('id, duration_seconds, phone_calls (from_e164, to_e164)')
          .eq('twilio_recording_sid', recordingSid)
          .maybeSingle();

        const state = await loadIvrState(supabaseAdmin(), origin);
        const call = (rec as { phone_calls?: { from_e164: string; to_e164: string } } | null)
          ?.phone_calls;

        if (rec?.id) {
          await deliverVoicemail(supabaseAdmin(), {
            recordingId: rec.id as string,
            storagePath,
            toEmail: state.voicemailEmail,
            callerE164: call?.from_e164 ?? null,
            dialedE164: call?.to_e164 ?? null,
            durationSeconds: (rec.duration_seconds as number | null) ?? null,
            appOrigin: origin,
          });
        }
      }
    }
  }

  // ONLY after a confirmed store. Never on a failed upload above.
  try {
    await twilio(accountSid, authToken).recordings(recordingSid).remove();
  } catch (err) {
    // Non-fatal — the audio is already safe with us. A stale Twilio copy costs
    // a little storage until someone sweeps it.
    console.error('[twilio/recording] Twilio delete failed', err);
  }

  return new NextResponse('OK', { status: 200 });
}
