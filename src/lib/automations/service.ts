/**
 * Automations for the admin page and the drawer. Every function starts at the
 * gate; after it, the admin tables are read on the service role, because they
 * have no policies of their own.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@/lib/records/config';
import type { AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { AutomationError, assertAutomationsEdit, assertAutomationsView } from './access';
import { BEHIND_AFTER_MS, backlogOf, type Backlog } from './backlog';
import { MAX_STEPS, problemsIn, stepCount, stepsSchema, type AutomationKind, type AutomationStatus, type AutomationSteps } from './steps';

export const FILES_BUCKET = 'automation-files';
const PAGE = 50;

export type AutomationFile = { id: string; name: string; size: number };

export type AutomationSummary = {
  id: string;
  name: string;
  kind: AutomationKind;
  status: AutomationStatus;
  steps: AutomationSteps;
  testRecordLabel: string | null;
  /** A ticket automation tests on one ticket. */
  testCaseLabel: string | null;
  waiting: number;
  runs: number;
  lastRunAt: string | null;
  updatedAt: string;
};

export type AutomationDetail = AutomationSummary & {
  testRecordId: string | null;
  testCaseId: string | null;
  stopTeamIds: string[];
  stopUserIds: string[];
  files: AutomationFile[];
  createdByName: string | null;
};

export type RunStep = { id: string; outcome: 'done' | 'waiting' | 'skipped' | 'failed'; detail: string; at: string };

export type RunView = {
  id: string;
  automationId: string;
  automationName: string;
  recordId: string | null;
  recordLabel: string | null;
  recordHref: string | null;
  /** "#10023 Statement question", for a ticket automation's run. */
  caseLabel: string | null;
  triggerKind: string | null;
  status: string;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
  resumeAt: string | null;
  steps: RunStep[];
};

export type AlertView = { runId: string; automationId: string; automationName: string; recordLabel: string | null; recordHref: string | null; reason: string; at: string };

export type SaveInput = {
  id: string | null;
  /** Set when it is created, never changed after. */
  kind: AutomationKind;
  name: string;
  steps: AutomationSteps;
  stopTeamIds: string[];
  stopUserIds: string[];
  /** What happens to records partway through a wait. Asked for only when there are some. */
  waiting: 'old' | 'new' | null;
};

const parseSteps = (raw: unknown): AutomationSteps => stepsSchema.parse(raw);

async function statsById(): Promise<Map<string, { waiting: number; lastRunAt: string | null; runs: number }>> {
  const { data, error } = await supabaseAdmin().rpc('automation_stats');
  if (error) throw error;
  return new Map((data ?? []).map((r: { automation_id: string; waiting: number; last_run_at: string | null; runs: number }) => [r.automation_id, { waiting: r.waiting, lastRunAt: r.last_run_at, runs: r.runs }]));
}

type Row = {
  id: string; name: string; kind: AutomationKind; status: AutomationStatus; test_record_id: string | null; test_case_id: string | null;
  updated_at: string; created_by: string | null;
  stop_team_ids: string[]; stop_user_ids: string[];
  version: { steps: unknown } | null;
  test_record: { deal_name: string | null } | null;
  test_case: { number: number; title: string } | null;
};
const SELECT =
  'id, name, kind, status, test_record_id, test_case_id, updated_at, created_by, stop_team_ids, stop_user_ids, ' +
  'version:automation_versions!automations_current_version (steps), test_record:records (deal_name), test_case:cases!automations_test_case_id_fkey (number, title)';

function summarise(r: Row, stats: Map<string, { waiting: number; lastRunAt: string | null; runs: number }>): AutomationSummary {
  const s = stats.get(r.id);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    steps: parseSteps(r.version?.steps),
    testRecordLabel: r.test_record?.deal_name ?? null,
    testCaseLabel: r.test_case ? `#${r.test_case.number} ${r.test_case.title}` : null,
    waiting: s?.waiting ?? 0,
    runs: s?.runs ?? 0,
    lastRunAt: s?.lastRunAt ?? null,
    updatedAt: r.updated_at,
  };
}

export async function listAutomations(ctx: AuthContext, kind: AutomationKind = 'record'): Promise<AutomationSummary[]> {
  await assertAutomationsView(ctx);
  const [{ data, error }, stats] = await Promise.all([
    supabaseAdmin().from('automations').select(SELECT).eq('kind', kind).is('deleted_at', null).order('updated_at', { ascending: false }),
    statsById(),
  ]);
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map((r) => summarise(r, stats));
}

export async function getAutomation(ctx: AuthContext, id: string): Promise<AutomationDetail | null> {
  await assertAutomationsView(ctx);
  const admin = supabaseAdmin();
  const [{ data, error }, stats, { data: files }] = await Promise.all([
    admin.from('automations').select(SELECT).eq('id', id).is('deleted_at', null).maybeSingle(),
    statsById(),
    admin.from('automation_files').select('id, name, size_bytes').eq('automation_id', id).order('created_at'),
  ]);
  if (error) throw error;
  if (!data) return null;
  const r = data as unknown as Row;
  const { data: creator } = r.created_by ? await admin.from('profiles').select('full_name, email').eq('id', r.created_by).maybeSingle() : { data: null };
  return {
    ...summarise(r, stats),
    testRecordId: r.test_record_id,
    testCaseId: r.test_case_id,
    stopTeamIds: r.stop_team_ids,
    stopUserIds: r.stop_user_ids,
    files: (files ?? []).map((f) => ({ id: f.id as string, name: f.name as string, size: Number(f.size_bytes) })),
    createdByName: (creator?.full_name as string | null)?.trim() || (creator?.email as string | null) || null,
  };
}

/** Spec: saving while records are partway through a wait asks what they do. */
export async function saveAutomation(ctx: AuthContext, input: SaveInput): Promise<{ id: string } | { needsChoice: number }> {
  await assertAutomationsEdit(ctx);
  if (stepCount(input.steps) > MAX_STEPS) throw new AutomationError(`An automation can have up to ${MAX_STEPS} steps.`);

  const existing = input.id ? await getAutomation(ctx, input.id) : null;
  if (input.id && !existing) throw new AutomationError('That automation no longer exists.');
  const kind = existing?.kind ?? input.kind;
  if (existing && (existing.status === 'test' || existing.status === 'on')) {
    const problems = problemsIn(input.steps, kind);
    if (problems.length) throw new AutomationError(`It is running, so it has to stay complete. ${problems[0]}`);
  }
  const changed = existing ? JSON.stringify(existing.steps) !== JSON.stringify(input.steps) : false;
  if (existing && changed && existing.waiting > 0 && !input.waiting) return { needsChoice: existing.waiting };

  const { data, error } = await supabaseAdmin().rpc('automation_save', {
    p_id: input.id,
    p_name: input.name,
    p_steps: input.steps,
    p_stop_teams: input.stopTeamIds,
    p_stop_users: input.stopUserIds,
    p_move_runs: input.waiting === 'new',
    p_actor: ctx.userId,
  });
  if (error) throw error;
  // A new ticket automation is one from its first save: it is a Draft, so nothing listens yet.
  if (!existing && kind === 'ticket') {
    const set = await supabaseAdmin().from('automations').update({ kind }).eq('id', data as string);
    if (set.error) throw set.error;
  }
  return { id: data as string };
}

export async function setAutomationStatus(
  ctx: AuthContext,
  id: string,
  status: AutomationStatus,
  testRecordId: string | null,
  testCaseId: string | null = null,
): Promise<{ ended: number }> {
  await assertAutomationsEdit(ctx);
  const a = await getAutomation(ctx, id);
  if (!a) throw new AutomationError('That automation no longer exists.');
  if (status === 'test' || status === 'on') {
    const problems = problemsIn(a.steps, a.kind);
    if (problems.length) throw new AutomationError(problems[0]!);
  }
  if (status === 'test' && a.kind === 'ticket' && !testCaseId) throw new AutomationError('Pick the ticket to test it on.');
  if (status === 'test' && a.kind === 'record' && !testRecordId) throw new AutomationError('Pick the record to test it on.');
  const { data, error } = await supabaseAdmin().rpc('automation_set_status', {
    p_automation: id,
    p_status: status,
    p_test_record: a.kind === 'record' ? testRecordId : null,
    p_actor: ctx.userId,
    p_test_case: a.kind === 'ticket' ? testCaseId : null,
  });
  if (error) {
    if (error.code === 'P0001') throw new AutomationError(error.message);
    throw error;
  }
  return { ended: Number(data ?? 0) };
}

export async function deleteAutomation(ctx: AuthContext, id: string): Promise<void> {
  await assertAutomationsEdit(ctx);
  const { error } = await supabaseAdmin().rpc('automation_delete', { p_automation: id, p_actor: ctx.userId });
  if (error) throw error;
}

/** For the Test record picker. */
export async function searchRecords(ctx: AuthContext, q: string): Promise<{ id: string; label: string }[]> {
  await assertAutomationsEdit(ctx);
  const term = q.trim().replace(/[%_,()]/g, ' ');
  if (!term) return [];
  const { data, error } = await supabaseAdmin().from('records').select('id, deal_name').is('deleted_at', null).ilike('deal_name', `%${term}%`).order('deal_name').limit(10);
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: r.id as string, label: (r.deal_name as string | null) ?? '(untitled)' }));
}

/** For the Test ticket picker: open tickets, by number, title or the record's name. */
export async function searchTickets(ctx: AuthContext, q: string): Promise<{ id: string; label: string; hint: string }[]> {
  await assertAutomationsEdit(ctx);
  const term = q.trim().replace(/^#/, '').replace(/[%_,()]/g, ' ').trim();
  if (!term) return [];
  const admin = supabaseAdmin();
  const cols = 'id, number, title, record:records!inner (deal_name, deleted_at)';
  const open = () => admin.from('cases').select(cols).eq('state', 'open').is('deleted_at', null).is('record.deleted_at', null);
  const [byTicket, byRecord] = await Promise.all([
    /^\d+$/.test(term) ? open().eq('number', Number(term)).limit(10) : open().ilike('title', `%${term}%`).limit(10),
    open().ilike('record.deal_name', `%${term}%`).limit(10),
  ]);
  if (byTicket.error) throw byTicket.error;
  if (byRecord.error) throw byRecord.error;
  const seen = new Map<string, { id: string; label: string; hint: string }>();
  for (const c of [...(byTicket.data ?? []), ...(byRecord.data ?? [])]) {
    const rec = c.record as unknown as { deal_name: string | null } | null;
    if (!rec || seen.has(c.id as string)) continue;
    seen.set(c.id as string, { id: c.id as string, label: `#${c.number as number} ${c.title as string}`, hint: rec.deal_name ?? '' });
  }
  return [...seen.values()].slice(0, 10);
}

// ── files attached to a Send email step ──────────────────────────────────────
export async function addAutomationFile(ctx: AuthContext, automationId: string, file: { name: string; type: string; bytes: Buffer }): Promise<AutomationFile> {
  await assertAutomationsEdit(ctx);
  const admin = supabaseAdmin();
  const safe = file.name.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
  const path = `${automationId}/${randomUUID()}/${safe}`;
  const up = await admin.storage.from(FILES_BUCKET).upload(path, file.bytes, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (up.error) throw up.error;
  const { data, error } = await admin
    .from('automation_files')
    .insert({ automation_id: automationId, name: file.name, size_bytes: file.bytes.length, content_type: file.type || 'application/octet-stream', storage_path: path, uploaded_by: ctx.userId })
    .select('id')
    .single();
  if (error) {
    await admin.storage.from(FILES_BUCKET).remove([path]);
    throw error;
  }
  return { id: data.id as string, name: file.name, size: file.bytes.length };
}

// ── run history ──────────────────────────────────────────────────────────────
/** A run's record opens in a module it is in, or the Records List if it is in none. */
async function hrefsFor(recordIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!recordIds.length) return out;
  const config = await loadConfig();
  const { data } = await supabaseAdmin().from('record_modules').select('record_id, module_id').in('record_id', recordIds);
  const storage = config.modules.find((m) => m.kind === 'storage');
  for (const r of data ?? []) {
    const m = config.modules.find((x) => x.id === r.module_id);
    if (m && !out.has(r.record_id as string)) out.set(r.record_id as string, `/${m.slug}?record=${r.record_id as string}`);
  }
  if (storage) for (const id of recordIds) if (!out.has(id)) out.set(id, `/${storage.slug}?record=${id}`);
  return out;
}

export async function listRuns(
  ctx: AuthContext,
  opts: { automationId?: string; status?: string; page?: number },
): Promise<{ runs: RunView[]; total: number; pageSize: number }> {
  await assertAutomationsView(ctx);
  const page = Math.max(0, opts.page ?? 0);
  let q = supabaseAdmin()
    .from('automation_runs')
    .select('id, automation_id, automation_name, record_id, record_label, case_label, trigger_kind, status, reason, started_at, finished_at, resume_at, automation_run_steps (id, outcome, detail, at)', { count: 'exact' })
    .order('started_at', { ascending: false })
    .range(page * PAGE, page * PAGE + PAGE - 1);
  if (opts.automationId) q = q.eq('automation_id', opts.automationId);
  q = opts.status ? q.eq('status', opts.status) : q.neq('status', 'not_matched');
  const { data, error, count } = await q;
  if (error) throw error;

  const rows = data ?? [];
  const hrefs = await hrefsFor([...new Set(rows.map((r) => r.record_id as string | null).filter((x): x is string => Boolean(x)))]);
  return {
    total: count ?? 0,
    pageSize: PAGE,
    runs: rows.map((r) => ({
      id: r.id as string,
      automationId: r.automation_id as string,
      automationName: r.automation_name as string,
      recordId: r.record_id as string | null,
      recordLabel: r.record_label as string | null,
      recordHref: r.record_id ? hrefs.get(r.record_id as string) ?? null : null,
      caseLabel: (r.case_label as string | null) ?? null,
      triggerKind: r.trigger_kind as string | null,
      status: r.status as string,
      reason: r.reason as string | null,
      startedAt: r.started_at as string,
      finishedAt: r.finished_at as string | null,
      resumeAt: r.resume_at as string | null,
      steps: ((r.automation_run_steps ?? []) as RunStep[]).slice().sort((a, b) => a.at.localeCompare(b.at)),
    })),
  };
}

/** Spec: the alert shows in the admin panel. */
/** What should have moved by now and hasn't. Null when the engine is keeping up. */
export async function automationBacklog(ctx: AuthContext): Promise<Backlog | null> {
  await assertAutomationsView(ctx);
  const admin = supabaseAdmin();
  const cut = new Date(Date.now() - BEHIND_AFTER_MS).toISOString();
  const [queued, waits] = await Promise.all([
    admin
      .from('automation_queue')
      .select('occurred_at', { count: 'exact' })
      .is('done_at', null)
      .lte('occurred_at', cut)
      .or(`not_before.is.null,not_before.lte.${cut}`)
      .order('occurred_at')
      .limit(1),
    admin
      .from('automation_runs')
      .select('resume_at', { count: 'exact' })
      .eq('status', 'waiting')
      .lte('resume_at', cut)
      .order('resume_at')
      .limit(1),
  ]);
  if (queued.error) throw queued.error;
  if (waits.error) throw waits.error;
  return backlogOf(
    { count: queued.count ?? 0, oldest: (queued.data?.[0]?.occurred_at as string | undefined) ?? null },
    { count: waits.count ?? 0, oldest: (waits.data?.[0]?.resume_at as string | undefined) ?? null },
  );
}

export async function listAlerts(ctx: AuthContext): Promise<AlertView[]> {
  await assertAutomationsView(ctx);
  const { data, error } = await supabaseAdmin()
    .from('automation_runs')
    .select('id, automation_id, automation_name, record_id, record_label, reason, alerted_at')
    .not('alerted_at', 'is', null)
    .is('alert_dismissed_at', null)
    .order('alerted_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = data ?? [];
  const hrefs = await hrefsFor([...new Set(rows.map((r) => r.record_id as string | null).filter((x): x is string => Boolean(x)))]);
  return rows.map((r) => ({
    runId: r.id as string,
    automationId: r.automation_id as string,
    automationName: r.automation_name as string,
    recordLabel: r.record_label as string | null,
    recordHref: r.record_id ? hrefs.get(r.record_id as string) ?? null : null,
    reason: (r.reason as string | null) ?? 'It stopped.',
    at: r.alerted_at as string,
  }));
}

export async function dismissAlert(ctx: AuthContext, runId: string): Promise<void> {
  await assertAutomationsEdit(ctx);
  const { error } = await supabaseAdmin().from('automation_runs').update({ alert_dismissed_at: new Date().toISOString() }).eq('id', runId);
  if (error) throw error;
}

// ── the drawer ───────────────────────────────────────────────────────────────
export type Waiting = { runId: string; name: string; resumeAt: string; canSwitchOff: boolean };

/** Asked as the viewer: the function refuses a record they can't see. */
export async function waitingOn(_ctx: AuthContext, recordId: string): Promise<Waiting[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('automation_waiting_on', { p_record: recordId });
  if (error) {
    // The icon is a convenience: without it the record must still open.
    console.error('[automations] waiting_on', error.code);
    return [];
  }
  return (data ?? []).map((r: { run_id: string; automation_name: string; resume_at: string; can_switch_off: boolean }) => ({
    runId: r.run_id,
    name: r.automation_name,
    resumeAt: r.resume_at,
    canSwitchOff: r.can_switch_off,
  }));
}

export async function switchOffForRecord(_ctx: AuthContext, runId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('automation_switch_off', { p_run: runId });
  if (error) {
    if (error.code === '42501' || error.code === '23514') throw new AutomationError(error.message);
    throw error;
  }
}
