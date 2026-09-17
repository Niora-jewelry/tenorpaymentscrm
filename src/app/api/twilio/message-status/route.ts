/**
 * POST /api/twilio/message-status — SMS delivery status.
 *
 * Wired inline: `sendMessage` passes this URL as `statusCallback` with
 * `?messageId=<phone_messages.id>`. No console configuration.
 *
 * ── STATUS IS WRITTEN RAW, ON PURPOSE ────────────────────────────────────
 * queued / sending / sent / delivered / undelivered / failed / read — whatever
 * Twilio says, stored verbatim, with no mapping and no CHECK constraint on the
 * column. Twilio's vocabulary drifts, and a fixed set would silently drop a
 * value the moment they add one. Donny's decision; kept, including the
 * reasoning.
 *
 * ⚠ If a bubble sits at "queued" forever in local development, the cause is
 * almost always `NEXT_PUBLIC_APP_URL` pointing at production instead of your
 * tunnel — the send succeeds and this callback is delivered to production.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  isValidTwilioSignature,
  readTwilioForm,
  reconstructPublicUrl,
} from '@/lib/twilio/webhook-request';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const params = await readTwilioForm(request);
  const url = reconstructPublicUrl(request);
  if (!isValidTwilioSignature(request, url, params)) {
    return new NextResponse('Invalid signature', { status: 403 });
  }

  const messageId = request.nextUrl.searchParams.get('messageId');
  if (!messageId) {
    console.warn('[twilio/message-status] callback without messageId; ignoring');
    return new NextResponse('OK', { status: 200 });
  }

  const patch: { status: string; twilio_message_sid?: string } = {
    status: params.MessageStatus || '',
  };
  if (params.MessageSid) patch.twilio_message_sid = params.MessageSid;

  const { error } = await supabaseAdmin()
    .from('phone_messages')
    .update(patch)
    .eq('id', messageId)
    .is('deleted_at', null);

  if (error) console.error('[twilio/message-status] update failed', error);

  return new NextResponse('OK', { status: 200 });
}
