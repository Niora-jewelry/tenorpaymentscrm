/**
 * Cases. Issue required and immutable to non-admins; a case cannot close
 * without a Solution (enforced twice: the `closed_requires_solution` check
 * constraint, and `toggle_case_state`'s friendly pre-check ahead of it); no
 * fields, ever. Every mutation here is one of migration 13's combined
 * write+log functions.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { requireTabEdit, requireTabEditVia } from './tabAccess';

export type CaseThread = {
  id: string;
  recordId: string;
  number: number;
  title: string;
  issue: string;
  issueAuthor: string;
  issueAt: string;
  solution: string | null;
  solutionAuthor: string | null;
  solutionAt: string | null;
  state: 'open' | 'closed';
  editedBy: string | null;
  createdAt: string;
};

export type CaseReply = { id: string; caseId: string; authorId: string; body: string; createdAt: string };

function mapCase(r: Record<string, unknown>): CaseThread {
  return {
    id: r.id as string,
    recordId: r.record_id as string,
    number: r.number as number,
    title: r.title as string,
    issue: r.issue as string,
    issueAuthor: r.issue_author as string,
    issueAt: r.issue_at as string,
    solution: (r.solution as string | null) ?? null,
    solutionAuthor: (r.solution_author as string | null) ?? null,
    solutionAt: (r.solution_at as string | null) ?? null,
    state: r.state as 'open' | 'closed',
    editedBy: (r.edited_by as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export async function casesFor(_ctx: AuthContext, recordId: string): Promise<CaseThread[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .eq('record_id', recordId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapCase);
}

export async function repliesFor(_ctx: AuthContext, caseId: string): Promise<CaseReply[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('case_replies')
    .select('*')
    .eq('case_id', caseId)
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id, caseId: r.case_id, authorId: r.author_id, body: r.body, createdAt: r.created_at,
  }));
}

export async function managersFor(_ctx: AuthContext, caseId: string): Promise<string[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('case_managers').select('user_id').eq('case_id', caseId);
  if (error) throw error;
  return (data ?? []).map((r) => r.user_id as string);
}

/**
 * Replies for a SET of cases, grouped by case, in one query.
 *
 * The drawer builds `repliesByCase` for every case on the record; mapping
 * `repliesFor` over them was one round trip per case, and the drawer awaited
 * that whole wave before starting the managers wave below. Ordering matches
 * `repliesFor` (oldest first — a thread reads top-down). Every requested id is
 * present in the result, empty array included, so callers can index directly.
 */
export async function repliesForCases(
  _ctx: AuthContext,
  caseIds: string[],
): Promise<Record<string, CaseReply[]>> {
  const out: Record<string, CaseReply[]> = {};
  for (const id of caseIds) out[id] = [];
  if (!caseIds.length) return out;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('case_replies')
    .select('*')
    .in('case_id', caseIds)
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;

  for (const r of data ?? []) {
    (out[r.case_id as string] ??= []).push({
      id: r.id, caseId: r.case_id, authorId: r.author_id, body: r.body, createdAt: r.created_at,
    });
  }
  return out;
}

/** Managers for a SET of cases, grouped by case, in one query. Same reasoning
 * as `repliesForCases` above. */
export async function managersForCases(
  _ctx: AuthContext,
  caseIds: string[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const id of caseIds) out[id] = [];
  if (!caseIds.length) return out;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('case_managers')
    .select('case_id, user_id')
    .in('case_id', caseIds);
  if (error) throw error;

  for (const r of data ?? []) {
    (out[r.case_id as string] ??= []).push(r.user_id as string);
  }
  return out;
}

/** Issue author is auto-assigned as a manager server-side — always >= 1. */
export async function createCase(
  ctx: AuthContext,
  recordId: string,
  title: string,
  issue: string,
  managerIds: string[],
): Promise<string> {
  await requireTabEdit(ctx, recordId, 'cases');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('create_case', {
    p_record_id: recordId,
    p_title: title,
    p_issue: issue,
    p_manager_ids: managerIds,
  });
  if (error) throw error;
  return data as string;
}

export async function addReply(ctx: AuthContext, caseId: string, body: string): Promise<string> {
  await requireTabEditVia(ctx, 'cases', caseId, 'cases');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('add_case_reply', { p_case_id: caseId, p_body: body });
  if (error) throw error;
  return data as string;
}

/** "Only a manager toggles state" — enforced INSIDE `toggle_case_state()`
 * itself (migration 30), not just by the UI disabling the button. */
export async function setCaseState(ctx: AuthContext, caseId: string, close: boolean): Promise<void> {
  await requireTabEditVia(ctx, 'cases', caseId, 'cases');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('toggle_case_state', { p_case_id: caseId, p_close: close });
  if (error) throw error;
}

/** Manager-or-admin only — enforced inside `set_case_solution()` (migration
 * 30: this RPC didn't exist before, only the admin-only `admin_edit_case()`
 * could touch `solution`, leaving an assigned non-admin manager — exactly
 * who the prototype's "Write the solution" button is for — with no real way
 * to do it). */
export async function setCaseSolution(ctx: AuthContext, caseId: string, solution: string): Promise<void> {
  await requireTabEditVia(ctx, 'cases', caseId, 'cases');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_case_solution', { p_case_id: caseId, p_solution: solution });
  if (error) throw error;
}

/** Admin-only. "Immutable to non-admins including authors; admins may edit
 * under full audit with an 'edited by' marker and prior text logged." */
export async function adminEditCase(
  ctx: AuthContext,
  caseId: string,
  newIssue: string | null,
  newSolution: string | null,
): Promise<void> {
  if (!ctx.isAdmin) throw new Error('Admin only');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('admin_edit_case', {
    p_case_id: caseId,
    p_new_issue: newIssue,
    p_new_solution: newSolution,
  });
  if (error) throw error;
}

/* -------------------------------------------------------------------------- */
/* The handling note — one standing instruction per record                    */
/* -------------------------------------------------------------------------- */

/**
 * "How to deal with this merchant's tickets", shown above the Cases list.
 *
 * The client asked for it in those terms: a place to write the method of
 * dealing with tickets "so anyone dealing with the ticket knows how to deal
 * with it". One per RECORD, not per case — it is what you want read BEFORE a
 * case is opened, which is why it is not a reply on any thread.
 *
 * No permission check is written here and none is missing. `case_handling_notes`
 * carries RLS copied predicate-for-predicate from `cases` (migration …9757),
 * so the request-scoped client cannot read a note on a record whose Cases tab
 * it cannot see, nor write one without Edit on that tab. Adding a second check
 * in this layer would be a second rule to keep in step with the first.
 */
export type CaseHandlingNote = { body: string; updatedBy: string | null; updatedAt: string } | null;

export async function caseHandlingNote(_ctx: AuthContext, recordId: string): Promise<CaseHandlingNote> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('case_handling_notes')
    .select('body, updated_by, updated_at')
    .eq('record_id', recordId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    body: data.body as string,
    updatedBy: (data.updated_by as string | null) ?? null,
    updatedAt: data.updated_at as string,
  };
}

/**
 * Save it, or clear it.
 *
 * An empty body DELETES the row rather than storing a blank one: "there is no
 * standing instruction for this merchant" and "the instruction is an empty
 * string" are the same fact, and keeping a row for it would put a stale
 * author and timestamp under a note that says nothing.
 */
export async function setCaseHandlingNote(
  ctx: AuthContext,
  recordId: string,
  body: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  await requireTabEdit(ctx, recordId, 'cases');
  const supabase = await createSupabaseServerClient();
  const trimmed = body.trim();

  if (!trimmed) {
    const { error } = await supabase.from('case_handling_notes').delete().eq('record_id', recordId);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  }

  const { error } = await supabase
    .from('case_handling_notes')
    .upsert(
      { record_id: recordId, body: trimmed, updated_by: ctx.userId, updated_at: new Date().toISOString() },
      { onConflict: 'record_id' },
    );
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
