/**
 * A merchant's rates — reading and superseding them.
 *
 * ── WHY THIS EXISTS WHEN THE PRICING TAB ALREADY SYNCS ───────────────────
 * `residual_sync_rates_from_record` writes rates effective from
 * `residual_rate_effective_month(now())`, which is
 * `date_trunc('month', now())`. That is right for the month in progress and
 * useless for a past one: a statement for May is priced by
 * `residual_merchant_rates_for_month(mid, '2026-05-01')`, and a row starting
 * in October does not cover it.
 *
 * Every real statement is a past month. So the Pricing tab cannot un-block
 * one, and the only path that can is `residual_supersede_merchant_rate`, which
 * takes the effective date explicitly. This module is that path.
 *
 * ── A SUPERSEDE IS NOT AN UPDATE ─────────────────────────────────────────
 * Option A, and the reason is a requirement rather than a preference: a
 * residuals report for a past month, re-run next year, has to read the rates
 * that were in force THEN. So changing a rate closes the current row on the
 * first of the new month — half-open, so it still covers every day up to but
 * not including that date — and opens a successor. Nothing is overwritten and
 * no month's figures move underneath a reader.
 *
 * The one exception is a row that already STARTS in the month being edited:
 * that is the current, still-open assertion, so it is edited in place. Opening
 * a successor from a date a row already starts on would violate the GiST
 * EXCLUDE constraint, and would mean two rows claiming one month.
 *
 * ── REQUEST-SCOPED, LIKE EVERY OTHER RESIDUALS RPC ───────────────────────
 * Both functions are `security definer` gated on `auth_is_admin()`, which
 * resolves `auth.uid()` — NULL under the service-role key. The service role is
 * refused outright.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { RATE_KEYS, type RateEditorData, type StandingRate } from '@/lib/residuals/rates';
import type { RateImportResult } from '@/lib/residuals/rateImport';
import { assertAdminPage } from './adminConfig';

export type { RateEditorData, StandingRate } from '@/lib/residuals/rates';


/**
 * Everything the editor needs for one merchant, optionally in the context of
 * one period.
 *
 * Passing the period is what makes `fieldFailures` and `merchantFailure`
 * meaningful: they are the engine's record of which rate it wanted and could
 * not find, for THAT month. Without a period they come back empty, which would
 * read as "nothing wrong" rather than "not asked".
 */
export async function rateEditor(
  ctx: AuthContext,
  mid: string,
  periodId: string | null = null,
): Promise<RateEditorData> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_merchant_rate_editor', {
    p_mid: mid,
    p_period_id: periodId,
  });

  if (error) {
    console.error('[residuals] rate editor failed', error);
    throw new Error(`That merchant's rates could not be read: ${error.message}`);
  }

  const d = (data ?? {}) as Record<string, unknown>;

  return {
    mid: String(d.mid ?? mid),
    standing: (d.standing as StandingRate | null) ?? null,
    isLocked: d.is_locked === true,
    lineCount: Number(d.line_count ?? 0),
    versionCount: Number(d.version_count ?? 0),
    fieldFailures: (d.field_failures ?? {}) as Record<string, string>,
    merchantFailure: (d.merchant_failure as string | null) ?? null,
    vendorProviders: (d.vendor_providers as string[] | null) ?? [],
    period: (d.period as string | null) ?? null,
  };
}

/** Every dated version of one merchant's rates, newest first. */
export type RateVersion = {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** The row currently in force, with no end date. */
  isStanding: boolean;
  /** A calculated month depends on it, so it cannot be edited in place. */
  isLocked: boolean;
  riskTier: string | null;
  notes: string | null;
  /** Rates as text. Printed, never parsed. */
  rates: Record<string, string | null>;
};

export async function rateVersions(ctx: AuthContext, mid: string): Promise<RateVersion[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_merchant_rate_versions', { p_mid: mid });

  if (error) {
    console.error('[residuals] rate versions failed', error);
    throw new Error(`That merchant's rate history could not be read: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const rates: Record<string, string | null> = {};
    for (const k of RATE_KEYS) {
      const v = r[k];
      rates[k] = v === null || v === undefined ? null : String(v);
    }
    return {
      id: String(r.id),
      effectiveFrom: String(r.effective_from).slice(0, 10),
      effectiveTo: r.effective_to === null ? null : String(r.effective_to).slice(0, 10),
      isStanding: r.is_standing === true,
      isLocked: r.is_locked === true,
      riskTier: (r.risk_tier as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      rates,
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Writing
 * ──────────────────────────────────────────────────────────────────────── */

export type SupersedeResult =
  | { ok: true; effectiveFrom: string; closedPrevious: boolean }
  | { ok: false; message: string };

/**
 * Opens a dated rate row for a merchant, closing its predecessor.
 *
 * ── EVERY VALUE IS SENT AS TEXT OR NULL, NEVER AS A NUMBER ───────────────
 * The RPC casts to `numeric(14,6)`. Handing it a JSON number means handing it
 * a float, and a rate is multiplied by a count — a sixth-decimal error becomes
 * real money on a merchant with 40,000 authorisations. So the caller sends
 * decimal text and PostgreSQL does the cast.
 *
 * ── AN EMPTY FIELD IS NULL, NOT ZERO ─────────────────────────────────────
 * Stated here because it is the one thing a form gets wrong by default: an
 * untouched input is `''`, and `''::numeric` is an error while `0` is a lie.
 * Both are wrong; `null` is the claim "there is no such rate", which is what
 * makes the engine skip and record rather than book the item as free.
 */
export async function supersedeRates(
  ctx: AuthContext,
  mid: string,
  effectiveFrom: string,
  riskTier: string,
  values: Record<string, string | null>,
  notes: string | null,
): Promise<SupersedeResult> {
  await assertAdminPage(ctx, 'residuals');

  /*
   * Only the known keys, and nothing else. The RPC reads what it recognises
   * and would ignore the rest, but forwarding an unrecognised key would mean
   * a typo in the form silently dropping a rate rather than failing.
   */
  const clean: Record<string, string | null> = {};
  for (const k of RATE_KEYS) {
    const v = values[k];
    clean[k] = v === undefined || v === null || v.trim() === '' ? null : v.trim();
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_supersede_merchant_rate', {
    p_mid: mid,
    p_effective_from: effectiveFrom,
    p_risk_tier: riskTier,
    p_values: clean,
    p_notes: notes === null || notes.trim() === '' ? null : notes.trim(),
  });

  if (error) {
    console.error('[residuals] supersede failed', error);
    return { ok: false, message: error.message };
  }

  const r = (data ?? {}) as { effective_from?: string; closed_id?: string | null };
  return {
    ok: true,
    effectiveFrom: String(r.effective_from ?? effectiveFrom).slice(0, 10),
    closedPrevious: r.closed_id !== null && r.closed_id !== undefined,
  };
}

/**
 * Edits a rate row in place.
 *
 * Only legal on a row no calculated month depends on — `residual_update_merchant_rate_row`
 * checks `residual_merchant_rate_is_locked` and refuses otherwise. That refusal
 * is the point: editing a row a stamped month read would restate figures
 * somebody has already seen, with nothing in the history to say so.
 */
export async function updateRateRow(
  ctx: AuthContext,
  rateId: string,
  riskTier: string,
  values: Record<string, string | null>,
): Promise<{ ok: boolean; message: string }> {
  await assertAdminPage(ctx, 'residuals');

  const clean: Record<string, string | null> = {};
  for (const k of RATE_KEYS) {
    const v = values[k];
    clean[k] = v === undefined || v === null || v.trim() === '' ? null : v.trim();
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('residual_update_merchant_rate_row', {
    p_rate_id: rateId,
    p_risk_tier: riskTier,
    p_values: clean,
  });

  if (error) {
    console.error('[residuals] update rate row failed', error);
    return { ok: false, message: error.message };
  }

  return { ok: true, message: 'Saved.' };
}

/**
 * Which merchants in a period have rates and which do not.
 *
 * The worklist behind the "N of M merchants have no rates on file" line: it is
 * one call rather than one per merchant, and it distinguishes "in the
 * statements" from "has rates", which is the pairing that makes a blocked
 * merchant findable.
 */
export type RateCoverageRow = {
  mid: string;
  inStatements: boolean;
  hasRates: boolean;
  riskTier: string | null;
  lineRows: number;
};

export async function rateCoverage(
  ctx: AuthContext,
  periodId: string,
): Promise<RateCoverageRow[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_merchant_rate_coverage', {
    p_period_id: periodId,
  });

  if (error) {
    console.error('[residuals] rate coverage failed', error);
    throw new Error(`Rate coverage could not be read: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    mid: String(r.mid),
    inStatements: r.in_statements === true,
    hasRates: r.has_rates === true,
    riskTier: (r.risk_tier as string | null) ?? null,
    lineRows: Number(r.line_rows ?? 0),
  }));
}

/* ────────────────────────────────────────────────────────────────────────
 * Bulk import
 * ──────────────────────────────────────────────────────────────────────── */

function readImportResult(data: unknown): RateImportResult {
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    effectiveFrom: String(d.effective_from ?? '').slice(0, 10),
    rowsRead: Number(d.rows_read ?? 0),
    inserted: Number(d.inserted ?? 0),
    unchanged: Number(d.unchanged ?? 0),
    closed: Number(d.closed ?? 0),
    lockedVersions: ((d.locked_versions ?? []) as Record<string, unknown>[]).map((v) => ({
      mid: String(v.mid),
      effectiveFrom: String(v.effective_from ?? '').slice(0, 10),
      effectiveTo: v.effective_to === null || v.effective_to === undefined
        ? null
        : String(v.effective_to).slice(0, 10),
    })),
    dryRun: d.dry_run === true,
  };
}

export type RateImportOutcome =
  | { ok: true; result: RateImportResult }
  /** The RPC's bounded rejection. Nothing was written. */
  | { ok: false; message: string };

/**
 * An EXACT dry run of the import.
 *
 * ── WHY THIS IS NOT A SECOND IMPLEMENTATION ──────────────────────────────
 * `residual_preview_merchant_rates_import` calls the real
 * `commit_residual_merchant_rates_import` inside a subtransaction and then
 * raises `ZZ001` to discard its writes, keeping the result because "plpgsql
 * variables are not rolled back with the subtransaction".
 *
 * So the preview cannot disagree with the commit — it IS the commit. Every
 * validation, the percent-scale guard, the duplicate-MID check and the
 * risk-code resolution all fire exactly as they will, and anything that is not
 * the rollback sentinel "is a genuine validation failure and belongs to the
 * caller, with its own errcode, message and hint preserved".
 *
 * It also reports `locked_versions`, computed on COMMITTED state before the
 * dry run, so it says what the operator would be doing rather than what the
 * discarded transaction did.
 */
export async function previewRateImport(
  ctx: AuthContext,
  effectiveFrom: string,
  rows: Record<string, string | null>[],
): Promise<RateImportOutcome> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_preview_merchant_rates_import', {
    p_effective_from: effectiveFrom,
    p_rows: rows,
  });

  if (error) {
    console.error('[residuals] rate import preview failed', error);
    return { ok: false, message: error.message };
  }
  return { ok: true, result: readImportResult(data) };
}

/**
 * Commits the import.
 *
 * `p_import_id` is NULL: `residual_imports` describes a STATEMENT import — it
 * carries a period and a source_type of 'excel' or 'pdf' — and a sheet of
 * merchant rates is neither. The RPC takes the argument because a future
 * provenance record might want one, and passing a fabricated row to satisfy a
 * nullable parameter would put a fictional statement import in the history
 * this screen now lists.
 */
export async function commitRateImport(
  ctx: AuthContext,
  effectiveFrom: string,
  rows: Record<string, string | null>[],
): Promise<RateImportOutcome> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('commit_residual_merchant_rates_import', {
    p_import_id: null,
    p_effective_from: effectiveFrom,
    p_rows: rows,
  });

  if (error) {
    console.error('[residuals] rate import commit failed', error);
    return { ok: false, message: error.message };
  }
  return { ok: true, result: readImportResult(data) };
}
