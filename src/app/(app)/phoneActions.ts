'use server';

/**
 * Server actions for the phone module.
 *
 * Thin shells, exactly like `[module]/actions.ts`: authorise, call the data
 * layer, revalidate. Every rule lives in `lib/phone/*` so a second caller
 * cannot skip it — the gate is below the app layer on purpose (CLAUDE.md
 * rule 2).
 *
 * In its own file rather than inside `[module]/actions.ts` because the phone is
 * not per-module: the same three actions serve the record drawer and the
 * standalone phone page.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { createOutboundCall, signedRecordingUrl } from '@/lib/phone/calls';
import { sendMessage } from '@/lib/phone/messages';

/** Parse, never trust — CLAUDE.md rule 6, at every server boundary. */
const dialSchema = z.object({
  to: z.string().trim().min(3, 'Enter a number to call.').max(32),
});

const sendSchema = z.object({
  to: z.string().trim().min(3, 'Enter a number to text.').max(32),
  /*
   * 1600 is Twilio's hard ceiling for a single message; past it the API rejects
   * the send outright. Refusing here means the user is told before a row is
   * written, rather than seeing a message appear and then fail.
   */
  body: z.string().trim().min(1, 'Type a message first.').max(1600),
});

export type DialState =
  | { ok: true; callId: string; fromE164: string; toE164: string }
  | { ok: false; message: string };

export type SendState = { ok: true } | { ok: false; message: string };

/**
 * Create the `phone_calls` row the browser is about to dial against, and hand
 * back its id.
 *
 * ⚠ The id is the correlation key: the browser passes it to Twilio as a custom
 * parameter, and it comes back on both the status and recording callbacks. A
 * dial that skipped this would connect fine and log nothing.
 */
export async function dialAction(to: string): Promise<DialState> {
  const ctx = await authorize();

  const parsed = dialSchema.safeParse({ to });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'That number is not valid.' };
  }

  const result = await createOutboundCall(ctx, parsed.data.to);
  if (!result.ok) {
    return { ok: false, message: dialRefusal(result.error) };
  }
  return { ok: true, callId: result.callId, fromE164: result.fromE164, toE164: result.toE164 };
}

function dialRefusal(error: 'not_permitted' | 'no_number' | 'bad_number'): string {
  if (error === 'not_permitted') return 'You do not have permission to make calls.';
  if (error === 'no_number') return 'You have no phone number assigned. Ask an administrator.';
  return 'That does not look like a phone number.';
}

export async function sendSmsAction(
  to: string,
  body: string,
  revalidate?: string,
): Promise<SendState> {
  const ctx = await authorize();

  const parsed = sendSchema.safeParse({ to, body });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'That message is not valid.' };
  }

  const result = await sendMessage(ctx, parsed.data.to, parsed.data.body);

  if (!result.ok) {
    if (revalidate) revalidatePath(revalidate);
    return { ok: false, message: sendRefusal(result.error, result.detail) };
  }

  if (revalidate) revalidatePath(revalidate);
  return { ok: true };
}

function sendRefusal(
  error: 'not_permitted' | 'no_number' | 'bad_number' | 'not_configured' | 'send_failed',
  detail?: string,
): string {
  if (error === 'not_permitted') return 'You do not have permission to send texts.';
  if (error === 'no_number') return 'You have no phone number assigned. Ask an administrator.';
  if (error === 'bad_number') return 'That does not look like a phone number.';
  if (error === 'not_configured') return detail ?? 'Texting is not configured on this deployment.';
  /*
   * Twilio's own words, surfaced rather than swallowed. The most likely message
   * here is error 30034 — the sending number is not yet registered for A2P
   * 10DLC — and that is carrier state an admin has to resolve in the Twilio
   * console. A generic "sending failed" would send someone hunting through
   * application logs for a problem that is not in the application.
   */
  return detail ? `Twilio refused the message: ${detail}` : 'The message could not be sent.';
}

/** A 60-second link to one recording, addressed BY ITS ID — never a path. */
export async function getRecordingUrlAction(recordingId: string): Promise<string> {
  const ctx = await authorize();
  return signedRecordingUrl(ctx, recordingId);
}
