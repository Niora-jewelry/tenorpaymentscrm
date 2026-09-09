/**
 * Updates — threaded exactly one level deep. Editing/deleting go through
 * migration 13's `edit_update`/`delete_update` (author-or-admin, logged to
 * record_activity). Posting goes through `add_update_with_mentions()`
 * (migration 34) — the RPC that actually does the @mention parsing's other
 * half: resolving `@Name` substrings client-side into real user ids happens
 * in the UI (against the record's own team roster, from
 * `teamMemberIdsFor`/`profile_names`), and this file's job is only to pass
 * those ids through to the one function that's allowed to write
 * `update_mentions` and call `notify()` (which has no client grant at all).
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { requireTabEdit, requireTabEditVia } from './tabAccess';
import { profileNamesFor } from './users';

export type Update = {
  id: string;
  recordId: string;
  parentId: string | null;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  mentionedUserIds: string[];
};

export type TeamRosterEntry = { id: string; name: string };

function mapUpdate(r: Record<string, unknown>, mentionedUserIds: string[]): Update {
  return {
    id: r.id as string,
    recordId: r.record_id as string,
    parentId: (r.parent_id as string | null) ?? null,
    authorId: r.author_id as string,
    body: r.body as string,
    createdAt: r.created_at as string,
    editedAt: (r.edited_at as string | null) ?? null,
    mentionedUserIds,
  };
}

export async function updatesFor(_ctx: AuthContext, recordId: string): Promise<Update[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('updates')
    .select('*, update_mentions (user_id)')
    .eq('record_id', recordId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) =>
    mapUpdate(r, ((r.update_mentions ?? []) as { user_id: string }[]).map((m) => m.user_id)),
  );
}

/** Valid @mention targets for a record — everyone on its team (the same set
 * RLS uses for row visibility), resolved to display names via
 * `profile_names()` since `record_team_members`' own RLS only lets a
 * regular user see their OWN membership row, never the full roster. */
export async function teamRosterFor(ctx: AuthContext, recordId: string): Promise<TeamRosterEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_team_member_ids', { p_record_id: recordId });
  if (error) throw error;
  const ids = (data ?? []) as string[];
  if (!ids.length) return [];
  const names = await profileNamesFor(ctx, ids);
  return ids.map((id) => ({ id, name: names.get(id) ?? 'Unknown user' }));
}

/** Parses `@Full Name` substrings against the record's real team roster —
 * matched names only, never an arbitrary id, and longest-name-first so
 * "Alex Chen" doesn't get shadowed by a shorter "Alex" also on the team. */
function parseMentions(body: string, roster: TeamRosterEntry[]): string[] {
  const sorted = [...roster].sort((a, b) => b.name.length - a.name.length);
  const found = new Set<string>();
  for (const member of sorted) {
    if (body.includes(`@${member.name}`)) found.add(member.id);
  }
  return Array.from(found);
}

export async function addUpdate(
  ctx: AuthContext,
  recordId: string,
  body: string,
  parentId?: string,
): Promise<string> {
  await requireTabEdit(ctx, recordId, 'updates');
  const roster = await teamRosterFor(ctx, recordId);
  const mentionedUserIds = parseMentions(body, roster);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('add_update_with_mentions', {
    p_record_id: recordId,
    p_body: body,
    p_parent_id: parentId ?? null,
    p_mentioned_user_ids: mentionedUserIds,
  });
  if (error) throw error;
  return data as string;
}

export async function editUpdate(ctx: AuthContext, updateId: string, body: string): Promise<void> {
  await requireTabEditVia(ctx, 'updates', updateId, 'updates');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('edit_update', { p_update_id: updateId, p_body: body });
  if (error) throw error;
}

export async function deleteUpdate(ctx: AuthContext, updateId: string): Promise<void> {
  await requireTabEditVia(ctx, 'updates', updateId, 'updates');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_update', { p_update_id: updateId });
  if (error) throw error;
}
