/**
 * Broadcast texting: one message, sent as a separate 1-to-1 text to each person.
 * A reply therefore arrives in the normal thread with that person.
 *
 * ── CONSENT ───────────────────────────────────────────────────────────────
 * Stricter than a 1-to-1 text on purpose. A 1-to-1 is blocked only by an explicit
 * opt-out, because somebody may be waiting on a reply. A broadcast is outreach
 * nobody asked for at that moment, so it also skips any number with no consent on
 * file, and the sender sees the counts before sending.
 *
 * ── AT MOST ONCE ──────────────────────────────────────────────────────────
 * A worker that dies mid-send may or may not have reached Twilio, so that row is
 * reported failed and never retried. A missed text can be sent again by hand; a
 * text sent twice cannot be taken back.
 */
import 'server-only';
import twilio from 'twilio';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { permissionsFor, type AuthContext } from '@/lib/records/permissions';
import { integrationValues } from '@/lib/integrations/resolve';
import { getPublicBaseUrl } from '@/lib/twilio/webhook-request';
import { RATE_LIMITS, rateLimit, userKey } from '@/lib/security/rate-limit';
import { consentStates, isOptedOut } from '@/lib/sms/consent';
import { fileAutoContact } from './autoContact';
import { MAX_BROADCAST_RECIPIENTS, parseRecipients } from './bulkRules';
import { resolveUserActiveNumber } from './numbers';
import { resolveRecordByPhone } from './records';

/** The one question both broadcast and group texting ask first. */
export async function canTextMany(ctx: AuthContext): Promise<boolean> {
  if (ctx.isAdmin) return true;
  const p = await permissionsFor(ctx);
  return p.settings['phone.bulk'] === 'yes';
}

export type BroadcastPreview = {
  willReceive: number;
  optedOut: number;
  noConsent: number;
  duplicates: number;
  invalid: string[];
  overLimit: boolean;
};

export type BroadcastRefusal =
  | 'not_permitted'
  | 'no_number'
  | 'not_configured'
  | 'no_recipients'
  | 'too_many'
  | 'rate_limited'
  | 'not_found';

async function sort(values: string[]) {
  const parsed = parseRecipients(values);
  const states = await consentStates(parsed.numbers);
  const queued: string[] = [];
  const optedOut: string[] = [];
  const noConsent: string[] = [];
  for (const n of parsed.numbers) {
    const state = states.get(n) ?? 'none';
    if (state === 'consented') queued.push(n);
    else if (state === 'opted_out') optedOut.push(n);
    else noConsent.push(n);
  }
  return { parsed, queued, optedOut, noConsent };
}

export async function previewBroadcast(
  ctx: AuthContext,
  values: string[],
): Promise<{ ok: true; preview: BroadcastPreview } | { ok: false; error: BroadcastRefusal }> {
  if (!(await canTextMany(ctx))) return { ok: false, error: 'not_permitted' };
  const { parsed, queued, optedOut, noConsent } = await sort(values);
  return {
    ok: true,
    preview: {
      willReceive: queued.length,
      optedOut: optedOut.length,
      noConsent: noConsent.length,
      duplicates: parsed.duplicates,
      invalid: parsed.invalid.slice(0, 20),
      overLimit: parsed.numbers.length > MAX_BROADCAST_RECIPIENTS,
    },
  };
}

export async function createBroadcast(
  ctx: AuthContext,
  values: string[],
  body: string,
): Promise<{ ok: true; broadcastId: string; willReceive: number } | { ok: false; error: BroadcastRefusal }> {
  if (!(await canTextMany(ctx))) return { ok: false, error: 'not_permitted' };

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = await integrationValues();
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !getPublicBaseUrl()) return { ok: false, error: 'not_configured' };

  const admin = supabaseAdmin();
  const myNumber = await resolveUserActiveNumber(admin, ctx.userId);
  if (!myNumber) return { ok: false, error: 'no_number' };

  const { parsed, queued, optedOut, noConsent } = await sort(values);
  if (parsed.numbers.length > MAX_BROADCAST_RECIPIENTS) return { ok: false, error: 'too_many' };
  if (queued.length === 0) return { ok: false, error: 'no_recipients' };

  const limited = await rateLimit(userKey('sms_broadcast', ctx.userId), RATE_LIMITS.smsBroadcastPerUserHour);
  if (!limited.allowed) return { ok: false, error: 'rate_limited' };

  const { data, error } = await admin.rpc('sms_broadcast_create', {
    p_created_by: ctx.userId,
    p_from: myNumber.e164,
    p_body: body,
    p_queued: queued,
    p_opted_out: optedOut,
    p_no_consent: noConsent,
  });
  if (error) throw error;
  return { ok: true, broadcastId: data as string, willReceive: queued.length };
}

export type BroadcastView = {
  id: string;
  body: string;
  status: 'sending' | 'finished' | 'stopped';
  fromE164: string;
  total: number;
  createdAt: string;
  mine: boolean;
  counts: { waiting: number; sent: number; failed: number; skipped: number; cancelled: number };
};

/** The latest broadcasts this person may see. RLS decides which those are. */
export async function broadcastsForUser(ctx: AuthContext): Promise<BroadcastView[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('sms_broadcasts')
    .select('id, body, status, from_e164, total, created_at, created_by')
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  const rows = (data ?? []) as {
    id: string;
    body: string;
    status: BroadcastView['status'];
    from_e164: string;
    total: number;
    created_at: string;
    created_by: string | null;
  }[];
  if (rows.length === 0) return [];

  const { data: tallies, error: tallyError } = await supabase.rpc('sms_broadcast_counts', { p_ids: rows.map((r) => r.id) });
  if (tallyError) throw tallyError;

  const counts = new Map<string, BroadcastView['counts']>();
  for (const t of (tallies ?? []) as { broadcast_id: string; status: string; n: number }[]) {
    const c = counts.get(t.broadcast_id) ?? { waiting: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 };
    if (t.status === 'queued' || t.status === 'sending') c.waiting += t.n;
    else if (t.status === 'sent') c.sent += t.n;
    else if (t.status === 'failed') c.failed += t.n;
    else if (t.status === 'cancelled') c.cancelled += t.n;
    else c.skipped += t.n;
    counts.set(t.broadcast_id, c);
  }

  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    status: r.status,
    fromE164: r.from_e164,
    total: r.total,
    createdAt: r.created_at,
    mine: r.created_by === ctx.userId,
    counts: counts.get(r.id) ?? { waiting: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 },
  }));
}

export type BroadcastLine = { e164: string; status: string; error: string | null };

/** Everyone who did not get it, and why. RLS decides whether the broadcast is visible. */
export async function broadcastProblems(ctx: AuthContext, broadcastId: string): Promise<BroadcastLine[]> {
  if (!(await canTextMany(ctx))) return [];
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('sms_broadcast_recipients')
    .select('e164, status, error')
    .eq('broadcast_id', broadcastId)
    .in('status', ['failed', 'skipped_opted_out', 'skipped_no_consent', 'cancelled'])
    .order('status')
    .limit(MAX_BROADCAST_RECIPIENTS);
  if (error) throw error;
  return (data ?? []) as BroadcastLine[];
}

/** Stops whatever has not gone yet. Texts already handed to Twilio cannot be called back. */
export async function stopBroadcast(
  ctx: AuthContext,
  broadcastId: string,
): Promise<{ ok: true; cancelled: number } | { ok: false; error: BroadcastRefusal }> {
  if (!(await canTextMany(ctx))) return { ok: false, error: 'not_permitted' };

  const admin = supabaseAdmin();
  const { data: row, error } = await admin
    .from('sms_broadcasts')
    .select('created_by, status')
    .eq('id', broadcastId)
    .maybeSingle();
  if (error) throw error;
  if (!row || (row.created_by !== ctx.userId && !ctx.isAdmin)) return { ok: false, error: 'not_found' };

  const { error: stopError } = await admin
    .from('sms_broadcasts')
    .update({ status: 'stopped', finished_at: new Date().toISOString() })
    .eq('id', broadcastId)
    .eq('status', 'sending');
  if (stopError) throw stopError;

  const { data: cancelled, error: cancelError } = await admin
    .from('sms_broadcast_recipients')
    .update({ status: 'cancelled' })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'queued')
    .select('id');
  if (cancelError) throw cancelError;
  return { ok: true, cancelled: cancelled?.length ?? 0 };
}

export type SmsSender = {
  create(input: { to: string; from: string; body: string; statusCallback: string }): Promise<{ sid: string; status?: string }>;
};

type Claim = { recipient_id: string; broadcast_id: string; e164: string };
type Broadcast = { id: string; created_by: string | null; from_e164: string; body: string };

async function sendOne(admin: ReturnType<typeof supabaseAdmin>, sender: SmsSender, baseUrl: string, claim: Claim, b: Broadcast) {
  const finish = (fields: Record<string, unknown>) =>
    admin.from('sms_broadcast_recipients').update(fields).eq('id', claim.recipient_id);

  // They may have replied STOP after this was queued.
  if (await isOptedOut(claim.e164)) {
    await finish({ status: 'skipped_opted_out' });
    return;
  }

  const recordId = await resolveRecordByPhone(admin, claim.e164);
  const { data: inserted, error: insertError } = await admin
    .from('phone_messages')
    .insert({
      direction: 'out',
      status: 'queued',
      from_e164: b.from_e164,
      to_e164: claim.e164,
      body: b.body,
      thread_key: claim.e164,
      owner_id: b.created_by,
      created_by_id: b.created_by,
      record_id: recordId,
      sent_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (insertError) {
    await finish({ status: 'failed', error: 'Could not save this text, so it was not sent.' });
    console.error('[broadcast] message insert failed', insertError.code);
    return;
  }
  const messageId = inserted.id as string;
  await fileAutoContact(admin, b.created_by, claim.e164, recordId);

  try {
    const sent = await sender.create({
      to: claim.e164,
      from: b.from_e164,
      body: b.body,
      statusCallback: `${baseUrl}/api/twilio/message-status?messageId=${encodeURIComponent(messageId)}`,
    });
    await admin.from('phone_messages').update({ twilio_message_sid: sent.sid, status: sent.status ?? 'sent' }).eq('id', messageId);
    await finish({ status: 'sent', message_id: messageId });
  } catch (cause) {
    const note = cause instanceof Error ? cause.message.slice(0, 200) : 'Twilio refused this text.';
    await admin.from('phone_messages').update({ status: 'failed' }).eq('id', messageId);
    await finish({ status: 'failed', message_id: messageId, error: note });
  }
}

/**
 * Sends what is queued, at about one text a second, until the time runs out. The
 * pace is enforced by `sms_broadcast_claim`, so overlapping runs do not add up.
 * Runs from the per-minute cron, and straight after a broadcast is created.
 */
export async function drainBroadcasts(budgetMs: number, deps: { sender?: SmsSender } = {}): Promise<{ handled: number }> {
  const admin = supabaseAdmin();
  const started = Date.now();
  let handled = 0;

  const settle = async () => {
    const { error } = await admin.rpc('sms_broadcast_settle');
    if (error) throw error;
  };
  await settle();

  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = await integrationValues();
  const baseUrl = getPublicBaseUrl();
  // Left queued, not failed: the keys coming back should finish the job.
  if (!baseUrl || (!deps.sender && (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN))) return { handled };
  const sender: SmsSender = deps.sender ?? twilio(TWILIO_ACCOUNT_SID!, TWILIO_AUTH_TOKEN!).messages;

  const broadcasts = new Map<string, Broadcast>();
  while (Date.now() - started < budgetMs) {
    const { data, error } = await admin.rpc('sms_broadcast_claim');
    if (error) throw error;
    const claim = ((data ?? []) as Claim[])[0];

    if (!claim) {
      const { data: pending, error: pendingError } = await admin.rpc('sms_broadcast_pending');
      if (pendingError) throw pendingError;
      if (!pending) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }

    let b = broadcasts.get(claim.broadcast_id);
    if (!b) {
      const { data: row, error: readError } = await admin
        .from('sms_broadcasts')
        .select('id, created_by, from_e164, body')
        .eq('id', claim.broadcast_id)
        .single();
      if (readError) throw readError;
      b = row as Broadcast;
      broadcasts.set(b.id, b);
    }
    await sendOne(admin, sender, baseUrl, claim, b);
    handled += 1;
  }
  await settle();
  return { handled };
}
