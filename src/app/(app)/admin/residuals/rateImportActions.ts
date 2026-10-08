'use server';

/**
 * Importing a sheet of merchant rates.
 *
 * ── THE FILE IS SENT TWICE, AS WITH THE FEE REPORT ───────────────────────
 * Preview parses it to show the headers and the dry run; commit parses it
 * again. The rows that get written are therefore derived from the file both
 * times, never from anything a client returned.
 *
 * ── .xlsx ONLY, AND HERE IT MATTERS MOST ─────────────────────────────────
 * The fee-report importer refuses CSV because the buy-rate column exports
 * rounded. This sheet is worse: §8 records a cell holding `0.033816` that
 * displays — and CSV-exports as — `3.38%`, "both a 100x scale error and silent
 * precision loss". The RPC's percent-scale guard would catch most of that, and
 * the point is not to rely on a guard for a thing the file format causes.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import {
  commitRateImport,
  previewRateImport,
  type RateImportOutcome,
} from '@/lib/records/residualRates';
import { parseWorkbook } from '@/lib/residuals/xlsxParser';
import {
  RATE_IMPORT_KEYS,
  RATE_IMPORT_REQUIRED,
  buildRateRows,
  looksLikeRatesSheet,
  suggestRateMapping,
  type RateColumnStates,
  type RateHeaderSuggestion,
  type RateRowError,
} from '@/lib/residuals/rateImport';

const MAX_BYTES = 12 * 1024 * 1024;
/** 34 merchants today. A thousand is not this sheet. */
const MAX_ROWS = 1000;
const MAX_REPORTED_ERRORS = 50;

const MONTH = z
  .string()
  .regex(/^\d{4}-\d{2}-01$/, 'Pick the month these rates take effect from.');

const MAPPING = z.record(z.string().regex(/^\d+$/), z.enum(RATE_IMPORT_KEYS as [string, ...string[]]));

const ACCEPTED = ['.xlsx', '.xlsm', '.xls'] as const;

type FileRead =
  | { ok: true; file: { name: string; bytes: Uint8Array } }
  | { ok: false; message: string };

async function fileFrom(formData: FormData): Promise<FileRead> {
  const raw = formData.get('file');
  if (!(raw instanceof File) || raw.size === 0) {
    return { ok: false, message: 'Choose the rates sheet to upload.' };
  }
  if (raw.size > MAX_BYTES) {
    return { ok: false, message: `That file is ${(raw.size / 1024 / 1024).toFixed(1)} MB — check it is the right one.` };
  }
  const lower = raw.name.toLowerCase();
  if (!ACCEPTED.some((e) => lower.endsWith(e))) {
    return {
      ok: false,
      message: lower.endsWith('.csv')
        ? 'A CSV cannot be imported. CSV stores what the spreadsheet displayed, so a rate held as 0.033816 becomes “3.38%” — a hundredfold error with the precision already gone. Export the sheet as .xlsx.'
        : 'That is not a spreadsheet. Upload the rates sheet as .xlsx.',
    };
  }
  return { ok: true, file: { name: raw.name, bytes: new Uint8Array(await raw.arrayBuffer()) } };
}

/* ────────────────────────────────────────────────────────────────────────
 * Preview
 * ──────────────────────────────────────────────────────────────────────── */

export type RateSheetPreview = {
  name: string;
  headers: string[];
  rowCount: number;
  headerRow: number;
  sample: (string | number | boolean | null)[][];
  /** True when the sheet's name looks like the rates tab. */
  isRatesSheet: boolean;
};

export type RatePreviewState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      filename: string;
      sheets: RateSheetPreview[];
      /** For the chosen sheet. */
      suggestions: RateHeaderSuggestion[];
    };

/** Reads the workbook and says what is in it. Writes nothing, runs nothing. */
export async function previewRateSheetAction(
  _prev: RatePreviewState,
  formData: FormData,
): Promise<RatePreviewState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { status: 'error', message: 'Admin only.' };

  const file = await fileFrom(formData);
  if (!file.ok) return { status: 'error', message: file.message };

  try {
    /*
     * The real rates workbook has a two-row header, so the finder cannot get it
     * right on its own — see `ParseOptions`. The operator picks the row and it
     * is honoured here.
     */
    const wantedSheet = typeof formData.get('sheet') === 'string' ? String(formData.get('sheet')) : null;
    const headerRowRaw = Number(formData.get('headerRow'));
    const headerRows =
      wantedSheet && Number.isInteger(headerRowRaw) && headerRowRaw >= 1
        ? { [wantedSheet]: headerRowRaw }
        : undefined;

    const wb = parseWorkbook(file.file.bytes, { headerRows });
    if (wb.sheets.every((s) => s.headers.length === 0)) {
      return {
        status: 'error',
        message:
          'No header row found in that workbook. The importer looks for a row of column names in the first 20 rows — check the sheet is the rates tab rather than a cover page.',
      };
    }

    const chosen =
      wb.sheets.find((s) => s.name === wantedSheet) ??
      /* Default to the sheet that looks like the rates tab, not the first one —
         the workbook has several and the rates tab is rarely first. */
      wb.sheets.find((s) => looksLikeRatesSheet(s.name) && s.headers.length > 0) ??
      wb.sheets.find((s) => s.headers.length > 0) ??
      wb.sheets[0];

    return {
      status: 'ready',
      filename: file.file.name,
      sheets: wb.sheets.map((s) => ({
        name: s.name,
        headers: s.headers,
        rowCount: s.rows.length,
        headerRow: s.headerRow,
        sample: s.rows.slice(0, 4),
        isRatesSheet: looksLikeRatesSheet(s.name),
      })),
      suggestions: chosen ? suggestRateMapping(chosen) : [],
    };
  } catch (e) {
    console.error('[residuals] rate sheet preview failed', e);
    const message = e instanceof Error ? e.message : 'unreadable';
    return { status: 'error', message: `That file could not be read: ${message}` };
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Dry run and commit
 * ──────────────────────────────────────────────────────────────────────── */

export type RateCommitState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'row_errors'; errors: RateRowError[]; total: number }
  /** The RPC refused. Nothing was written. Message is its bounded rejection. */
  | { status: 'rejected'; message: string; dryRun: boolean }
  | {
      status: 'previewed';
      outcome: Extract<RateImportOutcome, { ok: true }>['result'];
      /**
       * The §6.6 three-state counts, for the panel the operator confirms.
       *
       * Carried on the PREVIEW rather than computed in the client, because the
       * numbers have to describe the same parse the commit will perform. A
       * count derived separately could agree with nothing.
       */
      columnStates: RateColumnStates[];
    }
  | { status: 'done'; outcome: Extract<RateImportOutcome, { ok: true }>['result'] };

type Parsed =
  | {
      ok: true;
      rows: Record<string, string | null>[];
      month: string;
      skippedNoMid: number;
      columnStates: RateColumnStates[];
    }
  | { ok: false; state: RateCommitState };

/** Everything both the dry run and the commit need, derived from the upload. */
async function parseRequest(formData: FormData): Promise<Parsed> {
  const month = MONTH.safeParse(formData.get('month'));
  if (!month.success) return { ok: false, state: { status: 'error', message: month.error.issues[0].message } };

  const sheetName = z.string().min(1).max(200).safeParse(formData.get('sheet'));
  if (!sheetName.success) return { ok: false, state: { status: 'error', message: 'Choose a sheet.' } };

  let mappingRaw: unknown;
  try {
    mappingRaw = JSON.parse(String(formData.get('mapping') ?? '{}'));
  } catch {
    return { ok: false, state: { status: 'error', message: 'The column mapping did not survive the round trip.' } };
  }
  const mapping = MAPPING.safeParse(mappingRaw);
  if (!mapping.success) {
    return { ok: false, state: { status: 'error', message: 'That column mapping is not valid.' } };
  }

  const byIndex = new Map<number, string>();
  for (const [k, v] of Object.entries(mapping.data)) byIndex.set(Number(k), v);

  if (new Set(byIndex.values()).size !== byIndex.size) {
    return {
      ok: false,
      state: { status: 'error', message: 'Two columns are mapped to the same field. Each field takes one column.' },
    };
  }

  const missing = RATE_IMPORT_REQUIRED.filter((t) => ![...byIndex.values()].includes(t));
  if (missing.length > 0) {
    return {
      ok: false,
      state: {
        status: 'error',
        message: `${missing.join(' and ')} must be mapped — without them a row cannot be placed against a merchant or a tier.`,
      },
    };
  }

  const file = await fileFrom(formData);
  if (!file.ok) return { ok: false, state: { status: 'error', message: file.message } };

  const headerRowRaw = Number(formData.get('headerRow'));
  const headerRows =
    Number.isInteger(headerRowRaw) && headerRowRaw >= 1
      ? { [sheetName.data]: headerRowRaw }
      : undefined;

  const sheet = parseWorkbook(file.file.bytes, { headerRows }).sheets.find(
    (s) => s.name === sheetName.data,
  );
  if (!sheet || sheet.headers.length === 0) {
    return { ok: false, state: { status: 'error', message: 'That sheet is no longer in the file. Read it again.' } };
  }

  const built = buildRateRows(sheet, byIndex);

  if (built.errors.length > 0) {
    return {
      ok: false,
      state: {
        status: 'row_errors',
        errors: built.errors.slice(0, MAX_REPORTED_ERRORS),
        total: built.errors.length,
      },
    };
  }
  if (built.rows.length === 0) {
    return { ok: false, state: { status: 'error', message: 'No row in that sheet has a MID in it. Check the MID column is mapped to the right column.' } };
  }
  if (built.rows.length > MAX_ROWS) {
    return {
      ok: false,
      state: { status: 'error', message: `That sheet has ${built.rows.length} merchants, which is more than this is. Check the sheet.` },
    };
  }

  return {
    ok: true,
    rows: built.rows,
    month: month.data,
    skippedNoMid: built.skippedNoMid,
    columnStates: built.columnStates,
  };
}

/**
 * The dry run.
 *
 * Runs the REAL commit in a subtransaction and discards the writes, so what it
 * reports is what will happen — including every refusal, with the RPC's own
 * message and hint.
 */
export async function dryRunRateImportAction(
  _prev: RateCommitState,
  formData: FormData,
): Promise<RateCommitState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { status: 'error', message: 'Admin only.' };

  const parsed = await parseRequest(formData);
  if (!parsed.ok) return parsed.state;

  const r = await previewRateImport(ctx, parsed.month, parsed.rows);
  if (!r.ok) return { status: 'rejected', message: r.message, dryRun: true };
  return { status: 'previewed', outcome: r.result, columnStates: parsed.columnStates };
}

/** The commit. Same inputs, same validation, this time kept. */
export async function commitRateImportAction(
  _prev: RateCommitState,
  formData: FormData,
): Promise<RateCommitState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { status: 'error', message: 'Admin only.' };

  const parsed = await parseRequest(formData);
  if (!parsed.ok) return parsed.state;

  const r = await commitRateImport(ctx, parsed.month, parsed.rows);
  if (!r.ok) return { status: 'rejected', message: r.message, dryRun: false };

  revalidatePath('/admin/residuals');
  return { status: 'done', outcome: r.result };
}
