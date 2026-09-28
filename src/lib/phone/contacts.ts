/**
 * The dialer's address book — reads and writes.
 *
 * ── WHY EVERY FUNCTION TAKES A CONTEXT, NOT A userId ─────────────────────
 * CLAUDE.md rule 2: data functions accept an authorised context that only the
 * permission gate can construct. The owner is then read FROM that context and
 * never from an argument, which means "whose address book is this" is not a
 * parameter a caller can get wrong. Contacts are private, so that distinction
 * is the entire security model.
 *
 * ── AND WHY IT STILL USES THE REQUEST-SCOPED CLIENT ──────────────────────
 * Unlike most of `lib/records/*`, this does NOT reach for `supabaseAdmin()`.
 * The RLS on `phone_contacts` is owner-only, so the signed-in user's own
 * client is exactly the right level of authority, and using it means the
 * database enforces privacy a second time, underneath this code. A bug here
 * cannot leak another user's contacts; it can only fail to find them.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { canSeePhone } from './access';
import type { AuthContext } from '@/lib/records/permissions';
import { formatPhoneDisplay } from './normalize';

export type ContactNumber = {
  id: string;
  e164: string;
  label: string | null;
  isPrimary: boolean;
};

export type Contact = {
  id: string;
  displayName: string;
  company: string | null;
  email: string | null;
  notes: string | null;
  /** Set only by the automatic path — the CRM record this number matched. */
  recordId: string | null;
  source: 'manual' | 'auto';
  numbers: ContactNumber[];
  createdAt: string;
  updatedAt: string;
};

/** Everything that has happened with one contact's numbers. */
export type ContactActivity = {
  calls: {
    id: string;
    direction: 'in' | 'out';
    status: string;
    fromE164: string;
    toE164: string;
    startedAt: string;
    durationSeconds: number | null;
    /** Shaped for `RecordingRow`, so the existing player is reused rather
     *  than a second one being written for this panel. */
    recording: {
      id: string;
      kind: 'call' | 'voicemail';
      durationSeconds: number | null;
      storagePath: string | null;
    } | null;
  }[];
  messages: {
    id: string;
    direction: 'in' | 'out';
    body: string;
    sentAt: string | null;
    createdAt: string;
  }[];
};

type ContactRow = {
  id: string;
  display_name: string;
  company: string | null;
  email: string | null;
  notes: string | null;
  record_id: string | null;
  source: 'manual' | 'auto';
  created_at: string;
  updated_at: string;
  phone_contact_numbers: {
    id: string;
    e164: string;
    label: string | null;
    is_primary: boolean;
  }[];
};

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    displayName: row.display_name,
    company: row.company,
    email: row.email,
    notes: row.notes,
    recordId: row.record_id,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    numbers: (row.phone_contact_numbers ?? [])
      // Primary first, then stable by number so the order never jitters
      // between renders.
      .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.e164.localeCompare(b.e164))
      .map((n) => ({ id: n.id, e164: n.e164, label: n.label, isPrimary: n.is_primary })),
  };
}

/** This user's address book. Empty when they cannot use the phone at all. */
export async function contactsForUser(ctx: AuthContext): Promise<Contact[]> {
  if (!(await canSeePhone(ctx))) return [];

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('phone_contacts')
    .select(
      'id, display_name, company, email, notes, record_id, source, created_at, updated_at,' +
        ' phone_contact_numbers (id, e164, label, is_primary)',
    )
    // RLS already restricts this to the owner; the filter is here so a reader
    // of this code sees the intent without having to go and check the policy.
    .eq('owner_id', ctx.userId)
    .is('deleted_at', null)
    .order('display_name', { ascending: true });

  if (error) {
    console.error('[contacts] list failed', error);
    return [];
  }
  return ((data ?? []) as unknown as ContactRow[]).map(toContact);
}

/**
 * Calls, texts and recordings for one contact.
 *
 * The client's words: "Call recordings, call history, and texts should sync
 * with contact." The join is BY NUMBER, not by a foreign key, and that is the
 * point — a call that arrived before the contact existed still belongs to it,
 * and a number added to a contact today brings its whole history with it. A
 * stored link would only ever have covered events after the link was made.
 */
export async function contactActivity(
  ctx: AuthContext,
  contactId: string,
): Promise<ContactActivity> {
  const empty: ContactActivity = { calls: [], messages: [] };
  if (!(await canSeePhone(ctx))) return empty;

  const supabase = await createSupabaseServerClient();

  // Owner-scoped by RLS; the contact simply will not be found for anyone else.
  const { data: contact } = await supabase
    .from('phone_contacts')
    .select('id, phone_contact_numbers (e164)')
    .eq('id', contactId)
    .is('deleted_at', null)
    .maybeSingle();

  const numbers = ((contact?.phone_contact_numbers ?? []) as { e164: string }[]).map((n) => n.e164);
  if (numbers.length === 0) return empty;

  const [callsRes, messagesRes] = await Promise.all([
    supabase
      .from('phone_calls')
      .select(
        'id, direction, status, from_e164, to_e164, started_at, duration_seconds,' +
          ' phone_recordings (id, kind, duration_seconds, storage_path)',
      )
      // Either leg: an outbound call has them in `to`, an inbound in `from`.
      .or(`from_e164.in.(${numbers.join(',')}),to_e164.in.(${numbers.join(',')})`)
      .is('deleted_at', null)
      .order('started_at', { ascending: false })
      .limit(100),
    supabase
      .from('phone_messages')
      .select('id, direction, body, sent_at, created_at')
      .in('thread_key', numbers)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200),
  ]);

  if (callsRes.error) console.error('[contacts] calls failed', callsRes.error);
  if (messagesRes.error) console.error('[contacts] messages failed', messagesRes.error);

  return {
    calls: ((callsRes.data ?? []) as unknown as {
      id: string;
      direction: 'in' | 'out';
      status: string;
      from_e164: string;
      to_e164: string;
      started_at: string;
      duration_seconds: number | null;
      phone_recordings: {
        id: string;
        kind: 'call' | 'voicemail';
        duration_seconds: number | null;
        storage_path: string | null;
      }[];
    }[]).map((c) => {
      const rec = c.phone_recordings?.[0] ?? null;
      return {
        id: c.id,
        direction: c.direction,
        status: c.status,
        fromE164: c.from_e164,
        toE164: c.to_e164,
        startedAt: c.started_at,
        durationSeconds: c.duration_seconds,
        recording: rec
          ? {
              id: rec.id,
              kind: rec.kind,
              durationSeconds: rec.duration_seconds,
              storagePath: rec.storage_path,
            }
          : null,
      };
    }),
    messages: ((messagesRes.data ?? []) as unknown as {
      id: string;
      direction: 'in' | 'out';
      body: string;
      sent_at: string | null;
      created_at: string;
    }[]).map((m) => ({
      id: m.id,
      direction: m.direction,
      body: m.body,
      sentAt: m.sent_at,
      createdAt: m.created_at,
    })),
  };
}

export type ContactWrite = {
  displayName: string;
  company?: string | null;
  email?: string | null;
  notes?: string | null;
  /** Already normalised to E.164 by the action; never raw user input. */
  numbers: { e164: string; label?: string | null }[];
};

export type ContactResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

/**
 * Create a contact by hand.
 *
 * Creates NO CRM record, by the client's explicit instruction. The absence is
 * the feature, so it is stated here as well as in the migration.
 */
export async function createContact(ctx: AuthContext, input: ContactWrite): Promise<ContactResult> {
  if (!(await canSeePhone(ctx))) {
    return { ok: false, message: 'You do not have access to the phone.' };
  }

  const supabase = await createSupabaseServerClient();

  /*
   * Checked before writing anything so the refusal names the number. The
   * unique index is the real guarantee — this only exists to turn a
   * constraint violation into a sentence a person can act on.
   */
  const clash = await firstClashingNumber(ctx, input.numbers.map((n) => n.e164));
  if (clash) {
    return {
      ok: false,
      message: `${formatPhoneDisplay(clash.e164)} is already saved as "${clash.name}".`,
    };
  }

  const { data, error } = await supabase
    .from('phone_contacts')
    .insert({
      owner_id: ctx.userId,
      display_name: input.displayName,
      company: input.company ?? null,
      email: input.email ?? null,
      notes: input.notes ?? null,
      source: 'manual',
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[contacts] create failed', error);
    return { ok: false, message: 'That contact could not be saved.' };
  }

  const numbersResult = await replaceNumbers(ctx, data.id, input.numbers);
  if (!numbersResult.ok) {
    /*
     * The contact exists but has no way to be reached, which is not a contact.
     * Removed rather than left behind, so a failed save leaves nothing.
     */
    await supabase.from('phone_contacts').delete().eq('id', data.id);
    return numbersResult;
  }

  return { ok: true, id: data.id };
}

export async function updateContact(
  ctx: AuthContext,
  contactId: string,
  input: ContactWrite,
): Promise<ContactResult> {
  if (!(await canSeePhone(ctx))) {
    return { ok: false, message: 'You do not have access to the phone.' };
  }

  const supabase = await createSupabaseServerClient();

  const clash = await firstClashingNumber(ctx, input.numbers.map((n) => n.e164), contactId);
  if (clash) {
    return {
      ok: false,
      message: `${formatPhoneDisplay(clash.e164)} is already saved as "${clash.name}".`,
    };
  }

  const { data, error } = await supabase
    .from('phone_contacts')
    .update({
      display_name: input.displayName,
      company: input.company ?? null,
      email: input.email ?? null,
      notes: input.notes ?? null,
    })
    .eq('id', contactId)
    // RLS would refuse anyway; stated so the intent is readable here.
    .eq('owner_id', ctx.userId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[contacts] update failed', error);
    return { ok: false, message: 'That contact could not be saved.' };
  }
  if (!data) return { ok: false, message: 'That contact no longer exists.' };

  const numbersResult = await replaceNumbers(ctx, contactId, input.numbers);
  if (!numbersResult.ok) return numbersResult;

  return { ok: true, id: contactId };
}

/**
 * Remove a contact.
 *
 * A hard delete, deliberately, and this is the one place in TapDash where that
 * is right. "Delete" is a reserved word here — it means the Recycle Bin, and it
 * exists in exactly one place, the Records List. An address-book entry is not a
 * record: it is not in the Records List, it has no bin, and the client asked
 * plainly to "remove contacts". Soft-deleting it would invent a fourth state
 * nothing can see or restore, and would keep the number occupying its unique
 * index so the same contact could never be created again.
 *
 * Nothing is lost that matters: the calls, texts and recordings live in their
 * own tables and are untouched. Only the address-book entry goes.
 */
export async function removeContact(ctx: AuthContext, contactId: string): Promise<ContactResult> {
  if (!(await canSeePhone(ctx))) {
    return { ok: false, message: 'You do not have access to the phone.' };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('phone_contacts')
    .delete()
    .eq('id', contactId)
    .eq('owner_id', ctx.userId)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[contacts] remove failed', error);
    return { ok: false, message: 'That contact could not be removed.' };
  }
  if (!data) return { ok: false, message: 'That contact no longer exists.' };
  return { ok: true, id: contactId };
}

/** Which of these numbers already belongs to a DIFFERENT contact of this user. */
async function firstClashingNumber(
  ctx: AuthContext,
  e164s: string[],
  exceptContactId?: string,
): Promise<{ e164: string; name: string } | null> {
  if (e164s.length === 0) return null;

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('phone_contact_numbers')
    .select('e164, contact_id, phone_contacts (display_name)')
    .eq('owner_id', ctx.userId)
    .in('e164', e164s);

  if (exceptContactId) query = query.neq('contact_id', exceptContactId);

  const { data, error } = await query;
  if (error || !data?.length) return null;

  const row = data[0] as unknown as {
    e164: string;
    phone_contacts: { display_name: string } | null;
  };
  return { e164: row.e164, name: row.phone_contacts?.display_name ?? 'another contact' };
}

/**
 * Set a contact's numbers to exactly this list.
 *
 * Delete-then-insert rather than a diff. The set is tiny, the unique index
 * makes a partial failure loud rather than silent, and a diff would be more
 * code for the same result.
 */
async function replaceNumbers(
  ctx: AuthContext,
  contactId: string,
  numbers: { e164: string; label?: string | null }[],
): Promise<ContactResult> {
  const supabase = await createSupabaseServerClient();

  const { error: delErr } = await supabase
    .from('phone_contact_numbers')
    .delete()
    .eq('contact_id', contactId)
    .eq('owner_id', ctx.userId);
  if (delErr) {
    console.error('[contacts] clearing numbers failed', delErr);
    return { ok: false, message: 'That contact could not be saved.' };
  }

  if (numbers.length === 0) return { ok: true, id: contactId };

  const { error: insErr } = await supabase.from('phone_contact_numbers').insert(
    numbers.map((n, i) => ({
      contact_id: contactId,
      // Overwritten by the trigger from the parent contact. Sent because the
      // column is NOT NULL and the insert is checked before triggers run.
      owner_id: ctx.userId,
      e164: n.e164,
      label: n.label ?? null,
      is_primary: i === 0,
    })),
  );

  if (insErr) {
    console.error('[contacts] saving numbers failed', insErr);
    return {
      ok: false,
      message:
        insErr.code === '23505'
          ? 'One of those numbers is already saved under another contact.'
          : 'Those numbers could not be saved.',
    };
  }

  return { ok: true, id: contactId };
}
