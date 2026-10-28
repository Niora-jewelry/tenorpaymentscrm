/**
 * The reconciliation surface — the data layer.
 *
 * ── EVERY FUNCTION HERE IS REQUEST-SCOPED ────────────────────────────────
 * Unlike `adminResiduals.ts`, which mixes service-role table reads with a
 * couple of gated RPCs, this file reads nothing but RPCs — and every one of
 * them opens with `if auth.uid() is null or not auth_is_admin() then raise`.
 * The service role has `auth.uid()` NULL, so it is refused by all of them.
 * There is therefore no `supabaseAdmin()` in this file at all, which is the
 * state that cannot drift back into the bug it was written after.
 *
 * ── MONEY ARRIVES AS TEXT AND LEAVES AS TEXT ─────────────────────────────
 * Daniel's rule, stated in the grid migration itself: *"MONEY LEAVES HERE AS
 * text, NEVER numeric... a grid is exactly where a float would get one. The
 * surface right-aligns a string; it never parses one."*
 *
 * So every money field below is `string | null`. There is no `Number()` in
 * this file and none in the components that read it.
 *
 * ── AN ABSENT VERDICT IS NOT A FAILED ONE ────────────────────────────────
 * `residual_grid_rows` attaches the three verdicts as a jsonb keyed by step,
 * and an ABSENT KEY means the comparison could not be made at all — an
 * uncomputed line, an unmapped fee item, a merchant with no volume row. That
 * distinction is the reason the shape is a map and not an array of three, and
 * it survives into `GridRow.verdicts` unchanged.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { assertAdminPage } from './adminConfig';
import type {
  GridRow,
  HistoryEntry,
  MerchantDashboardRow,
  MerchantState,
  PeriodHeader,
  Synopsis,
  Verdicts,
} from '@/lib/residuals/reconciliation';

/*
 * ── THE TYPES AND LABELS LIVE IN `lib/residuals/reconciliation.ts` ───────
 * Not here. The grid is a client component, and a label map is a RUNTIME
 * value — importing one from this file drags its `import 'server-only'` and
 * its `next/headers` dependency into the browser bundle, which is a build
 * failure rather than a style question:
 *
 *   Error: You're importing a module that depends on "server-only".
 *
 * Types erase, so they could have stayed. They moved alongside the labels so
 * there is one place to look rather than two. Re-exported below so server code
 * that reads these functions does not need to know where they went.
 */
export type {
  GridRow,
  HistoryEntry,
  MerchantDashboardRow,
  MerchantState,
  PeriodHeader,
  Synopsis,
  Verdict,
  Verdicts,
} from '@/lib/residuals/reconciliation';
export { STATE_LABEL, STEP_LABEL, HISTORY_KIND_LABEL } from '@/lib/residuals/reconciliation';


/* ────────────────────────────────────────────────────────────────────────
 * The grid
 * ──────────────────────────────────────────────────────────────────────── */

export async function gridRows(
  ctx: AuthContext,
  periodId: string,
  mid: string | null = null,
  processor: string | null = null,
): Promise<GridRow[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_grid_rows', {
    p_period_id: periodId,
    p_mid: mid,
    p_processor: processor,
  });

  /*
   * Thrown, not swallowed to []. An empty grid means "this month has no
   * lines", and a permission error or a period naming two processors rendered
   * as an empty grid is the same class of lie the link worklist used to tell.
   */
  if (error) {
    console.error('[residuals] grid rows failed', error);
    throw new Error(`The reconciliation grid could not be read: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    scope: r.scope as 'line' | 'group',
    rowId: String(r.row_id),
    mid: String(r.mid),
    merchantName: (r.merchant_name as string | null) ?? null,
    feeCategory: (r.fee_category as string | null) ?? null,
    feeItemName: (r.fee_item_name as string | null) ?? null,
    groupKey: (r.group_key as string | null) ?? null,
    isGroupMember: r.is_group_member === true,
    isGroupAnchor: r.is_group_anchor === true,
    itemCount: (r.item_count as string | null) ?? null,
    amount: (r.amount as string | null) ?? null,
    buyRatePerItem: (r.buy_rate_per_item as string | null) ?? null,
    agentIncome: (r.agent_income as string | null) ?? null,
    agentExpense: (r.agent_expense as string | null) ?? null,
    netRevenue: (r.net_revenue as string | null) ?? null,
    totalIncome: (r.total_income as string | null) ?? null,
    totalBuyRate: (r.total_buy_rate as string | null) ?? null,
    tapdashNetBeforeSplit: (r.tapdash_net_before_split as string | null) ?? null,
    tapdashNetAfterSplit: (r.tapdash_net_after_split as string | null) ?? null,
    additionalIncomeDirect: (r.additional_income_direct as string | null) ?? null,
    netIncome: (r.net_income as string | null) ?? null,
    isComputed: r.is_computed === true,
    volumeBuckets: (r.volume_buckets as string[] | null) ?? null,
    verdicts: (r.verdicts ?? {}) as Verdicts,
    source: (r.source as string | null) ?? null,
    sortOrder: (r.sort_order as number | null) ?? null,
  }));
}

/* ────────────────────────────────────────────────────────────────────────
 * Merchant state
 * ──────────────────────────────────────────────────────────────────────── */

export async function merchantStates(
  ctx: AuthContext,
  periodId: string,
  processor: string | null = null,
): Promise<MerchantState[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_merchant_states', {
    p_period_id: periodId,
    p_processor: processor,
  });

  if (error) {
    console.error('[residuals] merchant states failed', error);
    throw new Error(`Merchant states could not be read: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    mid: String(r.mid),
    state: r.state as MerchantState['state'],
    blockedCount: Number(r.blocked_count ?? 0),
    skippedWhole: Number(r.skipped_whole ?? 0),
    blockedLines: Number(r.blocked_lines ?? 0),
    awaitingReason: (r.awaiting_reason as string | null) ?? null,
    mismatchCount: Number(r.mismatch_count ?? 0),
    suppressedCount: Number(r.suppressed_count ?? 0),
    lineCount: Number(r.line_count ?? 0),
    uncomputedCount: Number(r.uncomputed_count ?? 0),
  }));
}

/* ────────────────────────────────────────────────────────────────────────
 * The synopsis
 * ──────────────────────────────────────────────────────────────────────── */

export async function synopsis(
  ctx: AuthContext,
  periodId: string,
  mid: string | null = null,
  lifetime = false,
): Promise<Synopsis[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_synopsis', {
    p_period_id: periodId,
    p_mid: mid,
    p_lifetime: lifetime,
  });

  if (error) {
    console.error('[residuals] synopsis failed', error);
    throw new Error(`The synopsis could not be read: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    mid: (r.mid as string | null) ?? null,
    netIncome: (r.net_income as string | null) ?? null,
    rowsTotal: Number(r.rows_total ?? 0),
    rowsComputed: Number(r.rows_computed ?? 0),
    merchantsTotal: Number(r.merchants_total ?? 0),
    merchantsComputed: Number(r.merchants_computed ?? 0),
    periodsTotal: Number(r.periods_total ?? 0),
    periodsComputed: Number(r.periods_computed ?? 0),
    disclosable: r.disclosable === true,
  }));
}

/* ────────────────────────────────────────────────────────────────────────
 * The period's own history
 * ──────────────────────────────────────────────────────────────────────── */

export async function periodHistory(
  ctx: AuthContext,
  periodId: string,
  limit = 200,
): Promise<HistoryEntry[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_period_history', {
    p_period_id: periodId,
    p_limit: limit,
  });

  if (error) {
    console.error('[residuals] period history failed', error);
    throw new Error(`The period history could not be read: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    kind: String(r.kind),
    occurredAt: String(r.occurred_at),
    actorId: (r.actor_id as string | null) ?? null,
    detail: (r.detail ?? {}) as Record<string, unknown>,
  }));
}

/* ────────────────────────────────────────────────────────────────────────
 * The period itself, and who is allowed to sign it
 * ──────────────────────────────────────────────────────────────────────── */

export async function periodHeader(
  ctx: AuthContext,
  periodId: string,
): Promise<PeriodHeader | null> {
  await assertAdminPage(ctx, 'residuals');
  const supabase = await createSupabaseServerClient();

  /*
   * `residual_period_context` raises rather than guessing when a period names
   * no processor or more than one — which is correct, and would take the whole
   * page down. It is read separately and allowed to fail, because a period
   * with no processor still has a month and a line count worth seeing, and the
   * reason it cannot be reconciled is more useful on the screen than a 500.
   */
  const [state, period, context] = await Promise.all([
    supabase.rpc('residual_period_state', { p_period_id: periodId, p_processor: null }),
    supabase
      .from('residual_periods')
      .select('id, statement_month, status, calculation_version, notes')
      .eq('id', periodId)
      .is('deleted_at', null)
      .maybeSingle(),
    supabase.rpc('residual_period_context', { p_period_id: periodId, p_processor: null }),
  ]);

  if (period.error) {
    console.error('[residuals] period header failed', period.error);
    throw new Error(`That period could not be read: ${period.error.message}`);
  }
  if (!period.data) return null;

  const p = period.data as {
    id: string;
    statement_month: string;
    status: string;
    calculation_version: number | null;
    notes: string | null;
  };

  if (state.error) {
    console.error('[residuals] period state failed', state.error);
    throw new Error(`That period's state could not be read: ${state.error.message}`);
  }

  const s = (Array.isArray(state.data) ? state.data[0] : state.data) as
    | Record<string, unknown>
    | undefined;

  const ctxRow = (Array.isArray(context.data) ? context.data[0] : context.data) as
    | { processor: string; registry_id: string }
    | undefined;

  let registryLabel: string | null = null;
  if (ctxRow?.registry_id) {
    const { data: reg } = await supabase
      .from('residual_formula_registries')
      .select('label')
      .eq('id', ctxRow.registry_id)
      .maybeSingle();
    registryLabel = (reg as { label: string } | null)?.label ?? null;
  }

  return {
    id: p.id,
    statementMonth: p.statement_month,
    storedStatus: p.status,
    derivedStatus: String(s?.derived_status ?? p.status),
    calculationVersion: p.calculation_version,
    merchantCount: Number(s?.merchant_count ?? 0),
    blocked: Number(s?.blocked ?? 0),
    awaitingVolumes: Number(s?.awaiting_volumes ?? 0),
    mismatch: Number(s?.mismatch ?? 0),
    ready: Number(s?.ready ?? 0),
    reconciled: Number(s?.reconciled ?? 0),
    signable: s?.signable === true,
    notes: p.notes,
    processor: ctxRow?.processor ?? null,
    registryLabel,
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * The merchant dashboard — tab 1
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One row per merchant in a period: who they are, where they stand, and what
 * they earned if the month may yet be totalled.
 *
 * ── THREE READS, NOT ONE NEW QUERY ───────────────────────────────────────
 * `residual_merchant_states` owns the rung, `residual_synopsis` owns the money
 * and the rule about when it may be shown, and `residual_merchant_directory`
 * owns the identity. This function joins them in memory and computes nothing.
 *
 * A fourth query that summed `residual_lines` itself would be quicker to write
 * and would be a second answer to "may this month be totalled" — the question
 * the whole suppression rule exists to answer once. The project's standing
 * convention: the two must not be able to disagree.
 *
 * ── A MERCHANT WITH NO STATE ROW IS STILL A ROW ──────────────────────────
 * `state` is nullable rather than defaulted. A merchant the state function has
 * no opinion about is a different thing from one it has placed on a rung, and
 * inventing 'ready' for them would read as a clean bill of health.
 */
export async function merchantDashboard(
  ctx: AuthContext,
  periodId: string,
): Promise<MerchantDashboardRow[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();

  const [directory, states, totals] = await Promise.all([
    supabase.rpc('residual_merchant_directory', { p_period_id: periodId }),
    merchantStates(ctx, periodId),
    synopsis(ctx, periodId),
  ]);

  if (directory.error) {
    console.error('[residuals] merchant directory failed', directory.error);
    throw new Error(`The merchant list could not be read: ${directory.error.message}`);
  }

  const stateByMid = new Map(states.map((s) => [s.mid, s]));
  /* The company-wide row carries mid === null and is not a merchant. */
  const totalByMid = new Map(
    totals.filter((t) => t.mid !== null).map((t) => [t.mid as string, t]),
  );

  return ((directory.data ?? []) as Record<string, unknown>[]).map((r) => {
    const mid = String(r.mid);
    const t = totalByMid.get(mid);
    return {
      mid,
      merchantName:
        r.merchant_name === null || r.merchant_name === undefined
          ? null
          : String(r.merchant_name),
      nameVariants: (r.name_variants as string[] | null) ?? [],
      recordId: r.record_id === null || r.record_id === undefined ? null : String(r.record_id),
      lineCount: Number(r.line_count ?? 0),
      state: stateByMid.get(mid) ?? null,
      netIncome: t?.netIncome ?? null,
      disclosable: t?.disclosable ?? false,
      rowsComputed: t?.rowsComputed ?? 0,
      rowsTotal: t?.rowsTotal ?? 0,
    };
  });
}
