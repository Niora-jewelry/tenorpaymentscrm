/**
 * SMS — the data layer.
 *
 * Same posture as `calls.ts`: an `AuthContext` first, the gate before any
 * query, and RLS underneath as the boundary that actually holds.
 *
 * ── SENDING ORDER, AND WHY IT IS INSERT-FIRST ────────────────────────────
 * Insert the row → send via Twilio → update with the SID and status. The insert
 * has to come first because the row's id IS the correlation key we hand Twilio
 * as `?messageId=` on the delivery callback. If the send throws, the row is
 * marked failed rather than left sitting at "queued" forever pretending to be
 * in flight.
 */
import 'server-only';
import twilio from 'twilio';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { seesAll, type AuthContext } from '@/lib/records/permissions';
import { serverEnv } from '@/lib/env.server';
import { getPublicBaseUrl } from '@/lib/twilio/webhook-request';
import { canSeePhone, canUsePhone } from './access';
import { resolveUserActiveNumber } from './numbers';
import { resolveRecordByPhone } from './records';
import { fileAutoContact } from './autoContact';
import { isOptedOut } from '@/lib/sms/consent';
import { normalizePhone } from './normalize';

export type PhoneMessage = {
  id: string;
  recordId: string | null;
  threadKey: string;
  direction: 'in' | 'out';
  fromE164: string;
  toE164: string;
  body: string | null;
  status: string;
  sentAt: string;
};

type MessageRow = {
  id: string;
  record_id: string | null;
  thread_key: string;
  direction: 'in' | 'out';
  from_e164: string;
  to_e164: string;
  body: string | null;
  status: string;
  sent_at: string;
};

const MESSAGE_SELECT =
  'id, record_id, thread_key, direction, from_e164, to_e164, body, status, sent_at';

function toMessage(row: MessageRow): PhoneMessage {
  return {
    id: row.id,
    recordId: row.record_id,
    threadKey: row.thread_key,
    direction: row.direction,
    fromE164: row.from_e164,
    toE164: row.to_e164,
    body: row.body,
    status: row.status,
    sentAt: row.sent_at,
  };
}

/** Every text on one record, oldest first — a conversation reads downward. */
export async function messagesForRecord(
  ctx: AuthContext,
  recordId: string,
): Promise<PhoneMessage[]> {
  if (!(await canSeePhone(ctx))) return [];

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('phone_messages')
    .select(MESSAGE_SELECT)
    .eq('record_id', recordId)
    .is('deleted_at', null)
    .order('sent_at', { ascending: true });

  if (error) throw error;
  return ((data ?? []) as MessageRow[]).map(toMessage);
}

/** One conversation with one number, wherever it landed. */
export async function messagesForThread(
  ctx: AuthContext,
  threadKey: string,
): Promise<PhoneMessage[]> {
  if (!(await canSeePhone(ctx))) return [];

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('phone_messages')
    .select(MESSAGE_SELECT)
    .eq('thread_key', threadKey)
    .is('deleted_at', null)
    .order('sent_at', { ascending: true });

  if (error) throw error;
  return ((data ?? []) as MessageRow[]).map(toMessage);
}

export type SendResult =
  | { ok: true; message: PhoneMessage }
  | {
      ok: false;
      error:
        | 'not_permitted'
        | 'no_number'
        | 'bad_number'
        | 'not_configured'
        | 'opted_out'
        | 'send_failed';
      detail?: string;
    };

/**
 * Send one text.
 *
 * ⚠ CARRIER REGISTRATION IS NOT SOMETHING THIS CAN CHECK. A US number cannot
 * text US numbers until A2P 10DLC (local) or toll-free verification completes,
 * and there is no API that tells us in advance — the only signal is the send
 * failing at Twilio with error 30034. Both of the client's numbers are pending
 * that registration at the time of writing, so sends to unverified numbers will
 * fail here with `send_failed` and Twilio's own message. That is carrier state,
 * not a defect.
 */
export async function sendMessage(
  ctx: AuthContext,
  toRaw: string,
  body: string,
): Promise<SendResult> {
  if (!(await canUsePhone(ctx))) return { ok: false, error: 'not_permitted' };

  const normalized = normalizePhone(toRaw);
  if (!normalized.ok) return { ok: false, error: 'bad_number' };

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = serverEnv;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return { ok: false, error: 'not_configured' };

  /*
   * The callback URL comes from CONFIGURATION, not from request headers.
   * A server action is a POST from our own browser, not a request Twilio made
   * through a public proxy, so there is no public forwarded host to read — on
   * localhost the header technique yields https://localhost:3000/… and Twilio
   * rejects the entire send with error 21609. Checked BEFORE the insert so a
   * misconfiguration cannot leave an orphan row behind.
   */
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      error: 'not_configured',
      detail: 'NEXT_PUBLIC_APP_URL is not set — Twilio needs a public callback URL.',
    };
  }

  /*
   * ── THE OPT-OUT GATE ──────────────────────────────────────────────────
   * Checked BEFORE the row is inserted, so a refused message leaves no
   * outbound record claiming it was queued.
   *
   * Only an explicit revocation blocks. A number with no consent record is
   * fine to text — somebody who messaged us first and is waiting for a reply
   * has no record, and refusing that would break the product while protecting
   * nobody.
   *
   * The inbound webhook has revoked consent on STOP since the consent work
   * landed; nothing consulted it on the way out, so the revocation was
   * recorded and then ignored. Twilio would have refused the send itself with
   * 21610, which is the carrier-level backstop — but as a cryptic failure
   * after the fact rather than a sentence before it.
   */
  if (await isOptedOut(normalized.e164)) {
    return { ok: false, error: 'opted_out' };
  }

  const supabase = await createSupabaseServerClient();
  const myNumber = await resolveUserActiveNumber(supabase, ctx.userId);
  if (!myNumber) return { ok: false, error: 'no_number' };

  const admin = supabaseAdmin();
  const recordId = await resolveRecordByPhone(admin, normalized.e164);

  const { data: inserted, error: insertError } = await admin
    .from('phone_messages')
    .insert({
      direction: 'out',
      status: 'queued',
      from_e164: myNumber.e164,
      to_e164: normalized.e164,
      body,
      thread_key: normalized.e164,
      owner_id: ctx.userId,
      created_by_id: ctx.userId,
      record_id: recordId,
      sent_at: new Date().toISOString(),
    })
    .select(MESSAGE_SELECT)
    .single();

  if (insertError) throw insertError;

  // Texting a merchant's number files them in the sender's address book.
  await fileAutoContact(admin, ctx.userId, normalized.e164, recordId);
  const row = inserted as MessageRow;

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const sent = await client.messages.create({
      to: normalized.e164,
      from: myNumber.e164,
      body,
      statusCallback: `${baseUrl}/api/twilio/message-status?messageId=${encodeURIComponent(row.id)}`,
    });

    const { data: updated } = await admin
      .from('phone_messages')
      .update({ twilio_message_sid: sent.sid, status: sent.status ?? 'sent' })
      .eq('id', row.id)
      .select(MESSAGE_SELECT)
      .single();

    return { ok: true, message: toMessage((updated ?? row) as MessageRow) };
  } catch (cause) {
    // Mark it failed rather than leaving it queued — a message that will never
    // arrive must not keep looking like one that is still on its way.
    await admin.from('phone_messages').update({ status: 'failed' }).eq('id', row.id);
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error('[phone] sendMessage failed', cause);
    return { ok: false, error: 'send_failed', detail };
  }
}

export type PhoneThread = {
  threadKey: string;
  /** The merchant this number belongs to, when it matches one. */
  recordId: string | null;
  lastBody: string | null;
  lastAt: string;
  lastDirection: 'in' | 'out';
  count: number;
};

/**
 * This user's SMS conversations, newest first.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * Without it, a text from a number matching no record has NOWHERE to appear.
 * The drawer's Text subtab filters by `record_id`, so an unmatched message is
 * stored correctly, counted correctly, and invisible — the worst kind of bug,
 * because nothing looks broken and a merchant's reply simply never arrives.
 *
 * Grouping happens here rather than in SQL because the page size is small (one
 * user's conversations) and a DISTINCT ON would need a second query for the
 * counts anyway.
 */
export async function threadsForUser(ctx: AuthContext, limit = 200): Promise<PhoneThread[]> {
  if (!(await canSeePhone(ctx))) return [];

  const supabase = await createSupabaseServerClient();
  // Phone = All users: every line's texts (RLS still decides, migration 9813).
  let query = supabase.from('phone_messages').select(MESSAGE_SELECT);
  if (!(await seesAll(ctx, 'phone'))) query = query.eq('owner_id', ctx.userId);
  const { data, error } = await query
    .is('deleted_at', null)
    .order('sent_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const byThread = new Map<string, PhoneThread>();
  for (const row of (data ?? []) as MessageRow[]) {
    const existing = byThread.get(row.thread_key);
    if (existing) {
      existing.count += 1;
      // Rows arrive newest-first, so the first one seen is already the latest.
      if (!existing.recordId && row.record_id) existing.recordId = row.record_id;
      continue;
    }
    byThread.set(row.thread_key, {
      threadKey: row.thread_key,
      recordId: row.record_id,
      lastBody: row.body,
      lastAt: row.sent_at,
      lastDirection: row.direction,
      count: 1,
    });
  }
  return [...byThread.values()];
}
