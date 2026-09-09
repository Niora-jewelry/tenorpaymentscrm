/**
 * Notes — one table, two scopes (field or tab). "Each tab should have a
 * notes field" is a thread with an author, exactly like per-field notes.
 *
 * Plain RLS-gated reads/writes, no combined write function: notes are not in
 * §7.1's activity-log event list, so there is no history entry to keep
 * transactional with the write.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { loadConfig } from './config';
import { moduleWriteCap, tabAccessById } from './tabAccess';

export type Note = {
  id: string;
  recordId: string;
  scopeKind: 'field' | 'tab';
  scopeId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
};

/**
 * The tab a note hangs off, from its scope.
 *
 * A note is written against a tab (`scope_id` is the tab id, or
 * `tabId/subtabId` when the tab has subtabs — `DrawerTabs.tsx` builds it) or
 * against a field (`scope_id` is the field's KEY, because the drawer passes
 * the ADAPTED field whose `id` is `f.key` — `adapter.ts`). Either way the note
 * belongs to a tab, and that tab's grant is what governs writing it: a
 * read-only tab whose notes thread still accepts posts is not read-only.
 */
async function tabIdForScope(scopeKind: 'field' | 'tab', scopeId: string): Promise<string | null> {
  if (scopeKind === 'tab') return scopeId.split('/')[0] ?? null;
  const config = await loadConfig();
  return config.fields.find((f) => f.key === scopeId || f.id === scopeId)?.tabId ?? null;
}

/** Refuses unless this record's copy of that tab is Edit for this viewer. A
 * scope that resolves to no tab still has to clear the module ceiling. */
async function requireNoteEdit(
  ctx: AuthContext,
  recordId: string,
  scopeKind: 'field' | 'tab',
  scopeId: string,
): Promise<void> {
  const tabId = await tabIdForScope(scopeKind, scopeId);
  const grant = tabId
    ? await tabAccessById(ctx, recordId, tabId)
    : (await moduleWriteCap(ctx, [recordId])).get(recordId) ?? 'hidden';
  if (grant !== 'edit') throw new Error('This tab is read-only for you.');
}

/** The same guard for a caller holding only the note's id. Reads through the
 * viewer's own RLS-bound client, so a note they cannot see is indistinguishable
 * from one that does not exist. */
async function requireNoteEditById(ctx: AuthContext, noteId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notes')
    .select('record_id, scope_kind, scope_id')
    .eq('id', noteId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Not found');
  await requireNoteEdit(
    ctx,
    data.record_id as string,
    data.scope_kind as 'field' | 'tab',
    data.scope_id as string,
  );
}

function mapNote(r: Record<string, unknown>): Note {
  return {
    id: r.id as string,
    recordId: r.record_id as string,
    scopeKind: r.scope_kind as 'field' | 'tab',
    scopeId: r.scope_id as string,
    authorId: r.author_id as string,
    body: r.body as string,
    createdAt: r.created_at as string,
    editedAt: (r.edited_at as string | null) ?? null,
  };
}

export async function notesFor(
  _ctx: AuthContext,
  recordId: string,
  scopeKind: 'field' | 'tab',
  scopeId: string,
): Promise<Note[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('record_id', recordId)
    .eq('scope_kind', scopeKind)
    .eq('scope_id', scopeId)
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map(mapNote);
}

/** Every note on a record in one query, grouped by `${scopeKind}:${scopeId}`
 * — used to render both the tab-level note thread and every notes-enabled
 * field's note toggle from one fetch instead of one query per scope. */
export async function allNotesFor(_ctx: AuthContext, recordId: string): Promise<Map<string, Note[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('record_id', recordId)
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;

  const byScope = new Map<string, Note[]>();
  for (const row of (data ?? []).map(mapNote)) {
    const key = `${row.scopeKind}:${row.scopeId}`;
    const list = byScope.get(key) ?? [];
    list.push(row);
    byScope.set(key, list);
  }
  return byScope;
}

export async function addNote(
  ctx: AuthContext,
  recordId: string,
  scopeKind: 'field' | 'tab',
  scopeId: string,
  body: string,
): Promise<Note> {
  await requireNoteEdit(ctx, recordId, scopeKind, scopeId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notes')
    .insert({ record_id: recordId, scope_kind: scopeKind, scope_id: scopeId, author_id: ctx.userId, body })
    .select('*')
    .single();
  if (error) throw error;
  return mapNote(data);
}

/** Author-or-admin only — enforced inside `edit_note()`, not just by hiding
 * the button (migration 29: this used to be a raw `.update()` with nothing
 * stopping any teammate from editing anyone's note). */
export async function editNote(ctx: AuthContext, noteId: string, body: string): Promise<void> {
  await requireNoteEditById(ctx, noteId);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('edit_note', { p_note_id: noteId, p_body: body });
  if (error) throw error;
}

export async function deleteNote(ctx: AuthContext, noteId: string): Promise<void> {
  await requireNoteEditById(ctx, noteId);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_note', { p_note_id: noteId });
  if (error) throw error;
}
