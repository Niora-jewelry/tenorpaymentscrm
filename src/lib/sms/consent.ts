/**
 * Reading and writing SMS consent.
 *
 * The writes run as the service role, because the public consent form has no
 * session at all and because a client that could insert here could manufacture
 * consent — the one thing the record exists to make impossible. The boundary
 * that validates and rate-limits is the Server Action above this.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { CONSENT_TEXT_BY_SOURCE, type ConsentSource } from './consentText';

export type ConsentStatus = {
  consented: boolean;
  source: ConsentSource | null;
  consentedAt: string | null;
  fullName: string | null;
};

const NONE: ConsentStatus = {
  consented: false,
  source: null,
  consentedAt: null,
  fullName: null,
};

/**
 * May we text this number?
 *
 * "No row" is the answer for both "never asked" and "opted out", and they are
 * not usefully different to a caller deciding whether to send — both mean no.
 * The distinction is kept in the table for the audit trail, where it does
 * matter.
 */
export async function consentStatus(e164: string): Promise<ConsentStatus> {
  if (!e164) return NONE;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('sms_consent_status', { p_e164: e164 });

  if (error) {
    console.error('[sms] consent lookup failed', error);
    /*
     * Fail CLOSED. A lookup that errors must not report "consented" — that
     * would send a text on the strength of a database timeout. Reporting "no
     * consent" at worst blocks a message that could have been sent, which is
     * the recoverable direction.
     */
    return NONE;
  }

  const row = (data as { source: ConsentSource; consented_at: string; full_name: string | null }[])?.[0];
  return row
    ? { consented: true, source: row.source, consentedAt: row.consented_at, fullName: row.full_name }
    : NONE;
}

/** The same question for many numbers, in one round trip. */
export async function consentStatuses(e164s: string[]): Promise<Map<string, ConsentStatus>> {
  const out = new Map<string, ConsentStatus>();
  const unique = [...new Set(e164s.filter(Boolean))];
  if (unique.length === 0) return out;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('sms_consents')
    .select('e164, source, created_at, full_name')
    .in('e164', unique)
    .is('revoked_at', null);

  if (error) {
    console.error('[sms] bulk consent lookup failed', error);
    return out; // every number reads as "no consent" — fails closed, as above
  }

  for (const row of (data ?? []) as {
    e164: string;
    source: ConsentSource;
    created_at: string;
    full_name: string | null;
  }[]) {
    out.set(row.e164, {
      consented: true,
      source: row.source,
      consentedAt: row.created_at,
      fullName: row.full_name,
    });
  }
  return out;
}

export type RecordConsentInput = {
  e164: string;
  source: ConsentSource;
  fullName?: string | null;
  businessName?: string | null;
  email?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  recordedById?: string | null;
  note?: string | null;
};

/**
 * Write a consent.
 *
 * The wording is NOT a parameter. It is looked up from the source, so a caller
 * cannot store consent against words the person was never shown — which would
 * be worse than storing nothing, because it would look like evidence.
 */
export async function recordConsent(input: RecordConsentInput): Promise<string | null> {
  const consentText =
    input.source === 'imported'
      ? 'Imported from a prior system; original evidence held outside this CRM.'
      : CONSENT_TEXT_BY_SOURCE[input.source];

  const { data, error } = await supabaseAdmin().rpc('record_sms_consent', {
    p_e164: input.e164,
    p_consent_text: consentText,
    p_source: input.source,
    p_full_name: input.fullName ?? null,
    p_business_name: input.businessName ?? null,
    p_email: input.email ?? null,
    p_ip: input.ip ?? null,
    p_user_agent: input.userAgent ?? null,
    p_recorded_by_id: input.recordedById ?? null,
    p_note: input.note ?? null,
  });

  if (error) {
    console.error('[sms] recording consent failed', { e164: input.e164, error: error.message });
    return null;
  }
  return (data as string | null) ?? null;
}

/** End consent. Idempotent — a second STOP is normal, not an error. */
export async function revokeConsent(e164: string, reason: string): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('revoke_sms_consent', {
    p_e164: e164,
    p_reason: reason,
  });

  if (error) {
    console.error('[sms] revoking consent failed', { e164, error: error.message });
    return 0;
  }
  return (data as number | null) ?? 0;
}

/**
 * Has this number explicitly opted out?
 *
 * ── WHY THIS IS NOT `!consentStatus().consented` ─────────────────────────
 * `consentStatus` deliberately collapses "never asked" and "opted out" into
 * one answer, and says why: they are not usefully different to someone
 * deciding whether a badge should be green.
 *
 * For deciding whether to SEND they are completely different. A person who
 * texted us first and is waiting for a reply has no consent row at all —
 * blocking that is breaking the product. A person who replied STOP has a
 * revoked row, and texting them is a TCPA violation and a fast route to a
 * suspended campaign.
 *
 * So this asks the narrow question: is the most recent record for this number
 * a revocation? Nothing else blocks a send.
 *
 * ── IT FAILS CLOSED, AND THAT IS SAFE HERE ───────────────────────────────
 * A lookup that errors returns `true` — treat as opted out. The reverse would
 * mean a database timeout silently authorising a message to someone who asked
 * not to receive one.
 *
 * The cost of the strict direction is bounded: Twilio enforces STOP at the
 * carrier level too and would refuse the same message with error 21610, so
 * this is the layer that produces a sentence a human can read rather than the
 * only thing standing between us and a violation.
 */
export async function isOptedOut(e164: string): Promise<boolean> {
  if (!e164) return false;

  /*
   * ── NOT "the newest row is revoked" ───────────────────────────────────
   * That was the first implementation and it is subtly wrong: `created_at`
   * defaults to `now()`, which is the TRANSACTION's start time, so a STOP and
   * a START written close together — a retry, or someone texting STOP then
   * START within the same second — carry the same timestamp and
   * `order by created_at desc limit 1` picks between them arbitrarily. An
   * opt-out check that is usually right is not a working opt-out check.
   *
   * The rule below needs no ordering at all:
   *
   *   opted out  =  a revocation exists  AND  no live consent exists
   *
   * Which is also the plain meaning of the words: they asked to stop, and have
   * not since come back. A number that opted out and then texted START has a
   * live row again, so it is reachable; the revocation stays on file because
   * consent history is append-only.
   */
  const supabase = supabaseAdmin();

  const [live, revoked] = await Promise.all([
    supabase
      .from('sms_consents')
      .select('id', { count: 'exact', head: true })
      .eq('e164', e164)
      .is('revoked_at', null),
    supabase
      .from('sms_consents')
      .select('id', { count: 'exact', head: true })
      .eq('e164', e164)
      .not('revoked_at', 'is', null),
  ]);

  if (live.error || revoked.error) {
    console.error('[sms] opt-out lookup failed — treating as opted out', {
      e164,
      error: (live.error ?? revoked.error)?.message,
    });
    return true;
  }

  /* No record at all is NOT an opt-out — see the note above. */
  return (revoked.count ?? 0) > 0 && (live.count ?? 0) === 0;
}
