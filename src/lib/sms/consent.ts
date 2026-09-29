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
