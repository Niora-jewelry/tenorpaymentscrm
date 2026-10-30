/**
 * A field's own address — Inventory's "Off-site (warehouse): provide
 * address" (the client, 30 Oct 2026: "an address field which can be filled,
 * similar to the notes field on the other fields"). One per record and field,
 * switched on per field like notes (`fields.address_enabled`).
 *
 * Reads go through the viewer's own RLS-bound client, so an address on a
 * field they cannot see is absent, never blank. The write is one function,
 * `set_field_address`, which checks Edit on the field and writes the history
 * row in the same transaction (CLAUDE.md §5).
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

export type FieldAddress = { street: string; street2: string; city: string; state: string; zip: string; country: string };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
export const asFieldAddress = (v: unknown): FieldAddress => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { street: str(o.street), street2: str(o.street2), city: str(o.city), state: str(o.state), zip: str(o.zip), country: str(o.country) };
};
export const addressIsEmpty = (a: FieldAddress) => !a.street && !a.street2 && !a.city && !a.state && !a.zip;

/** Every field address on the record the viewer may see, by field key. */
export async function fieldAddressesFor(_ctx: AuthContext, recordId: string): Promise<Record<string, FieldAddress>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('field_addresses').select('field_key, address').eq('record_id', recordId);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.field_key as string, asFieldAddress(r.address)]));
}

/** Sets (or, when every part is blank, clears) a field's address. */
export async function setFieldAddress(_ctx: AuthContext, recordId: string, fieldKey: string, address: FieldAddress): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_field_address', {
    p_record: recordId,
    p_field_key: fieldKey,
    p_address: addressIsEmpty(address) ? null : address,
  });
  if (error) {
    if (error.code === '42501') throw new Error('This field is read-only for you.');
    throw new Error(error.message);
  }
}
