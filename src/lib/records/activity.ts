/**
 * Activity log reads — append-only, paginated, and field-suppressed.
 *
 * MODULE-2-PLAN §5.1: "Hidden means absent... activity-log entries
 * referencing it are suppressed for that user." `field_key` is nullable on
 * `record_activity` specifically so this filter is possible — an entry with
 * no field_key (membership/pipeline/case/file/record-level events) is never
 * suppressed by field visibility.
 *
 * Personalization changes are never written here at all (the client's own
 * words, "would be noise" — see docs/SCHEMA.md's Per-user personalization
 * section) — there is nothing to filter out on that account, it simply never
 * exists as a row.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { fieldGrants } from './permissions';
import { loadConfig } from './config';

export type ActivityEntry = {
  id: string;
  recordId: string;
  actorId: string | null;
  kind: string;
  fieldKey: string | null;
  summary: string;
  fromValue: string | null;
  toValue: string | null;
  at: string;
};

const PAGE_SIZE = 50;

export async function listActivity(
  ctx: AuthContext,
  recordId: string,
  page = 0,
): Promise<{ rows: ActivityEntry[]; pageCount: number }> {
  const supabase = await createSupabaseServerClient();
  const from = page * PAGE_SIZE;

  const { data, error, count } = await supabase
    .from('record_activity')
    .select('*', { count: 'exact' })
    .eq('record_id', recordId)
    .order('at', { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw error;

  let rows: ActivityEntry[] = (data ?? []).map((r) => ({
    id: String(r.id),
    recordId: r.record_id,
    actorId: r.actor_id,
    kind: r.kind,
    fieldKey: r.field_key,
    summary: r.summary,
    fromValue: r.from_value,
    toValue: r.to_value,
    at: r.at,
  }));

  if (!ctx.isAdmin) {
    const config = await loadConfig();
    const grants = await fieldGrants(ctx, config.fields);
    const hiddenKeys = new Set(
      config.fields.filter((f) => grants.get(f.id) === 'hidden').map((f) => f.key),
    );
    rows = rows.filter((r) => !r.fieldKey || !hiddenKeys.has(r.fieldKey));
  }

  return { rows, pageCount: Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE)) };
}
