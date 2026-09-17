/**
 * Shared Twilio webhook helpers — URL reconstruction and signature validation.
 *
 * Ported essentially unchanged from Donny's `lib/twilio/webhook-request.ts`.
 * It had zero coupling to the old CRM, and the two things it gets right are
 * the two things that are easiest to get wrong and hardest to diagnose.
 *
 * ── THE TWO WAYS TO GET OUR PUBLIC URL, AND WHY THEY DIFFER ──────────────
 * 1. `publicOrigin(request)` — rebuilt from an INCOMING Twilio request.
 *    Signature-critical: Twilio signs the exact external URL it POSTed to, and
 *    behind a proxy `request.url` is often the INTERNAL one, so the value we
 *    validate against must be reassembled from `x-forwarded-*`.
 *
 * 2. `getPublicBaseUrl()` — read from configuration, for SERVER ACTIONS.
 *    A server action is a POST from our own browser, not a request Twilio made
 *    through a public proxy, so there is no public forwarded host to sniff.
 *    On localhost the header technique yields `https://localhost:3000/...`,
 *    which Twilio rejects outright with error 21609 — the send fails, loudly.
 *
 * Donny's notes record that he originally predicted this would fail silently
 * and was wrong: Twilio validates the callback URL up front. Worth keeping,
 * because "loud" is what makes it findable.
 */
import 'server-only';
import twilio from 'twilio';
import type { NextRequest } from 'next/server';
import { serverEnv } from '@/lib/env.server';

/**
 * The exact public URL Twilio signed — INCLUDING the query string, because our
 * status and recording callbacks carry `?callId=<phone_calls.id>` and Twilio
 * signs the whole thing.
 *
 * If signature validation starts 403ing in production, this is the first
 * suspect: log the reconstructed value and compare it byte-for-byte with the
 * URL configured on the TwiML verb.
 */
export function reconstructPublicUrl(request: NextRequest): string {
  return `${publicOrigin(request)}${request.nextUrl.pathname}${request.nextUrl.search}`;
}

/** Absolute `proto://host` for building sibling callback URLs from an incoming
 *  Twilio request — it already arrived at the deployed host. */
export function publicOrigin(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  return `${proto}://${host}`;
}

/**
 * Our public base URL from configuration, for server-action-initiated calls
 * (SMS delivery callbacks, and any outbound dial we place ourselves).
 *
 * Returns null when `NEXT_PUBLIC_APP_URL` is unset so the caller can fail with
 * a clear configuration error rather than handing Twilio a URL it will reject.
 *
 * ⚠ LOCAL DEVELOPMENT: this must point at your tunnel (e.g. a cloudflared
 * `https://<random>.trycloudflare.com`), not at the production URL. Left at
 * production, the send SUCCEEDS and the callback is delivered to production —
 * so the status never updates locally and nothing appears in local logs. A
 * green send with a perpetually "queued" bubble means exactly this.
 */
export function getPublicBaseUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

/**
 * Parse a form-encoded Twilio POST into a flat string map.
 *
 * ⚠ `formData()` consumes the body — call this once per request and pass the
 * result around. A second call returns nothing, which looks like Twilio sending
 * an empty body.
 */
export async function readTwilioForm(request: NextRequest): Promise<Record<string, string>> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    params[key] = typeof value === 'string' ? value : '';
  }
  return params;
}

/**
 * Validate `X-Twilio-Signature`.
 *
 * ⚠ HMAC-SHA1 with the ACCOUNT auth token — never the API key secret. These
 * routes are publicly reachable by necessity (Twilio has no session), so this
 * check is the ONLY thing standing between the open internet and our Twilio
 * account. It fails CLOSED when the token is unset: no token, no trust.
 */
export function isValidTwilioSignature(
  request: NextRequest,
  url: string,
  params: Record<string, string>,
): boolean {
  const authToken = serverEnv.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error('[twilio] TWILIO_AUTH_TOKEN not set — rejecting webhook');
    return false;
  }
  const signature = request.headers.get('x-twilio-signature') ?? '';
  return twilio.validateRequest(authToken, signature, url, params);
}
