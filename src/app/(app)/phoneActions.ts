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
import { createOutboundCall, signedRecordingUrl, callDestination } from '@/lib/phone/calls';
import { sendMessage } from '@/lib/phone/messages';
import { createSupabaseServerClient } from '@/lib/supabase/server';

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
  error:
    | 'not_permitted'
    | 'no_number'
    | 'bad_number'
    | 'not_configured'
    | 'opted_out'
    | 'send_failed',
  detail?: string,
): string {
  if (error === 'not_permitted') return 'You do not have permission to send texts.';
  if (error === 'no_number') return 'You have no phone number assigned. Ask an administrator.';
  if (error === 'bad_number') return 'That does not look like a phone number.';
  if (error === 'not_configured') return detail ?? 'Texting is not configured on this deployment.';
  /*
   * Said as a decision the person made, not as a system error, because that is
   * what it is — and because the only correct response is to stop, not to
   * retry or to find a way around it.
   */
  if (error === 'opted_out') {
    return 'This number has replied STOP. They cannot be texted again until they text START.';
  }
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

/* ---------------------------------------------------------------------------
 * Removing telephony history
 *
 * Each of these is a thin pass-through to a SECURITY DEFINER function that
 * makes the permission decision itself (migration 91): the owner of the call or
 * an administrator, and — when the item is attached to a record — Edit on that
 * record's Communication tab. Deliberately NOT decided here: an action is one
 * caller, and CLAUDE.md rule 2 puts the gate below the app layer so a second
 * caller cannot forget it.
 *
 * `revalidatePath` on both surfaces, because the same call appears in two
 * places: the record drawer and the standalone Phone page. Refreshing only the
 * one the click came from leaves the other showing a row that is gone.
 * ------------------------------------------------------------------------ */

/** The database's own words when it refuses, so "you may not delete this" does
 *  not arrive as a blank error. Next masks a thrown Server Action message in
 *  production, which is why every guard in this app returns rather than throws. */
type DeleteResult = { ok: true } | { ok: false; message: string };

async function runDelete(fn: string, id: string, moduleSlug?: string): Promise<DeleteResult> {
  await authorize();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc(fn, Object.fromEntries([[PARAM[fn], id]]));

  if (error) {
    const known = error.message && !error.message.includes('not found');
    return {
      ok: false,
      message: known ? error.message : 'That item no longer exists.',
    };
  }

  if (moduleSlug) revalidatePath(`/${moduleSlug}`);
  revalidatePath('/phone');
  return { ok: true };
}

const PARAM: Record<string, string> = {
  delete_phone_call: 'p_call_id',
  delete_phone_recording: 'p_recording_id',
  delete_phone_message: 'p_message_id',
};

export async function deleteCallAction(callId: string, moduleSlug?: string): Promise<DeleteResult> {
  return runDelete('delete_phone_call', callId, moduleSlug);
}

export async function deleteRecordingAction(
  recordingId: string,
  moduleSlug?: string,
): Promise<DeleteResult> {
  return runDelete('delete_phone_recording', recordingId, moduleSlug);
}

export async function deleteSmsAction(
  messageId: string,
  moduleSlug?: string,
): Promise<DeleteResult> {
  return runDelete('delete_phone_message', messageId, moduleSlug);
}

/**
 * Where to send someone who wants to see a call they were just on.
 *
 * Returns the record's Communication → Call recordings tab when the number
 * matched a merchant, and the Phone page when it did not — which is every call
 * to a number the CRM has never seen. Never null: there is always somewhere to
 * go, because the Phone page lists your own calls whether they matched or not.
 *
 * Resolved on the server so it lands in a module this viewer can actually open.
 * The browser knows the call id and nothing else; asking it to work out the
 * module would mean shipping the module list and the grant map to the client.
 */
export async function callDestinationAction(callId: string): Promise<string> {
  const ctx = await authorize();
  return callDestination(ctx, callId);
}
