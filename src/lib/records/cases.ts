/**
 * Cases. Issue required and immutable to non-admins; a case cannot close
 * without a Solution (enforced twice: the `closed_requires_solution` check
 * constraint, and `toggle_case_state`'s friendly pre-check ahead of it); no
 * fields, ever. Every mutation here is one of migration 13's combined
 * write+log functions.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { permissionsFor, type AuthContext } from './permissions';
import { requireTabEdit, requireTabEditVia } from './tabAccess';
import { mentionCandidates, reconcileMentions, type Candidate } from './notifications';

export type CaseThread = {
  id: string;
  recordId: string;
  number: number;
  title: string;
  issue: string;
  /** Null when an automation opened it: `automationName` says which. */
  issueAuthor: string | null;
  automationName: string | null;
  issueAt: string;
  solution: string | null;
  solutionAuthor: string | null;
  solutionAt: string | null;
  state: 'open' | 'closed';
  editedBy: string | null;
  createdAt: string;
  /** The Awaiting client tag (Ticket Automation Flow Builder spec): when, and who set it. */
  awaitingClientAt: string | null;
  awaitingClientBy: string | null;
};

/** One line of a ticket's log: a person's click, or an action a flow took. */
export type CaseLogLine = {
  id: string;
  caseId: string;
  body: string;
  actorId: string | null;
  automationName: string | null;
  createdAt: string;
};

export type CaseReply = { id: string; caseId: string; authorId: string; body: string; createdAt: string; mentionedUserIds: string[] };

function mapCase(r: Record<string, unknown>): CaseThread {
  return {
    id: r.id as string,
    recordId: r.record_id as string,
    number: r.number as number,
    title: r.title as string,
    issue: r.issue as string,
    issueAuthor: (r.issue_author as string | null) ?? null,
    automationName: (r.automation_name as string | null) ?? null,
    issueAt: r.issue_at as string,
    solution: (r.solution as string | null) ?? null,
    solutionAuthor: (r.solution_author as string | null) ?? null,
    solutionAt: (r.solution_at as string | null) ?? null,
    state: r.state as 'open' | 'closed',
    editedBy: (r.edited_by as string | null) ?? null,
    createdAt: r.created_at as string,
    awaitingClientAt: (r.awaiting_client_at as string | null) ?? null,
    awaitingClientBy: (r.awaiting_client_by as string | null) ?? null,
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
    .select('*, case_reply_mentions (user_id)')
    .eq('case_id', caseId)
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id, caseId: r.case_id, authorId: r.author_id, body: r.body, createdAt: r.created_at,
    mentionedUserIds: ((r.case_reply_mentions ?? []) as { user_id: string }[]).map((m) => m.user_id),
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
    .select('*, case_reply_mentions (user_id)')
    .in('case_id', caseIds)
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;

  for (const r of data ?? []) {
    (out[r.case_id as string] ??= []).push({
      id: r.id, caseId: r.case_id, authorId: r.author_id, body: r.body, createdAt: r.created_at,
      mentionedUserIds: ((r.case_reply_mentions ?? []) as { user_id: string }[]).map((m) => m.user_id),
    });
  }
  return out;
}

/** The log of a SET of cases, oldest first, in one query. Read as the viewer:
 * a line is seen by whoever sees its ticket. */
export async function logForCases(_ctx: AuthContext, caseIds: string[]): Promise<Record<string, CaseLogLine[]>> {
  const out: Record<string, CaseLogLine[]> = {};
  for (const id of caseIds) out[id] = [];
  if (!caseIds.length) return out;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('case_log')
    .select('id, case_id, body, actor_id, automation_name, created_at')
    .in('case_id', caseIds)
    .order('created_at');
  if (error) throw error;
  for (const r of data ?? []) {
    (out[r.case_id as string] ??= []).push({
      id: r.id as string,
      caseId: r.case_id as string,
      body: r.body as string,
      actorId: (r.actor_id as string | null) ?? null,
      automationName: (r.automation_name as string | null) ?? null,
      createdAt: r.created_at as string,
    });
  }
  return out;
}

/** An email on this record waiting for someone to choose its ticket. */
export type TicketChoice = {
  id: string;
  automationName: string;
  sender: string | null;
  subject: string | null;
  createdAt: string;
  expiresAt: string;
  tickets: { id: string; number: number; title: string }[];
};

/**
 * The note in Vital Info (spec, "Choosing a ticket for an email"). The function
 * answers only for the people it asks: the users assigned to the record's open
 * tickets, or, when nobody is, everyone who can open the record in Tickets.
 */
export async function ticketChoicesFor(_ctx: AuthContext, recordId: string): Promise<TicketChoice[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('ticket_choices_for', { p_record: recordId });
  if (error) {
    // A note, not the record: the drawer must still open without it.
    console.error('[tickets] choices', error.code);
    return [];
  }
  return ((data ?? []) as { choice_id: string; automation_name: string; sender: string | null; subject: string | null; created_at: string; expires_at: string; tickets: TicketChoice['tickets'] }[]).map((r) => ({
    id: r.choice_id,
    automationName: r.automation_name,
    sender: r.sender,
    subject: r.subject,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    tickets: r.tickets ?? [],
  }));
}

/** The flow then runs on the chosen ticket. */
export async function chooseTicket(_ctx: AuthContext, choiceId: string, caseId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('ticket_choose', { p_choice: choiceId, p_case: caseId });
  if (error) {
    if (error.code === '23514') throw new Error(error.message);
    if (error.message === 'not found') throw new Error('That choice is not available to you.');
    throw error;
  }
}

/**
 * For the rows of the module that shows open cases: which records have an open
 * ticket marked Awaiting client (read as the viewer, so the tag shows to
 * whoever can open that ticket), and which have an email waiting for the viewer
 * to choose its ticket (the badge the spec puts on the row).
 */
export async function ticketFlagsFor(_ctx: AuthContext, recordIds: string[]): Promise<{ awaiting: Set<string>; choosing: Set<string> }> {
  const out = { awaiting: new Set<string>(), choosing: new Set<string>() };
  if (!recordIds.length) return out;
  const supabase = await createSupabaseServerClient();
  const [tagged, waiting] = await Promise.all([
    supabase
      .from('cases')
      .select('record_id')
      .in('record_id', recordIds)
      .eq('state', 'open')
      .is('deleted_at', null)
      .not('awaiting_client_at', 'is', null),
    supabase.rpc('ticket_choice_records'),
  ]);
  if (tagged.error) throw tagged.error;
  for (const r of tagged.data ?? []) out.awaiting.add(r.record_id as string);
  // The badge is a convenience: without it the list must still load.
  if (waiting.error) console.error('[tickets] choice badges', waiting.error.code);
  const wanted = new Set(recordIds);
  for (const id of (waiting.data ?? []) as string[]) if (wanted.has(id)) out.choosing.add(id);
  return out;
}

/**
 * Awaiting client, set or cleared by hand. The function is the gate: anyone who
 * can open the ticket and has Use Awaiting client. Setting it on an open ticket
 * starts any flow that listens for the button; an already tagged ticket is left
 * as it is and starts nothing. Returns whether anything changed.
 */
export async function setAwaitingClient(_ctx: AuthContext, caseId: string, on: boolean): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('set_awaiting_client', { p_case: caseId, p_on: on });
  if (error) {
    if (error.code === '42501' || error.code === '23514') throw new Error(error.message);
    if (error.message === 'not found') throw new Error('That ticket is not available.');
    throw error;
  }
  return Boolean(data);
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

/** Who may be @mentioned on this record's cases. */
export async function caseRosterFor(ctx: AuthContext, recordId: string): Promise<Candidate[]> {
  return mentionCandidates(ctx, recordId, 'cases');
}

export async function addReply(
  ctx: AuthContext,
  caseId: string,
  body: string,
  mentionedUserIds: string[] = [],
): Promise<{ id: string; mentioned: string[] }> {
  await requireTabEditVia(ctx, 'cases', caseId, 'cases');
  const supabase = await createSupabaseServerClient();
  const { data: row, error: readErr } = await supabase.from('cases').select('record_id').eq('id', caseId).maybeSingle();
  if (readErr) throw readErr;
  if (!row) throw new Error('not found');
  const roster = await caseRosterFor(ctx, row.record_id as string);
  const mentioned = reconcileMentions(body, mentionedUserIds, roster);
  const { data, error } = await supabase.rpc('add_case_reply_with_mentions', {
    p_case_id: caseId,
    p_body: body,
    p_mentioned_user_ids: mentioned,
  });
  if (error) throw error;
  return { id: data as string, mentioned };
}

/** "Only a manager toggles state" — enforced INSIDE `toggle_case_state()`
 * itself (migration 30), not just by the UI disabling the button. */
export async function setCaseState(ctx: AuthContext, caseId: string, close: boolean): Promise<void> {
  await requireTabEditVia(ctx, 'cases', caseId, 'cases');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('toggle_case_state', { p_case_id: caseId, p_close: close });
  if (error) throw error;
}

/**
 * Closes every open case on each of the given records — the way a record
 * leaves a module that shows open cases (migration 9764: membership there
 * is automatic while a case is open, and Remove/Archive leave it alone).
 *
 * A case cannot close without a Solution (`closed_requires_solution`), so
 * `solution` is written first on any case that has none; a case that already
 * has one keeps it. Each case goes through the same RPCs as the Cases tab,
 * with the same gates (Cases tab edit; manager or admin inside
 * `toggle_case_state`). A record is reported skipped the moment one of its
 * cases is refused, with that reason — never silently.
 */
export async function closeOpenCases(
  ctx: AuthContext,
  recordIds: string[],
  solution: string,
): Promise<{ applied: string[]; skipped: { id: string; reason: string }[] }> {
  const supabase = await createSupabaseServerClient();
  const applied: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const { data, error } = await supabase
    .from('cases')
    .select('id, record_id, solution')
    .in('record_id', recordIds)
    .eq('state', 'open')
    .is('deleted_at', null);
  if (error) throw error;
  const byRecord = new Map<string, { id: string; solution: string | null }[]>();
  for (const c of (data ?? []) as { id: string; record_id: string; solution: string | null }[]) {
    (byRecord.get(c.record_id) ?? byRecord.set(c.record_id, []).get(c.record_id)!).push({ id: c.id, solution: c.solution });
  }
  for (const recordId of recordIds) {
    const open = byRecord.get(recordId) ?? [];
    if (!open.length) {
      skipped.push({ id: recordId, reason: 'No open case' });
      continue;
    }
    try {
      for (const c of open) {
        if (!c.solution) await setCaseSolution(ctx, c.id, solution);
        await setCaseState(ctx, c.id, true);
      }
      applied.push(recordId);
    } catch (e) {
      skipped.push({ id: recordId, reason: e instanceof Error ? e.message : 'Could not close its cases' });
    }
  }
  return { applied, skipped };
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

/**
 * Admin-only, soft: the thread and its live replies go to the Recycle Bin
 * (`delete_case`, migration 53 — defined there and never called from the app
 * until the client asked for a delete control on the case, 16 Oct 2026).
 * `restore_case` in `recycleBin.ts` is the way back. The admin rule is
 * enforced inside the function; this check only gives the refusal a sentence
 * before the round trip.
 */
/** Izzy, 3 Nov 2026: only admins delete and restore a case. Super admin or Admin;
 *  `auth_case_admin` is the same answer in the database. */
export async function canDeleteCases(ctx: AuthContext): Promise<boolean> {
  return ctx.isAdmin || (await permissionsFor(ctx)).userType === 'admin';
}

export async function deleteCase(ctx: AuthContext, caseId: string): Promise<void> {
  if (!(await canDeleteCases(ctx))) throw new Error('Only an admin can delete a case.');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_case', { p_case_id: caseId });
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
