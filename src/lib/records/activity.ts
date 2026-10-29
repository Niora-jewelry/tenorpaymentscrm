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
import { loadConfig } from './config';
import { hiddenFieldKeysFor } from './tabAccess';

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
    // Resolved against THIS RECORD, not globally. These rows carry `from_value`
    // and `to_value` verbatim, so a field hidden only in the module this record
    // lives in was handing its old and new values back through the history.
    const config = await loadConfig();
    const hiddenKeys = await hiddenFieldKeysFor(ctx, recordId, config.fields);
    rows = rows.filter((r) => !r.fieldKey || !hiddenKeys.has(r.fieldKey));
  }

  return { rows, pageCount: Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE)) };
}

// ── one field's history ─────────────────────────────────────────────────────

export type FieldHistoryEntry = {
  id: string;
  at: string;
  actorId: string | null;
  summary: string;
  from: string;
  to: string;
  /** Where the value came from when it was not typed in the CRM, e.g.
   *  "Application APP-000123, online" (`record_activity.source`). */
  source: string | null;
};

/**
 * The history of ONE field on one record, newest first, for the field card's
 * history control. Hidden fields have none (CLAUDE.md §3); sensitive values
 * (SSNs, account numbers) never leave the server — only that they changed.
 */
export async function fieldHistory(ctx: AuthContext, recordId: string, fieldKey: string): Promise<FieldHistoryEntry[] | null> {
  const config = await loadConfig();
  const field = config.fields.find((f) => f.key === fieldKey);
  if (!field) return null;
  if ((await hiddenFieldKeysFor(ctx, recordId, [field])).has(fieldKey)) return null;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('record_activity')
    .select('id, at, actor_id, summary, from_value, to_value, source')
    .eq('record_id', recordId)
    .eq('field_key', fieldKey)
    .order('at', { ascending: false })
    .limit(50);
  if (error) throw error;

  const labels = new Map(config.choices.filter((c) => c.fieldId === field.id && c.moduleId === null).map((c) => [c.key, c.value]));
  const secret = field.sensitive || (field.repeatSchema ?? []).some((m) => m.sensitive);
  const show = (raw: string | null): string => {
    if (raw == null || raw === '') return '';
    if (secret) return '••••';
    let v: unknown = raw;
    if (/^[[{"]/.test(raw)) {
      try {
        v = JSON.parse(raw);
      } catch {
        v = raw;
      }
    }
    if (Array.isArray(v)) {
      if (field.type === 'repeat_group') return `${v.length} ${v.length === 1 ? 'entry' : 'entries'}`;
      return v.map((x) => (typeof x === 'string' ? labels.get(x) ?? x : String(x))).join(', ');
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if ('street' in o || 'city' in o) {
        const csz = [o.city, [o.state, o.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        return [o.street, o.street2, csz].filter(Boolean).join(', ');
      }
      return Object.entries(o)
        .map(([k, x]) => `${labels.get(k) ?? k} ${String(x)}%`)
        .join(' · ');
    }
    const s = String(v);
    return labels.get(s) ?? s;
  };
  return (data ?? []).map((r) => ({
    id: String(r.id),
    at: r.at as string,
    actorId: (r.actor_id as string | null) ?? null,
    summary: r.summary as string,
    from: show(r.from_value as string | null),
    to: show(r.to_value as string | null),
    source: (r.source as string | null) ?? null,
  }));
}
