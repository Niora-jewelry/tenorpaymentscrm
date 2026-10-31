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
 *
 * A field mention (`mention_field`) also writes an entry here, marked by
 * `field_key`; the body is the sender's note. Those entries are read-only.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { requireTabEdit, requireTabEditVia } from './tabAccess';
import { mentionCandidates, reconcileMentions, type Candidate } from './notifications';

export type Update = {
  id: string;
  recordId: string;
  parentId: string | null;
  /** Null when an automation did it: `automationName` says which. */
  authorId: string | null;
  automationName: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  mentionedUserIds: string[];
  /** Set when the entry is a field mention: the field it was sent from. */
  fieldKey: string | null;
};

/** A person who may be @mentioned here (see `mention_candidates`). */
export type TeamRosterEntry = Candidate;

function mapUpdate(r: Record<string, unknown>, mentionedUserIds: string[]): Update {
  return {
    id: r.id as string,
    recordId: r.record_id as string,
    parentId: (r.parent_id as string | null) ?? null,
    authorId: (r.author_id as string | null) ?? null,
    automationName: (r.automation_name as string | null) ?? null,
    body: r.body as string,
    createdAt: r.created_at as string,
    editedAt: (r.edited_at as string | null) ?? null,
    mentionedUserIds,
    fieldKey: (r.field_key as string | null) ?? null,
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
  // Everyone who can see the record, its module and the Updates tab — admins
  // and visibility-grant viewers included, suspended people and the viewer
  // excluded (`mention_candidates`, migration 9787).
  return mentionCandidates(ctx, recordId, 'updates');
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

/**
 * The people a post notifies: the ids the picker recorded, kept only while
 * their `@Name` is still in the text, plus anyone whose name was typed or
 * pasted in full without the picker. Both bounded by the candidate set.
 */
function mentionsIn(body: string, claimed: string[], roster: TeamRosterEntry[]): string[] {
  return [...new Set([...reconcileMentions(body, claimed, roster), ...parseMentions(body, roster)])];
}

export async function addUpdate(
  ctx: AuthContext,
  recordId: string,
  body: string,
  parentId?: string,
  mentionedUserIds: string[] = [],
): Promise<{ id: string; mentioned: string[] }> {
  await requireTabEdit(ctx, recordId, 'updates');
  const roster = await teamRosterFor(ctx, recordId);
  const mentioned = mentionsIn(body, mentionedUserIds, roster);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('add_update_with_mentions', {
    p_record_id: recordId,
    p_body: body,
    p_parent_id: parentId ?? null,
    p_mentioned_user_ids: mentioned,
  });
  if (error) throw error;
  return { id: data as string, mentioned };
}

export async function editUpdate(
  ctx: AuthContext,
  updateId: string,
  body: string,
  mentionedUserIds: string[] = [],
): Promise<void> {
  await requireTabEditVia(ctx, 'updates', updateId, 'updates');
  const supabase = await createSupabaseServerClient();
  const { data: row, error: readErr } = await supabase.from('updates').select('record_id').eq('id', updateId).maybeSingle();
  if (readErr) throw readErr;
  if (!row) throw new Error('not found');
  const roster = await teamRosterFor(ctx, row.record_id as string);
  const { error } = await supabase.rpc('edit_update_with_mentions', {
    p_update_id: updateId,
    p_body: body,
    p_mentioned_user_ids: mentionsIn(body, mentionedUserIds, roster),
  });
  if (error) throw error;
}

export async function deleteUpdate(ctx: AuthContext, updateId: string): Promise<void> {
  await requireTabEditVia(ctx, 'updates', updateId, 'updates');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_update', { p_update_id: updateId });
  if (error) throw error;
}
