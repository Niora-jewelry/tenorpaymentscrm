import 'server-only';

/**
 * Importing processor statements — Step 2 of the operator flow.
 *
 * Volume comes from the statement and from nowhere else, and three of the
 * registry's rules multiply a rate by a volume. A month with a complete fee
 * report and no statements still cannot compute those lines, which is the
 * state the project sat in until the first real statements arrived.
 *
 * ── MANY FILES, ONE SCREEN ───────────────────────────────────────────────
 * A fee report is ONE file covering every merchant. A statement is one file
 * per MERCHANT — August 2026 is forty-seven of them. So this takes a set of
 * files and reports on each, rather than walking an operator through a wizard
 * forty-seven times.
 *
 * Each file becomes its own `residual_imports` row, because each is its own
 * artifact. Migration 20260819009746 is what allows that; before it the second
 * statement of any month raised 23505.
 *
 * ── THE MERCHANT COMES FROM INSIDE THE DOCUMENT ──────────────────────────
 * Never from the filename. A renamed or mis-sent file would otherwise attach
 * one merchant's volumes to another, and every figure downstream would be
 * plausible. `parseStatement` reads the masked "Merchant Number:" field, and
 * `commit_residual_pdf_import` re-normalises it again on its own side.
 *
 * ── A FILE THAT CANNOT BE PROVED IS NOT IMPORTED ─────────────────────────
 * Each statement prints its own `**` totals row. `verifyTotals` requires the
 * plan rows to sum to it exactly, on the money and on the transaction count.
 * A file that fails is reported and skipped, and the others still go in —
 * refusing the whole batch for one bad file would mean a single scanned page
 * blocks a month.
 */
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadPdfText } from '@/lib/residuals/pdfLoader';
import {
  parseStatement,
  verifyTotals,
  type ParsedStatement,
} from '@/lib/residuals/statementParser';
import type { AuthContext } from './permissions';
import { ensurePeriod } from './residualImport';

function assertAdmin(ctx: AuthContext): void {
  if (!ctx.isAdmin) throw new Error('Admin only');
}

export type StatementFile = { name: string; bytes: Uint8Array };

/** What one file turned out to be. Client-safe: no bytes, no parser types. */
export type StatementRead = {
  filename: string;
  /** Read from inside the document, or null if it prints none. */
  mid: string | null;
  /** As printed, e.g. '08-26'. Not reformatted. */
  processingMonth: string | null;
  planRowCount: number;
  /** The statement's own `**` total, as text. */
  statedTotal: string | null;
  statedItemCount: string | null;
  /** True when the plan rows prove out against that total. */
  provable: boolean;
  /** Why not, in the parser's own words. Empty when provable. */
  problems: string[];
};

export type StatementReadSet = {
  reads: StatementRead[];
  /** MIDs that already have a completed statement for this month. */
  alreadyImported: string[];
};

/** Parses and proves every file. Writes nothing, runs nothing. */
export async function readStatements(
  ctx: AuthContext,
  files: StatementFile[],
  statementMonth: string | null,
): Promise<StatementReadSet> {
  assertAdmin(ctx);

  const reads: StatementRead[] = [];

  for (const file of files) {
    let parsed: ParsedStatement;
    try {
      parsed = await parseStatement(file.bytes, loadPdfText);
    } catch (e) {
      reads.push({
        filename: file.name,
        mid: null,
        processingMonth: null,
        planRowCount: 0,
        statedTotal: null,
        statedItemCount: null,
        provable: false,
        problems: [`This file could not be opened: ${e instanceof Error ? e.message : 'unreadable'}.`],
      });
      continue;
    }

    const verdict = verifyTotals(parsed);
    const problems = verdict.ok ? [] : [...verdict.problems];

    if (!parsed.mid) {
      problems.push('No merchant number is printed in this statement, so it cannot be attached to a merchant.');
    }

    /*
     * The month is checked against the month being imported, not assumed from
     * it. A September statement loaded into August would price August's lines
     * against September's volume and every sum would still add up.
     */
    const expected = statementMonth ? printedMonthFor(statementMonth) : null;
    if (expected && parsed.processingMonth && parsed.processingMonth !== expected) {
      problems.push(
        `This statement is for processing month ${parsed.processingMonth}, not ${expected}.`,
      );
    }

    reads.push({
      filename: file.name,
      mid: parsed.mid,
      processingMonth: parsed.processingMonth,
      planRowCount: parsed.planRows.length,
      statedTotal: parsed.printedTotals?.amount ?? null,
      statedItemCount: parsed.printedTotals?.itemCount ?? null,
      provable: problems.length === 0,
      problems,
    });
  }

  return { reads, alreadyImported: await alreadyImportedMids(ctx, statementMonth, reads) };
}

/** '2026-08-01' as the statement prints it: '08-26'. */
function printedMonthFor(statementMonth: string): string | null {
  const m = /^(\d{4})-(\d{2})-01$/.exec(statementMonth);
  return m ? `${m[2]}-${m[1].slice(2)}` : null;
}

async function alreadyImportedMids(
  ctx: AuthContext,
  statementMonth: string | null,
  reads: StatementRead[],
): Promise<string[]> {
  const mids = reads.map((r) => r.mid).filter((m): m is string => m !== null);
  if (!statementMonth || mids.length === 0) return [];

  const supabase = supabaseAdmin();
  const { data: period } = await supabase
    .from('residual_periods')
    .select('id')
    .eq('statement_month', statementMonth)
    .is('deleted_at', null)
    .maybeSingle();
  if (!period) return [];

  const { data } = await supabase
    .from('residual_imports')
    .select('mid')
    .eq('period_id', (period as { id: string }).id)
    .eq('source_type', 'pdf')
    .eq('status', 'completed')
    .is('deleted_at', null)
    .in('mid', mids);

  return ((data ?? []) as { mid: string | null }[])
    .map((r) => r.mid)
    .filter((m): m is string => m !== null);
}

/* ────────────────────────────────────────────────────────────────────────
 * The commit
 * ──────────────────────────────────────────────────────────────────────── */

export type StatementOutcome = {
  filename: string;
  mid: string | null;
  ok: boolean;
  /** True when the plan rows matched the statement's own total. */
  reconciled?: boolean;
  planRowsInserted?: number;
  /** Volume in plan codes no bucket claims. Reported, never dropped silently. */
  unmappedVolume?: string | null;
  unmappedCodes?: string[];
  /** Why this one did not land. */
  message?: string;
};

export type StatementCommitResult = {
  periodId: string;
  imported: number;
  skipped: number;
  failed: number;
  outcomes: StatementOutcome[];
};

export async function commitStatements(
  ctx: AuthContext,
  req: {
    processor: string;
    statementMonth: string;
    files: StatementFile[];
    /** Re-import a merchant that already has a statement for this month. */
    replaceExisting: boolean;
  },
): Promise<StatementCommitResult> {
  assertAdmin(ctx);

  /* Parsed AGAIN from the bytes, never taken from what the preview returned. */
  const { reads } = await readStatements(ctx, req.files, req.statementMonth);
  const periodId = await ensurePeriod(ctx, req.statementMonth);

  const supabase = supabaseAdmin();
  const caller = await createSupabaseServerClient();

  const outcomes: StatementOutcome[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < req.files.length; i += 1) {
    const file = req.files[i];
    const read = reads[i];

    if (!read.provable || !read.mid) {
      skipped += 1;
      outcomes.push({
        filename: file.name,
        mid: read.mid,
        ok: false,
        message: read.problems.join(' '),
      });
      continue;
    }

    /* Re-parsed here because the RPC takes the rows, not the summary. */
    const parsed = await parseStatement(file.bytes, loadPdfText);

    const { data: existing } = await supabase
      .from('residual_imports')
      .select('id')
      .eq('processor', req.processor)
      .eq('period_id', periodId)
      .eq('source_type', 'pdf')
      .eq('mid', read.mid)
      .eq('status', 'completed')
      .is('deleted_at', null)
      .maybeSingle();

    if (existing && !req.replaceExisting) {
      skipped += 1;
      outcomes.push({
        filename: file.name,
        mid: read.mid,
        ok: false,
        message: 'This merchant already has a statement for this month. Tick “replace” to load it again.',
      });
      continue;
    }

    if (existing) {
      /*
       * Soft-deleted, not hard: the import row is the provenance of the volume
       * rows it wrote. Retiring it is what frees
       * residual_imports_statement_unique for the replacement, and the RPC's
       * own sweep soft-deletes the old volumes in the same transaction as the
       * new ones — scoped to this merchant, so the other forty-six are
       * untouched.
       */
      const { error } = await supabase
        .from('residual_imports')
        .update({
          deleted_at: new Date().toISOString(),
          deleted_by_id: ctx.userId,
          updated_by_id: ctx.userId,
        })
        .eq('id', (existing as { id: string }).id);
      if (error) {
        failed += 1;
        outcomes.push({
          filename: file.name,
          mid: read.mid,
          ok: false,
          message: `The previous statement for this merchant could not be retired: ${error.message}`,
        });
        continue;
      }
    }

    const { data: created, error: createError } = await supabase
      .from('residual_imports')
      .insert({
        period_id: periodId,
        processor: req.processor,
        source_type: 'pdf',
        status: 'processing',
        original_filename: file.name,
        size_bytes: file.bytes.byteLength,
        created_by_id: ctx.userId,
        updated_by_id: ctx.userId,
      })
      .select('id')
      .single();

    if (createError || !created) {
      failed += 1;
      outcomes.push({
        filename: file.name,
        mid: read.mid,
        ok: false,
        message: `Could not record the import: ${createError?.message ?? 'unknown'}`,
      });
      continue;
    }

    const importId = (created as { id: string }).id;

    /*
     * Request-scoped, NOT the service role. The RPC gates on
     * `auth_is_admin()`, which reads `auth.uid()` — null for the service role,
     * so a service-role call is refused with 42501 no matter who asked.
     */
    const { data, error } = await caller.rpc('commit_residual_pdf_import', {
      p_import_id: importId,
      p_period_id: periodId,
      p_merchant: {
        mid: read.mid,
        merchant_name: null,
        stated_total: read.statedTotal,
        stated_item_count: read.statedItemCount,
      },
      /*
       * Money as text the whole way; PostgreSQL does the cast.
       *
       * The credits travel with the sales they belong to, per plan code, so
       * the rollup can filter both with the same expression. BIN Sponsorship
       * is assessed net of refunds — measured, see migration 747 — and this is
       * where the figure it needs comes from.
       */
      p_plan_rows: parsed.planRows.map((r) => ({
        plan_code: r.planCode,
        amount: r.amount,
        item_count: r.itemCount,
        credit_amount: r.creditAmount,
        credit_count: r.creditCount,
      })),
    });

    if (error) {
      failed += 1;
      await supabase
        .from('residual_imports')
        .update({ status: 'failed', error_message: error.message, updated_by_id: ctx.userId })
        .eq('id', importId);
      outcomes.push({ filename: file.name, mid: read.mid, ok: false, message: error.message });
      continue;
    }

    const r = (data ?? {}) as {
      reconciled?: boolean;
      plan_rows_inserted?: number;
      unmapped_volume?: string | null;
      unmapped_codes?: string[] | null;
    };

    imported += 1;
    outcomes.push({
      filename: file.name,
      mid: read.mid,
      ok: true,
      reconciled: r.reconciled === true,
      planRowsInserted: r.plan_rows_inserted ?? 0,
      unmappedVolume: r.unmapped_volume ?? null,
      unmappedCodes: r.unmapped_codes ?? [],
    });
  }

  return { periodId, imported, skipped, failed, outcomes };
}
