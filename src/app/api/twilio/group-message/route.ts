/**
 * POST /api/twilio/group-message: somebody replied in a group text.
 *
 * Twilio Conversations calls this because each group is created with its own
 * webhook (`lib/phone/twilioGroups.ts`), so there is nothing to set per number in
 * the Twilio console. Public in `proxy.ts`, listed exactly: Twilio has no session,
 * and the signature check below is what stands in for one.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { integrationValues } from '@/lib/integrations/resolve';
import { recordGroupReply } from '@/lib/phone/groups';
import { isValidTwilioSignature, readTwilioForm, reconstructPublicUrl } from '@/lib/twilio/webhook-request';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const params = await readTwilioForm(request);
  const url = reconstructPublicUrl(request);
  if (!isValidTwilioSignature(request, url, params, (await integrationValues()).TWILIO_AUTH_TOKEN)) {
    return new NextResponse('Invalid signature', { status: 403 });
  }
  try {
    await recordGroupReply(params);
    return new NextResponse(null, { status: 200 });
  } catch (cause) {
    // A 500 makes Twilio retry, which the duplicate check inside makes safe.
    console.error('[group text] storing a reply failed', cause instanceof Error ? cause.message.slice(0, 200) : 'unknown');
    return new NextResponse(null, { status: 500 });
  }
}
