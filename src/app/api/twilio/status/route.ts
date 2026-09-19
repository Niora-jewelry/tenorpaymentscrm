/**
 * POST /api/twilio/status — the call leg finished; backfill the row.
 *
 * Wired inline by the voice route's `<Number statusCallback>` / `<Client
 * statusCallback>`, carrying `?callId=<phone_calls.id>`. Needs no console
 * configuration.
 *
 * ── WHY IT ALWAYS RETURNS 200 ────────────────────────────────────────────
 * Every handled case answers 200, including "row not found" and "update
 * failed". A non-2xx makes Twilio retry, and a route that 500s on a
 * genuinely-unmatchable callback gets retried until Twilio gives up — a
 * retry-storm against our own database for something no retry can fix. 403 for
 * a bad signature is the only non-2xx, and that one is not retryable either.
 *
 * The cost of that choice, stated plainly: a transient failure here is NOT
 * retried, so a row can be left un-finalised. A reconciliation sweep would fix
 * that and is deferred, exactly as Donny deferred it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  isValidTwilioSignature,
  readTwilioForm,
  reconstructPublicUrl,
} from '@/lib/twilio/webhook-request';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { notifyAboutCall } from '@/lib/phone/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** m:ss — the same shape the call list shows, so the bell and the log agree. */
function formatDuration(total: number): string {
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export async function POST(request: NextRequest) {
  const params = await readTwilioForm(request);
  const url = reconstructPublicUrl(request);
  if (!isValidTwilioSignature(request, url, params)) {
    return new NextResponse('Invalid signature', { status: 403 });
  }

  const callId = request.nextUrl.searchParams.get('callId');
  if (!callId) {
    console.warn('[twilio/status] callback without callId; ignoring');
    return new NextResponse('OK', { status: 200 });
  }

  const durationRaw = params.CallDuration;
  const duration = durationRaw ? Number.parseInt(durationRaw, 10) : null;

  const { error } = await supabaseAdmin()
    .from('phone_calls')
    .update({
      twilio_call_sid: params.CallSid || null,
      // Twilio's vocabulary, written raw — the column is deliberately
      // unconstrained because that vocabulary drifts.
      status: params.CallStatus || '',
      ended_at: new Date().toISOString(),
      duration_seconds: duration != null && !Number.isNaN(duration) ? duration : null,
    })
    .eq('id', callId)
    .is('deleted_at', null);

  if (error) console.error('[twilio/status] update failed', error);

  /*
   * The bell entry. Raised here rather than in the browser because the call
   * usually outlives the tab that placed it — and a missed call is precisely
   * the case where nobody was watching.
   */
  const status = params.CallStatus || '';
  const answered = status === 'completed' && (duration ?? 0) > 0;
  if (status && status !== 'in-progress' && status !== 'ringing' && status !== 'initiated') {
    await notifyAboutCall(supabaseAdmin(), callId, 'call', (peer) =>
      answered
        ? `Call with ${peer} ended${duration ? ` — ${formatDuration(duration)}` : ''}`
        : `Call with ${peer} ${status === 'no-answer' ? 'was not answered' : status}`,
    );
  }

  return new NextResponse('OK', { status: 200 });
}
