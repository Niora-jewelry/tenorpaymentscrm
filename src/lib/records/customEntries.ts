/**
 * The "Other" tab — per-record entries with no field definition. Deliberately
 * not schema fields (SCHEMA.md): under the global drawer a field exists on
 * every record in the company, and these belong to exactly one.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { requireTabEdit, requireTabEditVia } from './tabAccess';

export type CustomEntry = {
  id: string;
  recordId: string;
  label: string;
  value: string | null;
  position: number;
  createdBy: string;
  createdAt: string;
};

function mapEntry(r: Record<string, unknown>): CustomEntry {
  return {
    id: r.id as string,
    recordId: r.record_id as string,
    label: r.label as string,
    value: (r.value as string | null) ?? null,
    position: r.position as number,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
  };
}

export async function entriesFor(_ctx: AuthContext, recordId: string): Promise<CustomEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('record_custom_entries')
    .select('*')
    .eq('record_id', recordId)
    .is('deleted_at', null)
    .order('position');
  if (error) throw error;
  return (data ?? []).map(mapEntry);
}

/*
 * All three writers go through a function rather than a table write.
 *
 * The spec says these entries "soft-delete and activity-log like everything
 * else" (CLIENT-SPEC-BY-MODULE §2). They soft-deleted; they logged nothing —
 * so a label/value pair on the one tab meant for a record's ad-hoc detail
 * could be added, rewritten or removed leaving no trace at all.
 *
 * The log line could have been added here in TypeScript, and that would have
 * been wrong: CLAUDE.md rule 5 requires the change and its history to be one
 * transaction, and a second call from the app layer can fail on its own. The
 * write and the history row now happen together inside migration 49's
 * functions, which is what every other writer in this schema already does.
 *
 * The tab-grant check stays HERE, unchanged. The functions are
 * `security invoker`, so RLS still applies as before and nothing about who may
 * write these rows has widened.
 */
export async function addEntry(
  ctx: AuthContext,
  recordId: string,
  label: string,
  value: string,
): Promise<CustomEntry> {
  await requireTabEdit(ctx, recordId, 'other');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .rpc('add_custom_entry', { p_record_id: recordId, p_label: label, p_value: value })
    .single();
  if (error) throw error;
  return mapEntry(data as Record<string, unknown>);
}

export async function updateEntry(ctx: AuthContext, entryId: string, label: string, value: string): Promise<void> {
  await requireTabEditVia(ctx, 'record_custom_entries', entryId, 'other');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .rpc('update_custom_entry', { p_entry_id: entryId, p_label: label, p_value: value });
  if (error) throw error;
}

export async function deleteEntry(ctx: AuthContext, entryId: string): Promise<void> {
  await requireTabEditVia(ctx, 'record_custom_entries', entryId, 'other');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_custom_entry', { p_entry_id: entryId });
  if (error) throw error;
}
