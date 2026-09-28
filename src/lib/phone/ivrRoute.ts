/**
 * The plumbing every phone-menu route repeats.
 *
 * Eight routes all need the same four things: verify Twilio's signature, work
 * out our own public origin, load the menu's configuration, and return XML.
 * Written once, because the signature check is the ONLY thing standing between
 * these endpoints and the open internet — they take no session and are
 * reachable by anyone who knows the URL. Eight copies of a security check is
 * seven chances to write it slightly differently.
 */
import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import twilio from 'twilio';
import {
  isValidTwilioSignature,
  publicOrigin,
  readTwilioForm,
  reconstructPublicUrl,
} from '@/lib/twilio/webhook-request';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadIvrState, type IvrState } from './ivrConfig';
import { SALES_QUEUE, type IvrTarget } from './ivr';

export type IvrRequest = {
  params: Record<string, string>;
  query: URLSearchParams;
  state: IvrState;
  origin: string;
};

/** Wrap a handler with the signature check and the config load. */
export async function withIvr(
  request: NextRequest,
  handler: (ctx: IvrRequest) => Promise<string> | string,
): Promise<NextResponse> {
  const params = await readTwilioForm(request);
  const url = reconstructPublicUrl(request);

  // Fails closed, always. An unsigned request is not from Twilio.
  if (!isValidTwilioSignature(request, url, params)) {
    return new NextResponse('Invalid signature', { status: 403 });
  }

  const origin = publicOrigin(request);
  const state = await loadIvrState(supabaseAdmin(), origin);

  const body = await handler({
    params,
    query: new URL(request.url).searchParams,
    state,
    origin,
  });

  return new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

/**
 * Ring everybody who should ring, while the caller waits in the queue.
 *
 * ── WHY THIS IS REST AND NOT TwiML ───────────────────────────────────────
 * The caller is in a queue listening to music, which is the only way to give
 * them hold music at all. A queued call is not in a <Dial>, so there is no
 * TwiML that can also be ringing people — the calls to the agents have to be
 * ORIGINATED, as new outbound calls, and bridged back into the queue when one
 * is answered.
 *
 * ── FAILURES ARE SWALLOWED ON PURPOSE ────────────────────────────────────
 * The caller is already on hold by the time this runs. If a number is
 * unreachable or the API rejects one leg, the right outcome is that the others
 * still ring and the caller still eventually reaches voicemail — not a 500
 * that makes Twilio retry the whole document and enqueue them a second time.
 */
export async function ringTargets(
  state: IvrState,
  targets: IvrTarget[],
  callerId: string,
): Promise<number> {
  if (targets.length === 0) return 0;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error('[ivr] cannot ring: Twilio credentials are not configured');
    return 0;
  }

  const client = twilio(sid, token);
  const agentUrl = `${state.config.origin}/api/twilio/ivr/agent`;

  const results = await Promise.allSettled(
    targets.map((t) =>
      client.calls.create({
        url: agentUrl,
        method: 'POST',
        // Everyone rings at once and the first to answer takes the call —
        // Q8: "WHATEVER THE DOC SAYS MEANS AT THE SAME TIME".
        to: t.userId ? `client:user_${t.userId}` : (t.externalE164 as string),
        from: callerId,
        timeout: state.config.ringSeconds,
      }),
    ),
  );

  let rang = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') rang += 1;
    else console.error(`[ivr] could not ring ${targets[i].label}`, r.reason);
  });

  return rang;
}

/** Callers still waiting, so a late answer is not bridged to silence. */
export async function queueDepth(): Promise<number> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return 0;

  try {
    const client = twilio(sid, token);
    // The API has no filter by name, so the match happens here. The account
    // holds a handful of queues at most, so listing them is cheap.
    const queues = await client.queues.list({ limit: 50 });
    return queues.find((q) => q.friendlyName === SALES_QUEUE)?.currentSize ?? 0;
  } catch (error) {
    console.error('[ivr] could not read the queue', error);
    return 0;
  }
}
