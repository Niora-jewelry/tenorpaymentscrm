'use server';

/**
 * Uploading processor statements — Step 2.
 *
 * ── THE FILES ARE SENT TWICE, AS WITH THE OTHER TWO IMPORTERS ────────────
 * Preview parses them to show what each one is; commit parses them again. The
 * volume rows that get written are therefore derived from the files both
 * times, never from anything a client returned.
 *
 * ── .pdf ONLY ────────────────────────────────────────────────────────────
 * A statement's figures are read by coordinate, which needs the PDF itself.
 * There is no text or spreadsheet form of this document that keeps the plan
 * table's columns aligned — see `statementParser` for the measurement.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { computePeriod } from '@/lib/records/residualImport';
import {
  commitStatements,
  readStatements,
  type StatementFile,
  type StatementOutcome,
  type StatementRead,
} from '@/lib/records/residualStatements';

/** A statement is a few hundred KB. Ten megabytes is not one. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * A month is forty-seven statements, so the cap is generous — but finite, and
 * the whole batch is read into memory before anything is written.
 */
const MAX_FILES = 80;

const MONTH = z
  .string()
  .regex(/^\d{4}-\d{2}-01$/, 'Pick the statement month these belong to.');

const PROCESSOR = z.string().min(1).max(100);

type FilesRead = { ok: true; files: StatementFile[] } | { ok: false; message: string };

async function filesFrom(formData: FormData): Promise<FilesRead> {
  const raw = formData.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

  if (raw.length === 0) return { ok: false, message: 'Choose one or more statement PDFs.' };
  if (raw.length > MAX_FILES) {
    return { ok: false, message: `That is ${raw.length} files. Upload at most ${MAX_FILES} at a time.` };
  }

  const notPdf = raw.filter((f) => !f.name.toLowerCase().endsWith('.pdf'));
  if (notPdf.length > 0) {
    return {
      ok: false,
      message: `Not a PDF: ${notPdf
        .slice(0, 3)
        .map((f) => f.name)
        .join(', ')}${notPdf.length > 3 ? ` and ${notPdf.length - 3} more` : ''}. Statements are read from the PDF itself.`,
    };
  }

  const tooBig = raw.find((f) => f.size > MAX_BYTES);
  if (tooBig) {
    return {
      ok: false,
      message: `${tooBig.name} is ${(tooBig.size / 1024 / 1024).toFixed(1)} MB — check it is a statement.`,
    };
  }

  const files: StatementFile[] = [];
  for (const f of raw) {
    files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return { ok: true, files };
}

/* ────────────────────────────────────────────────────────────────────────
 * Preview
 * ──────────────────────────────────────────────────────────────────────── */

export type StatementPreviewState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      month: string;
      reads: StatementRead[];
      alreadyImported: string[];
    };

/** Reads every file and says what it is. Writes nothing. */
export async function previewStatementsAction(
  _prev: StatementPreviewState,
  formData: FormData,
): Promise<StatementPreviewState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { status: 'error', message: 'Admin only.' };

  const month = MONTH.safeParse(formData.get('month'));
  if (!month.success) return { status: 'error', message: month.error.issues[0].message };

  const files = await filesFrom(formData);
  if (!files.ok) return { status: 'error', message: files.message };

  try {
    const set = await readStatements(ctx, files.files, month.data);
    return {
      status: 'ready',
      month: month.data,
      reads: set.reads,
      alreadyImported: set.alreadyImported,
    };
  } catch (e) {
    console.error('[residuals] statement preview failed', e);
    return {
      status: 'error',
      message: `Those files could not be read: ${e instanceof Error ? e.message : 'unreadable'}`,
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Commit
 * ──────────────────────────────────────────────────────────────────────── */

export type StatementCommitState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      imported: number;
      skipped: number;
      failed: number;
      outcomes: StatementOutcome[];
      /** The engine's own summary of the run that followed, if it ran. */
      recomputed: { lines: number; merchants: number; failedMerchants: number } | null;
      recomputeMessage: string | null;
    };

export async function commitStatementsAction(
  _prev: StatementCommitState,
  formData: FormData,
): Promise<StatementCommitState> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { status: 'error', message: 'Admin only.' };

  const month = MONTH.safeParse(formData.get('month'));
  if (!month.success) return { status: 'error', message: month.error.issues[0].message };

  const processor = PROCESSOR.safeParse(formData.get('processor'));
  if (!processor.success) return { status: 'error', message: 'Choose a processor.' };

  const files = await filesFrom(formData);
  if (!files.ok) return { status: 'error', message: files.message };

  try {
    const result = await commitStatements(ctx, {
      processor: processor.data,
      statementMonth: month.data,
      files: files.files,
      replaceExisting: formData.get('replace') === 'on',
    });

    /*
     * Recomputed only when something landed. Volumes are an input to the
     * engine, so a statement that does not reach the month changes no figure
     * and a run would only muddy the report.
     */
    let recomputed: { lines: number; merchants: number; failedMerchants: number } | null = null;
    let recomputeMessage: string | null = null;

    if (result.imported > 0) {
      const run = await computePeriod(ctx, result.periodId, processor.data);
      if (run.ok) {
        recomputed = {
          lines: run.summary.linesComputed,
          merchants: run.summary.merchantsComputed,
          failedMerchants: run.summary.merchantsFailed,
        };
      } else {
        recomputeMessage =
          'The statements were imported, but the month could not be recomputed just now. Compute it from the Periods tab.';
      }
    }

    revalidatePath('/admin/residuals');
    return {
      status: 'done',
      imported: result.imported,
      skipped: result.skipped,
      failed: result.failed,
      outcomes: result.outcomes,
      recomputed,
      recomputeMessage,
    };
  } catch (e) {
    console.error('[residuals] statement commit failed', e);
    return {
      status: 'error',
      message: `Nothing was imported: ${e instanceof Error ? e.message : 'unknown error'}`,
    };
  }
}
