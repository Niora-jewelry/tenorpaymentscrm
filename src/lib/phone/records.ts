/**
 * E.164 → the record that number belongs to.
 *
 * A thin wrapper over `resolve_record_by_phone()` (migration 69). The matching
 * rule lives in SQL rather than here for two reasons: it has to run inside the
 * webhooks where there is no `auth.uid()`, and it walks repeat-group JSON in a
 * way that would be several round trips from TypeScript.
 *
 * This replaces Donny's `resolve-lead-tag.ts`, which resolved against
 * `lead_gen_threads` — a table that does not exist in TapDash. Same contract:
 * ONE resolution path, and every caller comes through it.
 *
 * A null result is normal, not an error. It means somebody rang from a number
 * the CRM has never seen, and the call is still logged — just unattached.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PhoneMatch = { e164: string; recordId: string; dealName: string };

/** One number. Null when nothing matches. */
export async function resolveRecordByPhone(
  client: SupabaseClient,
  e164: string,
): Promise<string | null> {
  if (!e164) return null;

  const { data, error } = await client.rpc('resolve_record_by_phone', { p_e164: e164 });
  if (error) {
    // Never throw into a webhook: an unmatched call is far better than a 500
    // that makes Twilio retry the whole document.
    console.error('[phone] resolveRecordByPhone failed', error);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Many numbers, one round trip.
 *
 * The call-history pane needs a merchant name per row. Calling the single
 * resolver per row is the N+1 that turns a 50-row page into 50 queries, so the
 * batched form exists from the start rather than after somebody notices.
 */
export async function resolveRecordsByPhones(
  client: SupabaseClient,
  e164s: string[],
): Promise<Map<string, PhoneMatch>> {
  const out = new Map<string, PhoneMatch>();
  const unique = [...new Set(e164s.filter(Boolean))];
  if (!unique.length) return out;

  const { data, error } = await client.rpc('resolve_records_by_phones', { p_e164s: unique });
  if (error) {
    console.error('[phone] resolveRecordsByPhones failed', error);
    return out;
  }

  for (const row of (data ?? []) as { e164: string; record_id: string; deal_name: string }[]) {
    out.set(row.e164, { e164: row.e164, recordId: row.record_id, dealName: row.deal_name });
  }
  return out;
}
