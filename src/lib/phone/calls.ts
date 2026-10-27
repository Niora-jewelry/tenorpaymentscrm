/**
 * Calls, voicemail and recordings — the data layer.
 *
 * Every function takes an `AuthContext`, per CLAUDE.md rule 2: forgetting to
 * authorise has to be a compile error, not something a reviewer notices. The
 * gate is asked first, before any query.
 *
 * ── TWO BOUNDARIES, NOT ONE ──────────────────────────────────────────────
 * The checks here are the APPLICATION half. Underneath, `phone_calls` is
 * record-scoped by RLS and `phone_recordings` is owner-and-admin only
 * (migration 68). These functions can narrow that; they can never widen it. A
 * mistake here leaks nothing — which is the point of putting the real rule in
 * the database.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { type AuthContext } from '@/lib/records/permissions';
import { canSeePhone, canUsePhone, canHearRecordings } from './access';
import { resolveUserActiveNumber } from './numbers';
import { resolveRecordByPhone } from './records';
import { fileAutoContact } from './autoContact';
import { normalizePhone } from './normalize';
import { loadConfig } from '@/lib/records/config';
import { moduleGrant } from '@/lib/records/permissions';

export type PhoneCall = {
  id: string;
  recordId: string | null;
  direction: 'in' | 'out';
  fromE164: string;
  toE164: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  ownerId: string | null;
  recordings: PhoneRecording[];
};

export type PhoneRecording = {
  id: string;
  kind: 'call' | 'voicemail';
  durationSeconds: number | null;
  /** Null while Twilio is still delivering it — the UI shows "Processing…". */
  storagePath: string | null;
};

/**
 * A call nobody answered. Keyed on Twilio's own terminal vocabulary, which is
 * exactly why `status` is stored raw rather than mapped into our own set.
 */
export function isMissedCall(call: PhoneCall): boolean {
  return call.direction === 'in' && ['no-answer', 'busy', 'failed'].includes(call.status);
}

type CallRow = {
  id: string;
  record_id: string | null;
  direction: 'in' | 'out';
  from_e164: string;
  to_e164: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  owner_id: string | null;
  phone_recordings: {
    id: string;
    kind: 'call' | 'voicemail';
    duration_seconds: number | null;
    storage_path: string | null;
  }[] | null;
};

function toCall(row: CallRow): PhoneCall {
  return {
    id: row.id,
    recordId: row.record_id,
    direction: row.direction,
    fromE164: row.from_e164,
    toE164: row.to_e164,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    ownerId: row.owner_id,
    recordings: (row.phone_recordings ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      durationSeconds: r.duration_seconds,
      storagePath: r.storage_path,
    })),
  };
}

const CALL_SELECT =
  'id, record_id, direction, from_e164, to_e164, status, started_at, ended_at, duration_seconds, owner_id, phone_recordings(id, kind, duration_seconds, storage_path)';

/**
 * Correct any dial that never reached Twilio, before the history is read.
 *
 * `createOutboundCall` writes the row first (its id is the correlation key the
 * callbacks carry), so a hand-off that never happens — microphone denied, CSP,
 * a dead token, a closed tab — leaves a row at 'queued' that no callback will
 * ever finalise. See migration 89.
 *
 * Done on the read path rather than on a schedule because there is no
 * scheduler here and this needs none: the only moment a stale row matters is
 * when somebody looks at the list, and the sweep is a no-op once it has run.
 * Failures are swallowed deliberately — a tidy-up must never be the reason the
 * call history fails to load.
 */
async function expireStaleCalls(): Promise<void> {
  const { error } = await supabaseAdmin().rpc('expire_stale_phone_calls');
  if (error) console.error('[phone] expireStaleCalls failed', error);
}

/**
 * Every call on one record, newest first.
 *
 * The embedded recordings come back filtered by their OWN policy, so a
 * colleague who can see the record gets the call with an empty `recordings`
 * array rather than a playable link. That asymmetry is deliberate — see
 * migration 68.
 */
export async function callsForRecord(ctx: AuthContext, recordId: string): Promise<PhoneCall[]> {
  if (!(await canSeePhone(ctx))) return [];

  await expireStaleCalls();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('phone_calls')
    .select(CALL_SELECT)
    .eq('record_id', recordId)
    .is('deleted_at', null)
    .order('started_at', { ascending: false });

  if (error) throw error;
  return ((data ?? []) as CallRow[]).map(toCall);
}

/** This user's own call history, across every record and none. */
export async function callsForUser(ctx: AuthContext, limit = 100): Promise<PhoneCall[]> {
  if (!(await canSeePhone(ctx))) return [];

  await expireStaleCalls();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('phone_calls')
    .select(CALL_SELECT)
    .eq('owner_id', ctx.userId)
    .is('deleted_at', null)
    .order('started_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as CallRow[]).map(toCall);
}

/**
 * Create the row the browser is about to dial against.
 *
 * ⚠ THE ROW COMES FIRST, AND THAT IS THE WHOLE CORRELATION DESIGN. Its id is
 * handed to Twilio as a custom parameter, comes back on both the status and
 * recording callbacks, and is what those callbacks match on. Matching on
 * CallSid instead would be fragile: a `<Dial>` recording belongs to the parent
 * leg while the status callback reports the child, and the two SIDs differ.
 */
export async function createOutboundCall(
  ctx: AuthContext,
  toRaw: string,
): Promise<
  | { ok: true; callId: string; fromE164: string; toE164: string }
  | { ok: false; error: 'not_permitted' | 'no_number' | 'bad_number' }
> {
  if (!(await canUsePhone(ctx))) return { ok: false, error: 'not_permitted' };

  const normalized = normalizePhone(toRaw);
  if (!normalized.ok) return { ok: false, error: 'bad_number' };

  const supabase = await createSupabaseServerClient();
  const myNumber = await resolveUserActiveNumber(supabase, ctx.userId);
  if (!myNumber) return { ok: false, error: 'no_number' };

  /*
   * Service role for the INSERT. `phone_calls` grants no INSERT to
   * `authenticated` (migration 68) precisely so there is one writer, and the
   * gate above has already decided this is allowed. The row's owner is set from
   * the authorised context, never from anything the browser sent.
   */
  // Resolved once and used twice - for the row and for the address book.
  // Two lookups of the same number would be two chances to disagree.
  const outboundRecordId = await resolveRecordByPhone(supabaseAdmin(), normalized.e164);

  const { data, error } = await supabaseAdmin()
    .from('phone_calls')
    .insert({
      direction: 'out',
      status: 'queued',
      from_e164: myNumber.e164,
      to_e164: normalized.e164,
      owner_id: ctx.userId,
      created_by_id: ctx.userId,
      record_id: outboundRecordId,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw error;

  /*
   * Dialling a number that belongs to a merchant files it in the caller's
   * address book. After the insert, not before: the call is what matters, and
   * a failure filing a contact must not stop it being placed.
   */
  await fileAutoContact(supabaseAdmin(), ctx.userId, normalized.e164, outboundRecordId);
  return {
    ok: true,
    callId: data.id as string,
    fromE164: myNumber.e164,
    toE164: normalized.e164,
  };
}

/**
 * A short-lived link to one recording's audio.
 *
 * Takes the RECORDING'S ID, never a storage path. The same lesson the Files and
 * Statements download paths learned the hard way: a caller-supplied path with
 * an unread context means the caller picks the file and the permission model
 * never runs. Here the path is resolved from the id, after the gate.
 */
export async function signedRecordingUrl(
  ctx: AuthContext,
  recordingId: string,
): Promise<string> {
  if (!(await canHearRecordings(ctx))) throw new Error('No access to call recordings.');

  const supabase = await createSupabaseServerClient();

  // RLS restricts this read to the call's owner and admins, so a recording this
  // viewer may not hear simply is not here — "not yours" and "does not exist"
  // give the same answer.
  const { data, error } = await supabase
    .from('phone_recordings')
    .select('storage_path')
    .eq('id', recordingId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw error;
  const storagePath = (data?.storage_path as string | undefined) ?? null;
  if (!storagePath) throw new Error('Not found');

  const { data: signed, error: signError } = await supabase.storage
    .from('phone-recordings')
    .createSignedUrl(storagePath, 60);

  if (signError) throw signError;
  return signed.signedUrl;
}

/**
 * The URL for one call: its record's Communication tab, else the Phone page.
 *
 * Shares the "first module this viewer can open" rule with the notification
 * bell — a call and its notification must not disagree about where the call
 * lives. Kept here rather than in `notifications.ts` because the input is a
 * call id; the bell's version starts from a record id.
 */
export async function callDestination(ctx: AuthContext, callId: string): Promise<string> {
  const FALLBACK = '/phone';
  if (!callId) return FALLBACK;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('phone_calls')
    .select('record_id')
    .eq('id', callId)
    .maybeSingle();
  // A call the viewer cannot see reads as null here, and the Phone page is the
  // right answer for that too: it will simply not be listed.
  if (error || !data?.record_id) return FALLBACK;

  const recordId = data.record_id as string;
  const { data: mods } = await supabase
    .from('record_modules')
    .select('module_id')
    .eq('record_id', recordId);

  const config = await loadConfig();
  const inRecord = new Set((mods ?? []).map((m) => m.module_id as string));
  for (const m of config.modules) {
    if (m.adminOnly || !inRecord.has(m.id)) continue;
    if ((await moduleGrant(ctx, m.id, m.adminOnly)) !== 'hidden') {
      return `/${m.slug}?record=${recordId}&tab=communication&subtab=phone&view=recordings`;
    }
  }
  return FALLBACK;
}
