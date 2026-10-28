/**
 * Admin → Presets → Statements: the month grid behind the Statements tab.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────
 * Modules Plan, Amendment 4: "The Statements month grid ships prebuilt from
 * July 2024 through December 2032. The Admin Panel provides an Add
 * months/years control … allowing an admin to extend the grid forward by
 * additional full years … Extension is append-only: months can be added, never
 * removed, and the July 2024 start point is fixed."
 *
 * `statement_periods` is ONE global table of (year, month). It is not per
 * record, and `statement_files` points at a period — which is why the client's
 * "creates its twelve month rows across every record simultaneously" needs no
 * fan-out at all: every record's tab reads the same list.
 *
 * ── WHY THERE IS NO REMOVE FUNCTION ──────────────────────────────────────
 * "Months can be added, never removed." A year that has been added may already
 * carry uploaded statements, and removing it would take them with it. The
 * database function has no delete path, so no caller here can grow one.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { assertAdminPage } from './adminConfig';

export type StatementGrid = {
  /** Every year currently in the grid, ascending. */
  years: number[];
  firstYear: number;
  lastYear: number;
  /** How many month rows exist in total — 2024 is a part year (July onward),
   *  so this is not simply `years.length * 12`. */
  months: number;
  /** How many of those months hold at least one live statement file. Shown so
   *  an admin extending the grid can see it is a live structure, not a blank
   *  one. */
  monthsWithFiles: number;
  /** The one year the append-only rule allows next. */
  nextYear: number;
};

export async function statementGrid(ctx: AuthContext): Promise<StatementGrid> {
  await assertAdminPage(ctx, 'presets');
  const supabase = supabaseAdmin();

  // `statement_periods` is at most a few hundred rows and PostgREST caps a
  // row set at 1000, so this is read whole rather than aggregated per year —
  // but the cap is why the count below is a HEAD count and not `data.length`.
  const [periods, used] = await Promise.all([
    supabase.from('statement_periods').select('year, month').order('year').order('month'),
    supabase
      .from('statement_files')
      .select('period_id', { count: 'exact', head: true })
      .is('deleted_at', null),
  ]);
  if (periods.error) throw periods.error;
  if (used.error) throw used.error;

  const rows = periods.data ?? [];
  const years = Array.from(new Set(rows.map((r) => r.year))).sort((a, b) => a - b);
  const lastYear = years.length ? years[years.length - 1]! : new Date().getUTCFullYear();

  return {
    years,
    firstYear: years.length ? years[0]! : lastYear,
    lastYear,
    months: rows.length,
    monthsWithFiles: used.count ?? 0,
    nextYear: lastYear + 1,
  };
}

export type AddYearResult =
  | { ok: true; year: number; added: number }
  | { ok: false; message: string };

/**
 * Adds one full year of month rows.
 *
 * The year is passed rather than inferred so the confirmation an admin read
 * ("Add 2033") is the year the write names. `add_statement_year` re-derives the
 * next allowed year itself and refuses anything else, so a stale screen cannot
 * skip a year — the same "re-check at write time, never trust the number the
 * caller was shown" posture `soft_delete_user` takes.
 */
export async function addStatementYear(ctx: AuthContext, year: number): Promise<AddYearResult> {
  await assertAdminPage(ctx, 'presets');
  if (!Number.isInteger(year)) return { ok: false, message: 'That is not a year.' };

  /*
   * ⚠️ THE REQUEST-SCOPED CLIENT, NOT `supabaseAdmin()`.
   *
   * `add_statement_year` is `security definer` and opens with
   * `auth_is_admin()`, which resolves through `auth.uid()`. The service-role
   * key carries no `sub` claim, so `auth.uid()` is NULL there and the function
   * refuses its own caller with "Admin only" — an admin clicking the button and
   * being told they are not an admin. The same rule `restoreRecord` and
   * `purgeRecord` follow: a function that checks the CALLER has to be called as
   * the caller.
   */
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('add_statement_year', { p_year: year });
  // The messages the function raises are written for a person to read, so they
  // are surfaced as-is rather than re-worded from an error code.
  if (error) return { ok: false, message: error.message };
  return { ok: true, year, added: (data as number) ?? 0 };
}
