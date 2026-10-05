'use server';

/**
 * Server actions for importing a processor fee report.
 *
 * Separate from `actions.ts` because the import is the only flow here that
 * carries an upload, and the two helpers that come with that — reading a
 * `File` off the FormData and enforcing a size ceiling — have nothing to do
 * with the link actions.
 *
 * ── WHY THE FILE IS SENT TWICE ───────────────────────────────────────────
 * Preview and commit each take the upload. The operator picks the file once;
 * the browser holds that `File` and posts it again when they confirm. The
 * alternative is a server-side cache of parsed rows keyed on something, or
 * several hundred rows of merchant money sent down to the client and trusted
 * back up again. Re-reading the file means the rows that get committed are
 * derived from the file, not from anything a client returned.
 *
 * ── THE CLIENT SPLIT, AGAIN ──────────────────────────────────────────────
 * `commit_residual_excel_import` and `compute_residual_period` are both
 * `security definer` and both gated on `auth_is_admin()`, which resolves
 * `auth.uid()` — NULL under the service-role key. They are called with the
 * request-scoped client inside `lib/records/residualImport.ts`; the
 * `ctx.isAdmin` check here is the same question asked in this layer, where it
 * can produce a sentence rather than a 42501.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import {
  MAX_IMPORT_BYTES,
  commitImport,
  computePeriod,
  previewImport,
  replaceMappings,
  type CommitResult,
  type ComputeResult,
  type ImportPreview,
} from '@/lib/records/residualImport';
import { TARGETS, type Target } from '@/lib/residuals/mapping';

const PROCESSOR = z.string().trim().min(1).max(100);
const SHEET = z.string().min(1).max(200);
/** Day 1 of a month: `residual_periods` has a CHECK that enforces it. */
const MONTH = z.string().regex(/^\d{4}-\d{2}-01$/, 'Pick a statement month.');

/** Column index -> target, as the form carries it. */
const MAPPING = z.record(z.string().regex(/^\d+$/), z.enum(TARGETS));

type FileRead =
  | { ok: true; file: { name: string; bytes: Uint8Array } }
  | { ok: false; message: string };

/**
 * Spreadsheet only, and deliberately NOT CSV.
 *
 * The `accept` attribute on the input is a hint a browser may ignore and a
 * direct POST never sees, so the rule is enforced here. The reason is
 * arithmetic rather than tidiness: a CSV export writes the DISPLAYED text, so
 * a merchant-rates cell holding 0.033816 exports as "3.38%" — "both a 100x
 * scale error and silent precision loss" — and the fee report's Buy Rate Per
 * Item column exports its rounded 0.03 rather than the true 0.025. Reading the
 * .xlsx takes the cell value.
 *
 * SheetJS would parse a CSV happily, which is what makes refusing it a
 * decision rather than a limitation.
 */
const ACCEPTED_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'] as const;

async function fileFrom(formData: FormData): Promise<FileRead> {
  const raw = formData.get('file');
  if (!(raw instanceof File) || raw.size === 0) {
    return { ok: false, message: 'Choose a fee report to upload.' };
  }

  const lower = raw.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((e) => lower.endsWith(e))) {
    return {
      ok: false,
      message: lower.endsWith('.csv')
        ? 'A CSV cannot be imported. CSV stores what the spreadsheet displayed, not what the cells held — a rate of 0.033816 becomes "3.38%" and a buy rate of 0.025 becomes 0.03. Export the sheet as .xlsx and upload that.'
        : 'That is not a spreadsheet. Upload the fee report as .xlsx.',
    };
  }
  if (raw.size > MAX_IMPORT_BYTES) {
    const mb = (raw.size / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      message: `That file is ${mb} MB. A fee report is a few hundred kilobytes — check it is the right file.`,
    };
  }
  return { ok: true, file: { name: raw.name, bytes: new Uint8Array(await raw.arrayBuffer()) } };
}

/* ────────────────────────────────────────────────────────────────────────
 * Preview
 * ──────────────────────────────────────────────────────────────────────── */

export type PreviewState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: ImportPreview; processor: string };

/** Reads the upload and reports what is in it. Writes nothing. */
export async function previewImportAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { status: 'error', message: 'Admin only.' };

  const processor = PROCESSOR.safeParse(formData.get('processor'));
  if (!processor.success) return { status: 'error', message: 'Choose a processor.' };

  const file = await fileFrom(formData);
  if (!file.ok) return { status: 'error', message: file.message };

  const sheetName = formData.get('sheet');

  try {
    const preview = await previewImport(
      ctx,
      processor.data,
      file.file,
      typeof sheetName === 'string' && sheetName !== '' ? sheetName : null,
    );

    if (preview.sheets.every((s) => s.headers.length === 0)) {
      return {
        status: 'error',
        message:
          'No header row found in that workbook. The importer looks for a row of column names in the first 20 rows — check the sheet is the fee report itself rather than a cover page.',
      };
    }

    return { status: 'ready', preview, processor: processor.data };
  } catch (e) {
    console.error('[residuals] preview failed', e);
    const message = e instanceof Error ? e.message : 'unreadable';
    return { status: 'error', message: `That file could not be read: ${message}` };
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Commit
 * ──────────────────────────────────────────────────────────────────────── */

export type CommitState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'blocked'; result: Exclude<CommitResult, { ok: true }> }
  | {
      status: 'done';
      inserted: number;
      swept: number;
      skippedNoMid: number;
      periodId: string;
      /** Null only if the engine was never reached. */
      compute: ComputeResult | null;
    };

/**
 * Commits a mapped file, then computes the period it landed in.
 *
 * ── WHY COMPUTE RUNS IN THE SAME ACTION ──────────────────────────────────
 * An imported but uncomputed period holds the processor's figures and none of
 * ours. Every screen in the module then reads "not calculated", and the only
 * way out is a button somebody has to know to press. Running the engine
 * straight after the import makes the normal path one step, and what the
 * operator is shown is the result of the arithmetic rather than the result of
 * an upload.
 *
 * A compute failure does NOT fail the import. The lines are committed and that
 * transaction is closed; saying otherwise would either hide a successful
 * import or claim a calculation that did not happen. Both facts are reported.
 */
export async function commitImportAction(
  _prev: CommitState,
  formData: FormData,
): Promise<CommitState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { status: 'error', message: 'Admin only.' };

  const processor = PROCESSOR.safeParse(formData.get('processor'));
  const sheet = SHEET.safeParse(formData.get('sheet'));
  const month = MONTH.safeParse(formData.get('month'));
  if (!processor.success) return { status: 'error', message: 'Choose a processor.' };
  if (!sheet.success) return { status: 'error', message: 'Choose a sheet.' };
  if (!month.success) return { status: 'error', message: month.error.issues[0].message };

  let mappingRaw: unknown;
  try {
    mappingRaw = JSON.parse(String(formData.get('mapping') ?? '{}'));
  } catch {
    return { status: 'error', message: 'The column mapping did not survive the round trip.' };
  }
  const mapping = MAPPING.safeParse(mappingRaw);
  if (!mapping.success) return { status: 'error', message: 'That column mapping is not valid.' };

  const file = await fileFrom(formData);
  if (!file.ok) return { status: 'error', message: file.message };

  const byIndex = new Map<number, Target>();
  for (const [k, v] of Object.entries(mapping.data)) byIndex.set(Number(k), v);

  /*
   * Two columns cannot feed one field. The partial unique index on
   * (processor, target_column) refuses it, and so does the arithmetic — the
   * second column would overwrite the first with no trace of either.
   */
  if (new Set(byIndex.values()).size !== byIndex.size) {
    return {
      status: 'error',
      message: 'Two columns are mapped to the same field. Each field takes one column.',
    };
  }

  const saveTemplate = formData.get('saveTemplate') === 'on';
  const replaceExisting = formData.get('replaceExisting') === 'on';

  let result: CommitResult;
  try {
    result = await commitImport(ctx, {
      processor: processor.data,
      statementMonth: month.data,
      sheetName: sheet.data,
      mapping: byIndex,
      file: file.file,
      saveTemplate,
      replaceExisting,
    });
  } catch (e) {
    console.error('[residuals] import failed', e);
    return { status: 'error', message: e instanceof Error ? e.message : 'The import failed.' };
  }

  if (!result.ok) return { status: 'blocked', result };

  /*
   * Saved AFTER the commit, never before. A template saved against a file that
   * then failed to import is a mapping nobody ever confirmed in practice, and
   * it would be offered as settled next month.
   */
  if (saveTemplate) {
    try {
      const preview = await previewImport(ctx, processor.data, file.file, sheet.data);
      const headers = preview.sheets.find((s) => s.name === sheet.data)?.headers ?? [];
      const byHeader = new Map<string, Target>();
      for (const [index, target] of byIndex) {
        const header = headers[index];
        if (header !== undefined && header.trim() !== '') byHeader.set(header, target);
      }
      await replaceMappings(ctx, processor.data, byHeader);
    } catch (e) {
      /* The import succeeded; the template is a convenience. Logged rather
         than raised, because failing here would report a good import as bad. */
      console.error('[residuals] saving the mapping template failed', e);
    }
  }

  const compute = await computePeriod(ctx, result.periodId, processor.data);

  revalidatePath('/admin/residuals');
  return {
    status: 'done',
    inserted: result.inserted,
    swept: result.swept,
    skippedNoMid: result.skippedNoMid,
    periodId: result.periodId,
    compute,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Re-running the engine
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Computes a period that is already imported.
 *
 * Needed as its own button because the inputs change without the statement
 * changing: a merchant's rates get entered, a buy-rate schedule is superseded,
 * a MID is linked. The engine is idempotent over a period — it rewrites the
 * six engine-owned columns and re-records the run — so re-running is safe to
 * offer without a confirmation.
 */
export async function computePeriodAction(
  periodId: string,
  processor: string,
): Promise<{ ok: boolean; message: string }> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const id = z.string().uuid().safeParse(periodId);
  const proc = PROCESSOR.safeParse(processor);
  if (!id.success || !proc.success) return { ok: false, message: 'That is not a period.' };

  const r = await computePeriod(ctx, id.data, proc.data);
  revalidatePath('/admin/residuals');

  if (!r.ok) return { ok: false, message: r.message };

  const s = r.summary;
  const lines = `${s.linesComputed} line${s.linesComputed === 1 ? '' : 's'}`;

  if (s.stamped) {
    const merchants = `${s.merchantsComputed} merchant${s.merchantsComputed === 1 ? '' : 's'}`;
    return { ok: true, message: `Computed ${lines} across ${merchants}. Version ${s.calculationVersion}.` };
  }

  /* Not an error. A run that skipped something is a run with a list. */
  const skipped = `${s.merchantsFailed} merchant${s.merchantsFailed === 1 ? '' : 's'}`;
  return {
    ok: true,
    message: `Computed ${lines}, and skipped ${skipped} — so the month is not stamped as complete.`,
  };
}
