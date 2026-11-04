/**
 * The processor integration's rules (Maverick Integration — Feature Spec,
 * 3 Nov 2026). Every function asks the gate first: the record's tab, then the
 * permission. Processor tables have no browser grant, so they are read here
 * with the service role, after that check, and only what the viewer may see
 * leaves this file.
 *
 * Reporting, Other cases, the application status and send, the unmatched flag
 * and the connection page. The daily sync is `sync.ts`; the processor itself is
 * behind `vendor.ts`.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadConfig, type Config } from '@/lib/records/config';
import { fieldGrant, type AuthContext } from '@/lib/records/permissions';
import { tabAccess } from '@/lib/records/tabAccess';
import { addReply, createCase } from '@/lib/records/cases';
import { groupFieldProblems, isFilled, requiredFlagProblems, type FieldProblem, type ProblemGroup } from '@/lib/records/fieldProblems';
import { hiddenFieldKeysFor } from '@/lib/records/tabAccess';
import { APPLICATION_ROWS } from '@/lib/records/fileRowNames';
import { APPLICATION_FIELD_KEYS } from '@/lib/applications/mapping';
import { recordForApplication } from '@/lib/applications/store';
import { rateLimit, userKey } from '@/lib/security/rate-limit';
import { need, processorPerms, ProcessorAccessError, type ProcessorPerms } from './access';
import { PAGE_SIZE, reportView, REPORT_VIEWS, type ReportFilters, type ReportViewKey } from './reportingViews';
import { PROCESSOR, PROCESSOR_LABEL, ProcessorError, ProcessorNotReady, processorConnected, processorVendor } from './vendor';

export { ProcessorAccessError };
export class ProcessorServiceError extends Error {}

/** The CRM field matched against the processor's MID (spec: "matched … by MID"). */
export const MID_FIELD_KEY = 'mid';

const db = () => supabaseAdmin();

const DATA_TYPES = ['merchants', 'transactions', 'batches', 'payouts', 'ach', 'statements', 'tickets', 'application_status'] as const;
export type DataType = (typeof DATA_TYPES)[number];
export const DATA_TYPE_LABEL: Record<DataType, string> = {
  merchants: 'Merchants',
  transactions: 'Transactions',
  batches: 'Batches',
  payouts: 'Payouts',
  ach: 'ACH',
  statements: 'Statements',
  tickets: 'Tickets',
  application_status: 'Application status',
};

async function lastSuccess(types: readonly DataType[]): Promise<string | null> {
  const { data, error } = await db().from('processor_sync_state').select('data_type, last_success_at').eq('processor', PROCESSOR).in('data_type', [...types]);
  if (error) throw error;
  const times = (data ?? []).map((r) => r.last_success_at as string | null).filter((x): x is string => Boolean(x)).sort();
  return times[0] ?? null;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export const reportingTabKey = async (): Promise<string | null> => (await loadConfig()).tabs.find((t) => t.showsReporting)?.key ?? null;

async function reportingAccess(ctx: AuthContext, recordId: string): Promise<ProcessorPerms> {
  const perms = await processorPerms(ctx);
  const tab = await reportingTabKey();
  if (!tab || !perms.reportingTab || (await tabAccess(ctx, recordId, tab)) === 'hidden') throw new ProcessorAccessError('You don’t have access to Reporting on this record.');
  return perms;
}

export type ReportingPanel = {
  views: { key: ReportViewKey; section: 'acquiring' | 'ach'; label: string }[];
  lastUpdated: string | null;
  connected: boolean;
  matched: boolean;
};

/** What the Reporting tab offers this viewer on this record. Null: they get no Reporting. */
export async function reportingPanelFor(ctx: AuthContext, recordId: string): Promise<ReportingPanel | null> {
  let perms: ProcessorPerms;
  try {
    perms = await reportingAccess(ctx, recordId);
  } catch (e) {
    if (e instanceof ProcessorAccessError) return null;
    throw e;
  }
  const views = REPORT_VIEWS.filter((v) => (v.section === 'acquiring' ? perms.acquiring : perms.ach)).map((v) => ({ key: v.key, section: v.section, label: v.label }));
  if (!views.length) return null;
  const [{ data: merchant }, lastUpdated, connected] = await Promise.all([
    db().from('processor_merchants').select('id').eq('processor', PROCESSOR).eq('record_id', recordId).limit(1).maybeSingle(),
    lastSuccess(['transactions', 'batches', 'payouts', 'ach']),
    processorConnected(),
  ]);
  return { views, lastUpdated, connected, matched: Boolean(merchant) };
}

export type ReportPage = { rows: Record<string, string | number | null>[]; more: boolean; options: Record<string, string[]> };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One page of one Reporting screen, filtered on the server. Read-only; no totals. */
export async function reportingRows(ctx: AuthContext, recordId: string, viewKey: string, filters: ReportFilters, page: number): Promise<ReportPage> {
  const perms = await reportingAccess(ctx, recordId);
  const view = reportView(viewKey);
  if (!view) throw new ProcessorServiceError('That report does not exist.');
  need(view.section === 'acquiring' ? perms.acquiring : perms.ach, `see ${view.section === 'acquiring' ? 'Acquiring' : 'ACH'} reports`);

  const cols = view.columns.map((c) => c.key);
  let q = db().from(view.table).select(['id', ...cols].join(', ')).eq('processor', PROCESSOR).eq('record_id', recordId);
  for (const c of view.columns) {
    const f = filters[c.key];
    if (!f || !c.filter) continue;
    if (c.filter === 'values' && f.values?.length) q = q.in(c.key, f.values.slice(0, 200).map((v) => v.slice(0, 200)));
    if (c.filter === 'date') {
      if (f.from && DATE.test(f.from)) q = q.gte(c.key, f.from);
      if (f.to && DATE.test(f.to)) q = q.lte(c.key, c.kind === 'datetime' ? `${f.to}T23:59:59.999Z` : f.to);
    }
    if (c.filter === 'last4' && f.last4 && /^\d{1,4}$/.test(f.last4)) q = q.like(c.key, `%${f.last4}%`);
  }
  const from = Math.max(0, page) * PAGE_SIZE;
  const { data, error } = await q.order(view.dateColumn, { ascending: false, nullsFirst: false }).order('id').range(from, from + PAGE_SIZE);
  if (error) throw error;
  const rows = ((data ?? []) as unknown as Record<string, string | number | null>[]).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id')));

  // The checklist for each "values" header: what the column holds on this record.
  const options: Record<string, string[]> = {};
  const listed = view.columns.filter((c) => c.filter === 'values');
  if (listed.length && page === 0) {
    const { data: all, error: optError } = await db().from(view.table).select(listed.map((c) => c.key).join(', ')).eq('processor', PROCESSOR).eq('record_id', recordId).limit(5000);
    if (optError) throw optError;
    for (const c of listed) {
      options[c.key] = [...new Set(((all ?? []) as unknown as Record<string, unknown>[]).map((r) => r[c.key]).filter((v): v is string => typeof v === 'string' && v !== ''))].sort();
    }
  }
  return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE, options };
}

// ── Other cases ──────────────────────────────────────────────────────────────

export type OtherCase = {
  id: string;
  externalId: string;
  title: string;
  status: string | null;
  details: { label: string; value: string }[];
  openedAt: string | null;
  changedAt: string | null;
  linkedCase: { id: string; number: number; title: string } | null;
  linkedAt: string | null;
};
export type OtherCasesData = { items: OtherCase[]; unsynced: number; canSync: boolean; openCases: { id: string; number: number; title: string }[]; lastUpdated: string | null };

async function otherCasesAccess(ctx: AuthContext, recordId: string): Promise<ProcessorPerms> {
  const perms = await processorPerms(ctx);
  if (!perms.otherCases || (await tabAccess(ctx, recordId, 'cases')) === 'hidden') throw new ProcessorAccessError('You don’t have access to Other cases on this record.');
  return perms;
}

/** Null when the viewer may not see Other cases here. */
export async function otherCasesFor(ctx: AuthContext, recordId: string): Promise<OtherCasesData | null> {
  let perms: ProcessorPerms;
  try {
    perms = await otherCasesAccess(ctx, recordId);
  } catch (e) {
    if (e instanceof ProcessorAccessError) return null;
    throw e;
  }
  const [{ data: tickets, error }, { data: cases, error: casesError }, lastUpdated] = await Promise.all([
    db().from('processor_tickets').select('id, external_id, title, status, details, opened_at, changed_at, case_id, linked_at').eq('processor', PROCESSOR).eq('record_id', recordId).order('opened_at', { ascending: false, nullsFirst: false }),
    db().from('cases').select('id, number, title, state').eq('record_id', recordId).is('deleted_at', null),
    lastSuccess(['tickets']),
  ]);
  if (error) throw error;
  if (casesError) throw casesError;
  const linked = new Set((tickets ?? []).map((t) => t.case_id as string | null).filter(Boolean));
  const byId = new Map((cases ?? []).map((c) => [c.id as string, c]));
  const items: OtherCase[] = (tickets ?? []).map((t) => {
    const c = t.case_id ? byId.get(t.case_id as string) : undefined;
    return {
      id: t.id as string,
      externalId: t.external_id as string,
      title: (t.title as string | null) ?? `Ticket ${t.external_id as string}`,
      status: t.status as string | null,
      details: Array.isArray(t.details) ? (t.details as { label: string; value: string }[]).slice(0, 60) : [],
      openedAt: t.opened_at as string | null,
      changedAt: t.changed_at as string | null,
      linkedCase: c ? { id: c.id as string, number: Number(c.number), title: c.title as string } : null,
      linkedAt: t.linked_at as string | null,
    };
  });
  return {
    items,
    unsynced: items.filter((i) => !i.linkedCase).length,
    canSync: perms.syncCase && (await tabAccess(ctx, recordId, 'cases')) === 'edit',
    openCases: (cases ?? []).filter((c) => c.state === 'open' && !linked.has(c.id as string)).map((c) => ({ id: c.id as string, number: Number(c.number), title: c.title as string })).sort((a, b) => b.number - a.number),
    lastUpdated,
  };
}

/** How many Other cases are waiting to be synced, per record: the Cases header and the Tickets module show it. */
export async function unsyncedOtherCases(ctx: AuthContext, recordIds: string[]): Promise<Record<string, number>> {
  if (!recordIds.length || !(await processorPerms(ctx)).otherCases) return {};
  const { data, error } = await db().from('processor_tickets').select('record_id').eq('processor', PROCESSOR).is('case_id', null).in('record_id', recordIds.slice(0, 1000));
  if (error) throw error;
  const out: Record<string, number> = {};
  for (const r of data ?? []) out[r.record_id as string] = (out[r.record_id as string] ?? 0) + 1;
  return out;
}

async function ticketForSync(ctx: AuthContext, ticketId: string) {
  const { data: t, error } = await db().from('processor_tickets').select('id, record_id, external_id, title, status, details, opened_at, case_id').eq('id', ticketId).maybeSingle();
  if (error) throw error;
  if (!t?.record_id) throw new ProcessorServiceError('That ticket no longer exists.');
  const perms = await otherCasesAccess(ctx, t.record_id as string);
  need(perms.syncCase, 'sync Other cases');
  if ((await tabAccess(ctx, t.record_id as string, 'cases')) !== 'edit') throw new ProcessorAccessError('You can’t change cases on this record.');
  if (t.case_id) throw new ProcessorServiceError('That ticket is already synced with a case.');
  return t;
}

/** The ticket's information, as the case thread shows it. */
function ticketThreadText(t: { external_id: unknown; title: unknown; status: unknown; details: unknown; opened_at: unknown }): string {
  const lines = [`${PROCESSOR_LABEL} ticket ${String(t.external_id)}${t.title ? `: ${String(t.title)}` : ''}`];
  if (t.status) lines.push(`Status: ${String(t.status)}`);
  if (t.opened_at) lines.push(`Opened: ${new Date(String(t.opened_at)).toLocaleString('en-US', { timeZone: 'America/New_York' })}`);
  for (const d of Array.isArray(t.details) ? (t.details as { label: string; value: string }[]) : []) lines.push(`${d.label}: ${d.value}`);
  return lines.join('\n').slice(0, 8000);
}

async function link(ctx: AuthContext, t: Awaited<ReturnType<typeof ticketForSync>>, caseId: string): Promise<void> {
  const { error } = await db().rpc('processor_link_ticket', { p_ticket: t.id, p_case: caseId, p_actor: ctx.userId });
  if (error) {
    if (error.code === '23505' || error.code === 'P0002' || error.code === '22023') throw new ProcessorServiceError(error.message);
    throw error;
  }
  // Spec: "The Maverick ticket's information is placed into the regular case's thread."
  await addReply(ctx, caseId, ticketThreadText(t));
}

/** Sync an Other case with an open case on the same record. One ticket, one case. */
export async function syncOtherCase(ctx: AuthContext, ticketId: string, caseId: string): Promise<void> {
  const t = await ticketForSync(ctx, ticketId);
  const { data: c, error } = await db().from('cases').select('id, record_id, state').eq('id', caseId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!c || c.record_id !== t.record_id) throw new ProcessorServiceError('That case is not on this record.');
  if (c.state !== 'open') throw new ProcessorServiceError('Pick an open case.');
  await link(ctx, t, caseId);
}

/** Open a new case (title + Issue, as usual) and sync the ticket with it. */
export async function openCaseForOtherCase(ctx: AuthContext, ticketId: string, title: string, issue: string): Promise<{ caseId: string }> {
  const t = await ticketForSync(ctx, ticketId);
  const caseId = await createCase(ctx, t.record_id as string, title, issue, []);
  await link(ctx, t, caseId);
  return { caseId };
}

// ── The application on the processor's side ─────────────────────────────────

export type ProcessorApplicationView = {
  label: string;
  /** Null when the viewer may not see the status. */
  status: string | null;
  statusAt: string | null;
  sent: boolean;
  lastSentAt: string | null;
  lastSentBy: string | null;
  lastAction: 'create' | 'update' | null;
  lastError: string | null;
  canSend: boolean;
  canUpdate: boolean;
  canCheck: boolean;
  connected: boolean;
};

const applicationsTabKey = async (): Promise<string | null> => (await loadConfig()).tabs.find((t) => t.showsApplications)?.key ?? null;

/** For the Applications tab. Null when the viewer has nothing from the processor here. */
export async function processorApplicationFor(ctx: AuthContext, recordId: string): Promise<ProcessorApplicationView | null> {
  const perms = await processorPerms(ctx);
  if (!perms.status && !perms.send && !perms.update && !perms.check) return null;
  const tab = await applicationsTabKey();
  const grant = tab ? await tabAccess(ctx, recordId, tab) : 'hidden';
  if (grant === 'hidden') return null;
  const { data: a, error } = await db().from('processor_applications').select('external_id, status, status_at, last_action, last_sent_at, last_sent_by, last_error').eq('processor', PROCESSOR).eq('record_id', recordId).maybeSingle();
  if (error) throw error;
  let lastSentBy: string | null = null;
  if (a?.last_sent_by) {
    const { data: p } = await db().from('profiles').select('full_name, email').eq('id', a.last_sent_by).maybeSingle();
    lastSentBy = ((p?.full_name as string | null)?.trim() || (p?.email as string | null)) ?? null;
  }
  const sent = Boolean(a?.external_id);
  const canEdit = grant === 'edit';
  return {
    label: PROCESSOR_LABEL,
    status: perms.status ? ((a?.status as string | null) ?? null) : null,
    statusAt: perms.status ? ((a?.status_at as string | null) ?? null) : null,
    sent,
    lastSentAt: (a?.last_sent_at as string | null) ?? null,
    lastSentBy,
    lastAction: (a?.last_action as 'create' | 'update' | null) ?? null,
    lastError: perms.send || perms.update ? ((a?.last_error as string | null) ?? null) : null,
    canSend: canEdit && perms.send && !sent,
    canUpdate: canEdit && perms.update && sent,
    canCheck: perms.check,
    connected: await processorConnected(),
  };
}

/** Vital Info's eighth slot: the status, read-only, for permitted users only; and the unmatched flag. */
export async function processorVitals(ctx: AuthContext, recordId: string): Promise<{ status: string | null; showStatus: boolean; unmatched: boolean }> {
  const perms = await processorPerms(ctx);
  let status: string | null = null;
  if (perms.status) {
    const { data, error } = await db().from('processor_applications').select('status').eq('processor', PROCESSOR).eq('record_id', recordId).maybeSingle();
    if (error) throw error;
    status = (data?.status as string | null) ?? null;
  }
  const unmatched = perms.unmatchedFlag ? (await unmatchedRecords([recordId]))[recordId] === true : false;
  return { status, showStatus: perms.status, unmatched };
}

export type DocumentCheck = { row: string; ok: boolean; files: number };
export type ProcessorCheck = { groups: ProblemGroup[]; documents: DocumentCheck[]; fields: { key: string; label: string; value: string }[] };

const fieldText = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(fieldText).filter(Boolean).join(', ');
  return Object.values(v as Record<string, unknown>).map(fieldText).filter(Boolean).join(', ');
};

/**
 * The stop-flow check (spec, Pre-send check): every required field and every
 * required document, in one list. Until Izzy's field list is in, required means
 * the application's own core fields plus any field marked Required in Presets.
 */
export async function processorPreCheck(ctx: AuthContext, recordId: string, opts: { forCheckTab?: boolean } = {}): Promise<ProcessorCheck> {
  const perms = await processorPerms(ctx);
  need(opts.forCheckTab ? perms.check : perms.send || perms.update || perms.check, opts.forCheckTab ? 'use the pre-send check' : 'send to Maverick');
  const tab = await applicationsTabKey();
  if (!tab || (await tabAccess(ctx, recordId, tab)) === 'hidden') throw new ProcessorAccessError('You don’t have access to the application on this record.');
  const rec = await recordForApplication(recordId);
  if (!rec) throw new ProcessorServiceError('That record no longer exists.');
  const config = await loadConfig();
  const hidden = await hiddenFieldKeysFor(ctx, recordId, config.fields);
  const v = rec.values;
  const problems: FieldProblem[] = [];
  const core: [string, string, boolean][] = [
    ['legal_business_name', 'the business’s legal name. Fill it in first.', isFilled(v.legal_business_name)],
    ['merchant_address', 'the business address.', isFilled(v.merchant_address)],
    ['owner_ownership', 'at least one owner.', Array.isArray(v.owner_ownership) && v.owner_ownership.length > 0],
  ];
  for (const [key, message, ok] of core) {
    if (hidden.has(key)) problems.push({ fieldKey: key, message: 'needed, in a section you can’t see. Ask someone who can to fill it in.' });
    else if (!ok) problems.push({ fieldKey: key, message });
  }
  const already = new Set(problems.map((p) => p.fieldKey));
  problems.push(...requiredFlagProblems(config, v, APPLICATION_FIELD_KEYS.filter((k) => !already.has(k)), hidden));

  // Required documents: the Files tab's preset rows Maverick asks for.
  const wanted = APPLICATION_ROWS.filter((r) => r !== 'Agreement');
  const { data: rows, error } = await db().from('file_rows').select('id, name').eq('record_id', recordId).is('deleted_at', null).in('name', [...wanted]);
  if (error) throw error;
  const ids = (rows ?? []).map((r) => r.id as string);
  const { data: files, error: filesError } = ids.length ? await db().from('files').select('file_row_id').in('file_row_id', ids).is('deleted_at', null) : { data: [], error: null };
  if (filesError) throw filesError;
  const count = new Map<string, number>();
  for (const f of files ?? []) count.set(f.file_row_id as string, (count.get(f.file_row_id as string) ?? 0) + 1);
  const documents: DocumentCheck[] = wanted.map((name) => {
    const n = (rows ?? []).filter((r) => r.name === name).reduce((s, r) => s + (count.get(r.id as string) ?? 0), 0);
    return { row: name, ok: n > 0, files: n };
  });

  // The check tab lists what will be sent, from what this viewer may see.
  const fields = opts.forCheckTab
    ? APPLICATION_FIELD_KEYS.filter((k) => !hidden.has(k)).map((k) => ({ key: k, label: config.fields.find((f) => f.key === k)?.label ?? k, value: fieldText(v[k]).slice(0, 300) }))
    : [];
  return { groups: groupFieldProblems(config, problems), documents, fields };
}

/** Send to Maverick (first time) or Update Maverick. Manual only. Logged either way. */
export async function sendApplicationToProcessor(ctx: AuthContext, recordId: string): Promise<{ action: 'create' | 'update' }> {
  const view = await processorApplicationFor(ctx, recordId);
  if (!view) throw new ProcessorAccessError('You don’t have access to the application on this record.');
  const action: 'create' | 'update' = view.sent ? 'update' : 'create';
  if (action === 'create' ? !view.canSend : !view.canUpdate) throw new ProcessorAccessError(`You don’t have permission to ${action === 'create' ? 'send to' : 'update'} ${PROCESSOR_LABEL}.`);
  const limit = await rateLimit(userKey('processor_send', ctx.userId), { limit: 10, windowSeconds: 600 });
  if (!limit.allowed) throw new ProcessorServiceError('Too many sends. Try again in a few minutes.');

  const check = await processorPreCheck(ctx, recordId);
  if (check.groups.length || check.documents.some((d) => !d.ok)) throw new ProcessorServiceError('The pre-send check found missing items. Nothing was sent.');

  const word = action === 'create' ? 'Send to' : 'Update';
  try {
    const vendor = await processorVendor();
    const { data: row } = await db().from('processor_applications').select('external_id').eq('processor', PROCESSOR).eq('record_id', recordId).maybeSingle();
    const rec = await recordForApplication(recordId);
    const fields = Object.fromEntries(APPLICATION_FIELD_KEYS.map((k) => [k, rec?.values[k] ?? null]));
    const out = await vendor.sendApplication({ externalId: (row?.external_id as string | null) ?? null, fields, documents: [] });
    const { error } = await db().from('processor_applications').upsert(
      { processor: PROCESSOR, record_id: recordId, external_id: out.externalId, last_action: action, last_sent_at: new Date().toISOString(), last_sent_by: ctx.userId, last_error: null, last_error_at: null },
      { onConflict: 'processor,record_id' },
    );
    if (error) throw error;
    await db().rpc('processor_log', {
      p_record: recordId, p_actor: ctx.userId, p_source: PROCESSOR_LABEL,
      p_summary: `${word} ${PROCESSOR_LABEL}: ${action === 'create' ? 'application created' : 'application updated'}`,
      p_update_body: `${word} ${PROCESSOR_LABEL}: the application was ${action === 'create' ? 'created' : 'updated'} (${Object.keys(fields).length} fields).`,
    });
    return { action };
  } catch (e) {
    const message = e instanceof ProcessorNotReady || e instanceof ProcessorError ? e.message : `${PROCESSOR_LABEL} could not be reached. Nothing was sent. Try again.`;
    if (!(e instanceof ProcessorNotReady || e instanceof ProcessorError)) console.error('[processors] send failed', { name: e instanceof Error ? e.name : 'unknown' });
    await db().from('processor_applications').upsert(
      { processor: PROCESSOR, record_id: recordId, last_error: message.slice(0, 1000), last_error_at: new Date().toISOString() },
      { onConflict: 'processor,record_id' },
    );
    await db().rpc('processor_log', {
      p_record: recordId, p_actor: ctx.userId, p_source: PROCESSOR_LABEL,
      p_summary: `${word} ${PROCESSOR_LABEL} failed`,
      p_update_body: `${word} ${PROCESSOR_LABEL} failed: ${message}`,
    });
    throw new ProcessorServiceError(message);
  }
}

// ── Matching: the unmatched flag ─────────────────────────────────────────────

/** Records that carry Reporting (a module whose tabs include it): the flag applies only there. */
async function reportingModuleIds(config: Config): Promise<string[]> {
  const tab = config.tabs.find((t) => t.showsReporting);
  if (!tab) return [];
  const { data, error } = await db().from('module_tab_order').select('module_id').eq('tab_id', tab.id);
  if (error) throw error;
  return (data ?? []).map((r) => r.module_id as string);
}

/**
 * Spec: a record with no MID, or whose MID the processor doesn't recognise, is
 * flagged. Only once merchants have been read from the processor at least once,
 * and only on records in a module that carries Reporting.
 */
/* The MID is read here with the service role, not taken from the viewer's row:
   a viewer who can't see the MID field would otherwise be told it is missing.
   Only the yes/no flag leaves this function, never the MID. */
async function unmatchedRecords(recordIds: string[]): Promise<Record<string, boolean>> {
  if (!recordIds.length) return {};
  const { data: state, error: stateError } = await db().from('processor_sync_state').select('last_success_at').eq('processor', PROCESSOR).eq('data_type', 'merchants').maybeSingle();
  if (stateError) throw stateError;
  if (!state?.last_success_at) return {};
  const config = await loadConfig();
  const modules = await reportingModuleIds(config);
  if (!modules.length) return {};
  const [{ data: members, error: memberError }, { data: matched, error: matchedError }, { data: mids, error: midError }] = await Promise.all([
    db().from('record_modules').select('record_id').in('module_id', modules).in('record_id', recordIds),
    db().from('processor_merchants').select('record_id').eq('processor', PROCESSOR).in('record_id', recordIds),
    db().from('records').select(`id, mid:values->>${MID_FIELD_KEY}`).in('id', recordIds),
  ]);
  if (memberError) throw memberError;
  if (matchedError) throw matchedError;
  if (midError) throw midError;
  const midById = new Map(((mids ?? []) as unknown as { id: string; mid: string | null }[]).map((r) => [r.id, r.mid]));
  const inScope = new Set((members ?? []).map((m) => m.record_id as string));
  const ok = new Set((matched ?? []).map((m) => m.record_id as string));
  const out: Record<string, boolean> = {};
  for (const id of recordIds) {
    if (!inScope.has(id)) continue;
    const mid = String(midById.get(id) ?? '').trim();
    out[id] = !mid || !ok.has(id);
  }
  return out;
}

/** For the module list's flag icon. Empty unless the viewer may see the flag. */
export async function unmatchedFlags(ctx: AuthContext, recordIds: string[]): Promise<Record<string, boolean>> {
  if (!recordIds.length || !(await processorPerms(ctx)).unmatchedFlag) return {};
  return unmatchedRecords(recordIds);
}

// ── The connection page ──────────────────────────────────────────────────────

export type ConnectionScreen = {
  label: string;
  connected: boolean;
  canManage: boolean;
  canResolve: boolean;
  states: { type: DataType; label: string; lastSuccess: string | null; lastAttempt: string | null; error: string | null }[];
  runs: { id: string; startedAt: string; finishedAt: string | null; outcome: string | null; summary: Record<string, { ok: boolean; added?: number; error?: string }> }[];
  unmatched: { id: string; externalId: string; mid: string | null; name: string | null; firstSeen: string }[];
};

export async function connectionScreen(ctx: AuthContext): Promise<ConnectionScreen> {
  const perms = await processorPerms(ctx);
  if (!perms.connection && !perms.resolveUnmatched) throw new ProcessorAccessError('You don’t have access to the Maverick connection.');
  const [{ data: states, error: e1 }, { data: runs, error: e2 }, { data: unmatched, error: e3 }, connected] = await Promise.all([
    db().from('processor_sync_state').select('data_type, last_success_at, last_attempt_at, last_error').eq('processor', PROCESSOR),
    perms.connection ? db().from('processor_sync_runs').select('id, started_at, finished_at, outcome, summary').eq('processor', PROCESSOR).order('started_at', { ascending: false }).limit(14) : Promise.resolve({ data: [], error: null }),
    perms.resolveUnmatched ? db().from('processor_merchants').select('id, external_id, mid, name, first_seen_at').eq('processor', PROCESSOR).is('record_id', null).order('first_seen_at', { ascending: false }).limit(200) : Promise.resolve({ data: [], error: null }),
    processorConnected(),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  if (e3) throw e3;
  return {
    label: PROCESSOR_LABEL,
    connected,
    canManage: perms.connection,
    canResolve: perms.resolveUnmatched,
    states: DATA_TYPES.map((t) => {
      const s = (states ?? []).find((x) => x.data_type === t);
      return { type: t, label: DATA_TYPE_LABEL[t], lastSuccess: (s?.last_success_at as string | null) ?? null, lastAttempt: (s?.last_attempt_at as string | null) ?? null, error: perms.connection ? ((s?.last_error as string | null) ?? null) : null };
    }),
    runs: (runs ?? []).map((r) => ({ id: r.id as string, startedAt: r.started_at as string, finishedAt: r.finished_at as string | null, outcome: r.outcome as string | null, summary: (r.summary ?? {}) as ConnectionScreen['runs'][number]['summary'] })),
    unmatched: (unmatched ?? []).map((m) => ({ id: m.id as string, externalId: m.external_id as string, mid: m.mid as string | null, name: m.name as string | null, firstSeen: m.first_seen_at as string })),
  };
}

/** Resolve an unmatched merchant: point it at a record. Logged on the record. */
export async function matchMerchant(ctx: AuthContext, merchantId: string, recordId: string | null): Promise<void> {
  need((await processorPerms(ctx)).resolveUnmatched, 'resolve unmatched merchants');
  if (recordId) {
    const { data, error } = await db().from('records').select('id').eq('id', recordId).is('deleted_at', null).maybeSingle();
    if (error) throw error;
    if (!data) throw new ProcessorServiceError('That record no longer exists.');
  }
  const { error } = await db().rpc('processor_match_merchant', { p_merchant: merchantId, p_record: recordId, p_actor: ctx.userId });
  if (error) {
    if (error.code === 'P0002') throw new ProcessorServiceError(error.message);
    throw error;
  }
}

/** Records a resolver may pick from: by MID or name, only among records they could open. */
export async function findRecordsForMatch(ctx: AuthContext, query: string): Promise<{ id: string; name: string; mid: string | null }[]> {
  need((await processorPerms(ctx)).resolveUnmatched, 'resolve unmatched merchants');
  const q = query.trim().slice(0, 80);
  if (q.length < 2) return [];
  const { createSupabaseServerClient } = await import('@/lib/supabase/server');
  // The viewer's own client: RLS returns only records they may see.
  const supabase = await createSupabaseServerClient();
  const safe = q.replace(/[%_,()]/g, ' ');
  // A resolver who may not see the MID field searches by name only, and the MID is never read.
  const midField = (await loadConfig()).fields.find((f) => f.key === MID_FIELD_KEY);
  const seesMid = Boolean(midField) && (await fieldGrant(ctx, midField!)) !== 'hidden';
  // Only the name and the MID are read, never the record's other values.
  const { data, error } = seesMid
    ? await supabase.from('records').select(`id, deal_name, mid:values->>${MID_FIELD_KEY}`).or(`deal_name.ilike.%${safe}%,values->>${MID_FIELD_KEY}.ilike.%${safe}%`).is('deleted_at', null).limit(10)
    : await supabase.from('records').select('id, deal_name').ilike('deal_name', `%${safe}%`).is('deleted_at', null).limit(10);
  if (error) throw error;
  return ((data ?? []) as unknown as { id: string; deal_name: string | null; mid?: string | null }[]).map((r) => ({ id: r.id, name: r.deal_name ?? '', mid: r.mid ?? null }));
}
