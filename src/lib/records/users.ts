/**
 * Author display names for notes/updates/case-replies/custom-entries. Goes
 * through `profile_names()` (migration 28) rather than selecting `profiles`
 * directly — `profiles`' own RLS only allows a user to read their own row or,
 * if admin, every row, so a teammate's `full_name` is otherwise unreachable
 * even though showing "who wrote this" is a baseline expectation once both
 * of them already share visibility into the same record.
 */
import 'server-only';
import { cache } from 'react';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

/**
 * Names already resolved during THIS request.
 *
 * The drawer asks twice over overlapping id sets — once inside `teamRosterFor`
 * for the @mention roster, then again for every author across notes, updates,
 * cases, replies and custom entries, which on most records is largely the same
 * handful of people. Both were full round trips. Caching per request makes the
 * second one ask only for whoever is genuinely new, and usually for nobody at
 * all.
 *
 * Per REQUEST, not across requests: `profile_names()` is reached through the
 * request-scoped client, so what it returns belongs to this caller's session
 * and must not outlive it. A rename also has to show up on the next page load,
 * not an hour later.
 */
const nameCache = cache((): Map<string, string> => new Map());

export async function profileNamesFor(_ctx: AuthContext, ids: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids));
  if (!unique.length) return new Map();

  const known = nameCache();
  const missing = unique.filter((id) => !known.has(id));

  if (missing.length) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('profile_names', { p_ids: missing });
    if (error) throw error;
    for (const r of (data ?? []) as { id: string; full_name: string | null }[]) {
      known.set(r.id, r.full_name ?? 'Unknown user');
    }
    // An id the function returned nothing for is cached as unknown too —
    // otherwise every later caller asking for that same id re-issues a query
    // that will never find it.
    for (const id of missing) if (!known.has(id)) known.set(id, 'Unknown user');
  }

  // Only what was asked for. Callers index this map by id and must not be
  // handed names they did not request.
  return new Map(unique.map((id) => [id, known.get(id) ?? 'Unknown user']));
}
