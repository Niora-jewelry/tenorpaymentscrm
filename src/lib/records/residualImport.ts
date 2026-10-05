/**
 * Importing a processor fee report — the data layer.
 *
 * ── WHICH CLIENT, AND WHY IT MATTERS HERE MOST ───────────────────────────
 * Two clients, split on one rule:
 *
 *   · `supabaseAdmin()` for table reads and for the rows this module is
 *     entitled to write after its own gate — the period, the import record,
 *     the mapping template. The service role bypasses RLS, and the gate that
 *     authorises the write is `assertAdmin` at the top of each function.
 *
 *   · the REQUEST-SCOPED client for `commit_residual_excel_import`, which is
 *     `security definer` and opens with `if auth.uid() is null or not
 *     auth_is_admin() then raise`. Under the service-role key `auth.uid()` is
 *     NULL, so that function refuses the service role outright. It also stamps
 *     `created_by_id = auth.uid()` on every line it inserts, so calling it any
 *     other way would write an import with no author.
 *
 * ── THE FILE IS PARSED TWICE, DELIBERATELY ───────────────────────────────
 * Preview parses to show the operator the headers, the suggested mapping and
 * the row errors. Commit parses again, from the same upload. The alternative —
 * holding the parsed rows between the two round trips — means either a server
 * cache keyed on something, or sending a few hundred rows of merchant money
 * down to the browser and trusting them back up again. Parsing twice costs
 * milliseconds and keeps the committed rows derived from the file rather than
 * from anything a client sent.
 *
 * Nothing is written to Storage. `residual_imports.storage_path` stays NULL:
 * the file is a transient input, and a new bucket of merchant financial data
 * is not something to create as a side effect of an import screen.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { parseWorkbook, type ParsedSheet } from '@/lib/residuals/xlsxParser';
import {
  REQUIRED_TARGETS,
  TARGETS,
  buildRows,
  detectMonths,
  suggestMapping,
  type HeaderSuggestion,
  type RowError,
  type Target,
} from '@/lib/residuals/mapping';

function assertAdmin(ctx: AuthContext): void {
  if (!ctx.isAdmin) throw new Error('Admin only');
}

/** A fee report has a few hundred rows. Ten thousand is not a fee report. */
export const MAX_IMPORT_ROWS = 10_000;
/** Comfortably above any real report; small enough that a wrong file fails fast. */
export const MAX_IMPORT_BYTES = 12 * 1024 * 1024;

/* ────────────────────────────────────────────────────────────────────────
 * The saved mapping template
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Header -> target, for one processor.
 *
 * Keyed on the header VERBATIM, because that is how it is stored and the whole
 * point of storing it that way. See `xlsxParser.ts`.
 */
export async function savedMappings(
  ctx: AuthContext,
  processor: string,
): Promise<Map<string, Target>> {
  assertAdmin(ctx);

  const { data, error } = await supabaseAdmin()
    .from('residual_column_mappings')
    .select('source_column_header, target_column')
    .eq('processor', processor)
    .is('deleted_at', null);

  if (error) throw new Error(`Saved column mappings unavailable: ${error.message}`);

  const out = new Map<string, Target>();
  for (const r of (data ?? []) as { source_column_header: string; target_column: string }[]) {
    if ((TARGETS as readonly string[]).includes(r.target_column)) {
      out.set(r.source_column_header, r.target_column as Target);
    }
  }
  return out;
}

/**
 * Replaces the whole template for a processor with the mapping just confirmed.
 *
 * ── WHY A FULL REPLACE AND NOT AN UPSERT PER ROW ─────────────────────────
 * Two partial unique indexes guard this table: one live mapping per header,
 * one live mapping per target. A per-row upsert against those can deadlock
 * against itself on a swap — moving `net_revenue` from column A to column B
 * needs A retired before B is inserted, or the target index rejects it.
 * Retiring every live row first and then inserting makes the order
 * unambiguous.
 *
 * Retirement is a soft delete, which is why the retired rows do not block the
 * new ones: both indexes are filtered to `deleted_at is null`.
 *
 * It is NOT one transaction. PostgREST gives no transaction across two
 * statements, and the consequence of a failure between them is a processor
 * with no saved template — recoverable by saving again, and visibly so,
 * because the next preview suggests from the alias table instead of from a
 * saved mapping. A template is a convenience; nothing is calculated from it.
 */
export async function replaceMappings(
  ctx: AuthContext,
  processor: string,
  mapping: ReadonlyMap<string, Target>,
): Promise<void> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { error: retireError } = await supabase
    .from('residual_column_mappings')
    .update({ deleted_at: new Date().toISOString(), deleted_by_id: ctx.userId })
    .eq('processor', processor)
    .is('deleted_at', null);

  if (retireError) throw new Error(`Could not retire the old mapping: ${retireError.message}`);

  if (mapping.size === 0) return;

  const rows = [...mapping].map(([header, target]) => ({
    processor,
    source_column_header: header,
    target_column: target,
    created_by_id: ctx.userId,
    updated_by_id: ctx.userId,
  }));

  const { error: insertError } = await supabase.from('residual_column_mappings').insert(rows);
  if (insertError) throw new Error(`Could not save the mapping: ${insertError.message}`);
}

/* ────────────────────────────────────────────────────────────────────────
 * Preview
 * ──────────────────────────────────────────────────────────────────────── */

export type SheetPreview = {
  name: string;
  headers: string[];
  rowCount: number;
  /** 1-based worksheet row of the header, so the UI can say where it looked. */
  headerRow: number;
  /** First few data rows, as text, for the operator to eyeball. */
  sample: (string | number | boolean | null)[][];
  /** Months the sheet's date-ish columns appear to contain. A cross-check. */
  detectedMonths: string[];
};

export type ImportPreview = {
  filename: string;
  sizeBytes: number;
  sheets: SheetPreview[];
  /** Per-column suggestion for the chosen sheet. */
  suggestions: HeaderSuggestion[];
  /** True when a saved template covered at least one column. */
  hasSavedTemplate: boolean;
};

const SAMPLE_ROWS = 5;

/**
 * Reads the file and says what is in it. Writes nothing.
 *
 * A sheet with no locatable header row comes back with zero headers rather
 * than a guess, and the UI names it — see `findHeaderRow` for why guessing is
 * refused.
 */
export async function previewImport(
  ctx: AuthContext,
  processor: string,
  file: { name: string; bytes: Uint8Array },
  sheetName: string | null,
): Promise<ImportPreview> {
  assertAdmin(ctx);

  const wb = parseWorkbook(file.bytes);
  const saved = await savedMappings(ctx, processor);

  const chosen =
    wb.sheets.find((s) => s.name === sheetName) ??
    /* Default to the first sheet that actually has headers, not just the
       first sheet — a workbook often opens on a cover page. */
    wb.sheets.find((s) => s.headers.length > 0) ??
    wb.sheets[0];

  const suggestions = chosen ? suggestMapping(chosen, saved) : [];

  return {
    filename: file.name,
    sizeBytes: file.bytes.byteLength,
    sheets: wb.sheets.map((s) => ({
      name: s.name,
      headers: s.headers,
      rowCount: s.rows.length,
      headerRow: s.headerRow,
      sample: s.rows.slice(0, SAMPLE_ROWS),
      detectedMonths: detectMonths(s),
    })),
    suggestions,
    hasSavedTemplate: suggestions.some((s) => s.saved !== null),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Commit
 * ──────────────────────────────────────────────────────────────────────── */

export type CommitRequest = {
  processor: string;
  /** First of the month, as `YYYY-MM-DD`. The operator's decision. */
  statementMonth: string;
  sheetName: string;
  /** Column index -> target, as confirmed on screen. */
  mapping: ReadonlyMap<number, Target>;
  file: { name: string; bytes: Uint8Array };
  /** Save the confirmed mapping as this processor's template. */
  saveTemplate: boolean;
  /**
   * Retire an existing completed import for this processor and month.
   *
   * Not a default. The unique index on (processor, period_id, source_type)
   * filtered to `status = 'completed'` exists so that a second successful load
   * of the same month cannot happen silently — which makes replacing one a
   * decision the operator states, not something inferred from the fact that
   * they uploaded a file.
   */
  replaceExisting: boolean;
};

export type CommitResult =
  | { ok: true; inserted: number; swept: number; periodId: string; importId: string; skippedNoMid: number }
  | { ok: false; reason: 'row_errors'; errors: RowError[]; totalErrors: number }
  | { ok: false; reason: 'needs_replace'; existing: ExistingImport }
  | { ok: false; reason: 'no_rows' }
  | { ok: false; reason: 'too_many_rows'; rowCount: number }
  | { ok: false; reason: 'missing_targets'; missing: Target[] }
  | { ok: false; reason: 'no_sheet' }
  | { ok: false; reason: 'failed'; message: string };

export type ExistingImport = {
  id: string;
  rowCount: number | null;
  processedAt: string | null;
  originalFilename: string | null;
};

/** How many row errors are shown. All of them are counted. */
const MAX_REPORTED_ERRORS = 50;

/**
 * Parses, maps, and commits — or refuses, and says exactly why.
 *
 * ── THE ORDER OF THE REFUSALS IS THE POINT ───────────────────────────────
 * Everything that can be decided from the file alone is decided before any row
 * is written: the sheet exists, the required targets are mapped, there are
 * rows, every numeric cell is readable, and the month is not already imported.
 * Only then is an import record created.
 *
 * That ordering is what keeps `residual_imports` free of abandoned
 * `processing` rows. A row left in `processing` is not harmless — the commit
 * RPC refuses any import whose status is not `processing`, so a stale one is
 * indistinguishable from a live one to anybody reading the table.
 */
export async function commitImport(ctx: AuthContext, req: CommitRequest): Promise<CommitResult> {
  assertAdmin(ctx);

  // ── the file ──────────────────────────────────────────────────────────
  const wb = parseWorkbook(req.file.bytes);
  const sheet: ParsedSheet | undefined = wb.sheets.find((s) => s.name === req.sheetName);
  if (!sheet || sheet.headers.length === 0) return { ok: false, reason: 'no_sheet' };

  // ── the mapping ───────────────────────────────────────────────────────
  const mapped = new Set(req.mapping.values());
  const missing = REQUIRED_TARGETS.filter((t) => !mapped.has(t));
  if (missing.length > 0) return { ok: false, reason: 'missing_targets', missing };

  const built = buildRows(sheet, req.mapping);

  if (built.errors.length > 0) {
    return {
      ok: false,
      reason: 'row_errors',
      errors: built.errors.slice(0, MAX_REPORTED_ERRORS),
      totalErrors: built.errors.length,
    };
  }
  if (built.rows.length === 0) return { ok: false, reason: 'no_rows' };
  if (built.rows.length > MAX_IMPORT_ROWS) {
    return { ok: false, reason: 'too_many_rows', rowCount: built.rows.length };
  }

  const supabase = supabaseAdmin();

  // ── the period ────────────────────────────────────────────────────────
  const periodId = await ensurePeriod(ctx, req.statementMonth);

  // ── a month already imported ──────────────────────────────────────────
  const existing = await completedImportFor(ctx, req.processor, periodId);
  if (existing && !req.replaceExisting) {
    return { ok: false, reason: 'needs_replace', existing };
  }
  if (existing && req.replaceExisting) {
    /*
     * Soft-deleted, not hard — the import record is the provenance of the
     * lines it wrote, and those lines are soft-deleted too (by the RPC's own
     * supersede sweep, which runs in the same transaction as the insert).
     * Retiring the record here is what frees the partial unique index.
     */
    const { error } = await supabase
      .from('residual_imports')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by_id: ctx.userId,
        updated_by_id: ctx.userId,
      })
      .eq('id', existing.id);
    if (error) return { ok: false, reason: 'failed', message: `Could not retire the previous import: ${error.message}` };
  }

  // ── the import record ─────────────────────────────────────────────────
  const { data: created, error: createError } = await supabase
    .from('residual_imports')
    .insert({
      period_id: periodId,
      processor: req.processor,
      source_type: 'excel',
      status: 'processing',
      original_filename: req.file.name,
      size_bytes: req.file.bytes.byteLength,
      created_by_id: ctx.userId,
      updated_by_id: ctx.userId,
    })
    .select('id')
    .single();

  if (createError || !created) {
    return { ok: false, reason: 'failed', message: createError?.message ?? 'Could not open an import.' };
  }
  const importId = (created as { id: string }).id;

  // ── the one atomic write ──────────────────────────────────────────────
  /*
   * Request-scoped client. The RPC refuses the service role (auth.uid() is
   * NULL there) and stamps created_by_id from auth.uid() on every line.
   */
  const caller = await createSupabaseServerClient();
  const { data, error } = await caller.rpc('commit_residual_excel_import', {
    p_import_id: importId,
    p_period_id: periodId,
    p_rows: built.rows,
  });

  if (error) {
    /*
     * Mark it failed rather than leaving it in `processing`. The RPC only
     * accepts an import that IS in `processing`, so a row abandoned there
     * reads as live work to anyone looking at the table, and a retry of the
     * same month would then see two.
     */
    await supabase
      .from('residual_imports')
      .update({ status: 'failed', error_message: error.message, updated_by_id: ctx.userId })
      .eq('id', importId);
    return { ok: false, reason: 'failed', message: error.message };
  }

  const r = (data ?? {}) as { inserted?: number; swept?: number };
  return {
    ok: true,
    inserted: r.inserted ?? 0,
    swept: r.swept ?? 0,
    periodId,
    importId,
    skippedNoMid: built.skippedNoMid,
  };
}

/**
 * The period for a month, creating it if this is the first file for it.
 *
 * `residual_periods` enforces one LIVE period per month, so this is a
 * find-then-insert rather than an upsert: an upsert on a partial unique index
 * is not expressible through PostgREST, and the race it would protect against
 * is two admins importing the same month in the same second.
 */
async function ensurePeriod(ctx: AuthContext, statementMonth: string): Promise<string> {
  const supabase = supabaseAdmin();

  const { data: found } = await supabase
    .from('residual_periods')
    .select('id')
    .eq('statement_month', statementMonth)
    .is('deleted_at', null)
    .maybeSingle();

  if (found) return (found as { id: string }).id;

  const { data, error } = await supabase
    .from('residual_periods')
    .insert({
      statement_month: statementMonth,
      status: 'open',
      created_by_id: ctx.userId,
      updated_by_id: ctx.userId,
    })
    .select('id')
    .single();

  if (error || !data) {
    /* Lost the race: somebody else created it between the read and the write.
       Reading it again is the correct resolution, not an error. */
    const { data: retry } = await supabase
      .from('residual_periods')
      .select('id')
      .eq('statement_month', statementMonth)
      .is('deleted_at', null)
      .maybeSingle();
    if (retry) return (retry as { id: string }).id;
    throw new Error(`Could not open a period for ${statementMonth}: ${error?.message ?? 'unknown'}`);
  }

  return (data as { id: string }).id;
}

/* ────────────────────────────────────────────────────────────────────────
 * Import history
 * ──────────────────────────────────────────────────────────────────────── */

export type ImportHistoryRow = {
  id: string;
  processor: string | null;
  sourceType: string;
  status: string;
  /** Populated when the status is 'failed'. The reason, verbatim. */
  errorMessage: string | null;
  rowCount: number | null;
  originalFilename: string | null;
  sizeBytes: number | null;
  createdAt: string;
  processedAt: string | null;
  statementMonth: string | null;
};

/**
 * The last N imports, with their error messages.
 *
 * ── WHY THE ERROR MESSAGE IS ON THE SCREEN ───────────────────────────────
 * Straight from the handoff's own description of this page: it "lists the last
 * 20 imports with their `error_message`, so a failed import is visible without
 * a DB query."
 *
 * That is the whole point. A failed import leaves a row in `residual_imports`
 * with `status = 'failed'` and the reason in a column, and without this list
 * the only evidence an operator has is that the month still looks empty —
 * which is indistinguishable from never having tried. The commit action
 * reports its own failure to whoever was watching, and this is for everyone
 * after that.
 *
 * Soft-deleted imports are INCLUDED. A retired import is how a replaced month
 * is recorded, and hiding it would make a re-import look like a first import.
 */
export async function recentImports(
  ctx: AuthContext,
  limit = 20,
): Promise<ImportHistoryRow[]> {
  assertAdmin(ctx);

  const { data, error } = await supabaseAdmin()
    .from('residual_imports')
    .select(
      'id, processor, source_type, status, error_message, row_count,' +
        ' original_filename, size_bytes, created_at, processed_at, deleted_at,' +
        ' residual_periods(statement_month)',
    )
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[residuals] import history failed', error);
    throw new Error(`The import history could not be read: ${error.message}`);
  }

  return ((data ?? []) as unknown as {
    id: string;
    processor: string | null;
    source_type: string;
    status: string;
    error_message: string | null;
    row_count: number | null;
    original_filename: string | null;
    size_bytes: number | null;
    created_at: string;
    processed_at: string | null;
    deleted_at: string | null;
    residual_periods: { statement_month: string } | null;
  }[]).map((r) => ({
    id: r.id,
    processor: r.processor,
    sourceType: r.source_type,
    /* A retired import reads as 'replaced', which is what it is to a reader —
       the status column still says 'completed', and that is true but not the
       useful fact. */
    status: r.deleted_at !== null ? 'replaced' : r.status,
    errorMessage: r.error_message,
    rowCount: r.row_count,
    originalFilename: r.original_filename,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
    processedAt: r.processed_at,
    statementMonth: r.residual_periods?.statement_month ?? null,
  }));
}

/** The completed Excel import for this processor and period, if there is one. */
export async function completedImportFor(
  ctx: AuthContext,
  processor: string,
  periodId: string,
): Promise<ExistingImport | null> {
  assertAdmin(ctx);

  const { data } = await supabaseAdmin()
    .from('residual_imports')
    .select('id, row_count, processed_at, original_filename')
    .eq('processor', processor)
    .eq('period_id', periodId)
    .eq('source_type', 'excel')
    .eq('status', 'completed')
    .is('deleted_at', null)
    .maybeSingle();

  if (!data) return null;
  const r = data as {
    id: string;
    row_count: number | null;
    processed_at: string | null;
    original_filename: string | null;
  };
  return {
    id: r.id,
    rowCount: r.row_count,
    processedAt: r.processed_at,
    originalFilename: r.original_filename,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Computing a period
 * ──────────────────────────────────────────────────────────────────────── */

/** The engine's own summary of a run, as `compute_residual_period` returns it. */
export type ComputeSummary = {
  periodId: string;
  statementMonth: string;
  processor: string;
  /** The version it computed — stamped on the period only when `stamped`. */
  calculationVersion: number;
  /** False means a merchant or a line was skipped; see `failuresByReason`. */
  stamped: boolean;
  registry: string | null;
  merchantsComputed: number;
  merchantsFailed: number;
  linesComputed: number;
  linesFailed: number;
  groupsComputed: number;
  /** reason_code -> count. The list that `stamped: false` refers to. */
  failuresByReason: Record<string, number>;
};

export type ComputeResult =
  | { ok: true; summary: ComputeSummary }
  | { ok: false; message: string };

/**
 * Runs the engine over an imported period.
 *
 * ── A RUN WITH FAILURES IS A SUCCESSFUL RUN ──────────────────────────────
 * `ok: true` with `failures > 0` is the normal, expected outcome of a first
 * import: merchants with no rates on file are RECORDED as skipped rather than
 * costed at zero, and `calculation_version` stays NULL to say so. Reporting
 * that as an error would push an operator to go looking for a broken engine,
 * and reporting it as a clean success would let them trust a month that
 * skipped a merchant. It is neither; it is a run with a list attached.
 */
export async function computePeriod(
  ctx: AuthContext,
  periodId: string,
  processor = 'MAVERICK',
): Promise<ComputeResult> {
  assertAdmin(ctx);

  /* Request-scoped: `compute_residual_period` is admin-gated on auth.uid(). */
  const caller = await createSupabaseServerClient();
  const { data, error } = await caller.rpc('compute_residual_period', {
    p_period_id: periodId,
    p_processor: processor,
  });
  if (error) return { ok: false, message: error.message };

  /*
   * The function's own return value, not a re-read. It records the same object
   * into `residual_calc_runs.summary`, so reporting anything else here would
   * be a second account of one run that could disagree with the stored one.
   */
  const s = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    summary: {
      periodId: String(s.period_id ?? periodId),
      statementMonth: String(s.statement_month ?? ''),
      processor: String(s.processor ?? processor),
      calculationVersion: Number(s.calculation_version ?? 0),
      stamped: s.stamped === true,
      registry: s.registry === null || s.registry === undefined ? null : String(s.registry),
      merchantsComputed: Number(s.merchants_computed ?? 0),
      merchantsFailed: Number(s.merchants_failed ?? 0),
      linesComputed: Number(s.lines_computed ?? 0),
      linesFailed: Number(s.lines_failed ?? 0),
      groupsComputed: Number(s.groups_computed ?? 0),
      failuresByReason: (s.failures_by_reason ?? {}) as Record<string, number>,
    },
  };
}
