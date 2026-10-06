/**
 * Admin → Residuals — the data layer.
 *
 * ── WHY supabaseAdmin() THROUGHOUT ───────────────────────────────────────
 * Every residuals table's RLS admits admins only, and several of the
 * functions are SECURITY DEFINER with their own `auth_is_admin()` check
 * inside. Reading them through the request-scoped client would work for an
 * admin and fail confusingly for anyone else, in a module where "returned
 * nothing" and "you may not see this" must never look the same.
 *
 * So the gate is explicit and in code: every exported function opens with
 * `assertAdmin(ctx)`, exactly as `adminUsers.ts` does. The privilege boundary
 * is enforced here, not delegated to RLS.
 *
 * ── MONEY CROSSES AS TEXT ────────────────────────────────────────────────
 * Daniel's standing rule, and it survives the port:
 *
 *   "Every computed money value is produced by a SQL function and serialised
 *    with an explicit ::text cast... JavaScript has one numeric type and it is
 *    a float. numeric(14,2) survives a round trip as a string and does not
 *    survive one as a number. The client formats; it never computes."
 *
 * Every money field below is therefore `string`, not `number`, and nothing in
 * the UI does arithmetic on one.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

function assertAdmin(ctx: AuthContext): void {
  if (!ctx.isAdmin) throw new Error('Admin only');
}

/**
 * ── WHY SOME CALLS HERE ARE *NOT* supabaseAdmin() ────────────────────────
 * The residuals RPCs are `security definer` and open with
 * `if not auth_is_admin() then raise`. `auth_is_admin()` reads
 * `where p.id = auth.uid()`, and under the service-role key `auth.uid()` is
 * NULL — so every one of those functions refuses the service role outright:
 *
 *   residual_link_worklist -> 42501 Not authorized to read the residual
 *                                   link worklist.
 *
 * Table READS are different: the service role bypasses RLS, so the counts and
 * reference lists above are correct through `supabaseAdmin()`.
 *
 * This caught a live defect. `linkWorklist` logged the 42501 and returned
 * `[]`, which the Unmatched tab renders as "Nothing unmatched" — the exact
 * shape of silent failure this project's conventions are written against: a
 * permission error displayed as a clean bill of health. An RPC that asks
 * `auth.uid()` anything must therefore be called with the REQUEST-SCOPED
 * client, so the signed-in admin is the caller the function sees.
 */
async function asCaller() {
  return createSupabaseServerClient();
}

/* ────────────────────────────────────────────────────────────────────────
 * Periods
 * ──────────────────────────────────────────────────────────────────────── */

export type ResidualPeriod = {
  id: string;
  statementMonth: string;
  /** The column. Only ever 'open' or 'reconciled' — a CHECK enforces it. */
  status: string;
  /**
   * What the period actually is, derived at merchant grain by
   * `residual_period_state`: 'open', 'awaiting_volumes', 'mismatch', 'ready'
   * or 'reconciled'.
   *
   * Since R6a the engine writes NO status, so the stored column cannot say
   * whether a month computed cleanly — a period with four blocked merchants
   * and one with none both read 'open'. The derived value is the one worth
   * showing; the stored one is kept beside it because sign-off reads that.
   *
   * Null when the derivation could not be read, which is not the same as
   * 'open' and is not shown as it.
   */
  derivedStatus: string | null;
  /** True only when every merchant in the period is clean. */
  signable: boolean;
  merchantsBlocked: number;
  /** NULL means "never computed" OR "invalidated since" — deliberately not
   *  distinguished, because they are not usefully different to a reader. */
  calculationVersion: number | null;
  lineCount: number;
  mids: number;
  notes: string | null;
};

export async function listPeriods(ctx: AuthContext): Promise<ResidualPeriod[]> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const { data, error } = await supabase
    .from('residual_periods')
    .select('id, statement_month, status, calculation_version, notes')
    .is('deleted_at', null)
    .order('statement_month', { ascending: false });

  if (error) {
    console.error('[residuals] listing periods failed', error);
    return [];
  }

  const periods = (data ?? []) as {
    id: string;
    statement_month: string;
    status: string;
    calculation_version: number | null;
    notes: string | null;
  }[];
  if (periods.length === 0) return [];

  /*
   * Counted in one round trip rather than per period. There will never be
   * many periods, but the N+1 is free to avoid here and the alternative grows
   * with the client's history rather than staying flat.
   */
  const { data: lines } = await supabase
    .from('residual_lines')
    .select('period_id, mid')
    .is('deleted_at', null)
    .in('period_id', periods.map((p) => p.id));

  const byPeriod = new Map<string, { count: number; mids: Set<string> }>();
  for (const l of (lines ?? []) as { period_id: string; mid: string }[]) {
    const e = byPeriod.get(l.period_id) ?? { count: 0, mids: new Set<string>() };
    e.count += 1;
    e.mids.add(l.mid);
    byPeriod.set(l.period_id, e);
  }

  /*
   * The derived state, one call per period, in parallel.
   *
   * `residual_period_state` is admin-gated on `auth.uid()`, so it goes through
   * the request-scoped client like every other RPC here. It is per-period by
   * signature and there is no set-returning variant, so this is N calls — with
   * one period per month that is twelve a year, and the alternative is a view
   * duplicating the derivation that already exists in SQL.
   *
   * A period whose state cannot be read comes back null rather than 'open'.
   * Those are different claims, and the UI says so.
   */
  const caller = await asCaller();
  const states = await Promise.all(
    periods.map(async (p) => {
      const { data, error } = await caller.rpc('residual_period_state', {
        p_period_id: p.id,
        p_processor: null,
      });
      if (error) {
        console.error('[residuals] period state failed', p.statement_month, error);
        return null;
      }
      const row = (Array.isArray(data) ? data[0] : data) as
        | { derived_status: string; blocked: number; signable: boolean }
        | undefined;
      return row ?? null;
    }),
  );

  return periods.map((p, i) => ({
    id: p.id,
    statementMonth: p.statement_month,
    status: p.status,
    derivedStatus: states[i]?.derived_status ?? null,
    signable: states[i]?.signable === true,
    merchantsBlocked: Number(states[i]?.blocked ?? 0),
    calculationVersion: p.calculation_version,
    lineCount: byPeriod.get(p.id)?.count ?? 0,
    mids: byPeriod.get(p.id)?.mids.size ?? 0,
    notes: p.notes,
  }));
}

/* ────────────────────────────────────────────────────────────────────────
 * Reference data — what the engine will read when a period is computed
 * ──────────────────────────────────────────────────────────────────────── */

export type ReferenceSummary = {
  rules: number;
  terms: number;
  feeItems: number;
  buyRates: number;
  planCodes: number;
  riskTiers: { tierKey: string; label: string; share: string | null }[];
  schedules: { processor: string; label: string; isResidualSplit: boolean }[];
  merchantRates: number;
  ratedMids: number;
  /**
   * ── WHY THE OUTSTANDING ITEMS ARE COUNTED, NOT WRITTEN DOWN ──────────
   * The Calculation tab tells the reader what is still missing before a
   * computed month can be trusted. That list used to be four sentences of
   * prose, which was accurate on the day it was written and became a lie the
   * moment anything was imported — and a screen that says "nothing has been
   * imported" over a month of figures is worse than one that says nothing.
   *
   * So each item is a count taken now. An item with nothing outstanding is
   * not rendered at all, which is the only version of this panel that cannot
   * go stale.
   */
  outstanding: {
    /** Completed Excel fee-report imports. Zero means nothing to calculate. */
    excelImports: number;
    /** Completed PDF statement imports — the first reconciliation check needs one. */
    pdfImports: number;
    /** MIDs seen in statement lines. */
    statementMids: number;
    /** Of those, how many have no rate row at all. */
    midsWithoutRates: number;
    /** MIDs whose rate row leaves `monthly_fee_tapdash` blank — one rule needs it. */
    midsWithoutMonthlyFee: number;
    /** Volume rows on file. The volume-based rules need them. */
    volumeRows: number;
  };
};

export async function referenceSummary(ctx: AuthContext): Promise<ReferenceSummary> {
  assertAdmin(ctx);
  const supabase = supabaseAdmin();

  const count = async (table: string) => {
    const { count: n } = await supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null);
    return n ?? 0;
  };

  const [rules, terms, feeItems, buyRates, planCodes, merchantRates] = await Promise.all([
    count('residual_formula_rules'),
    count('residual_formula_terms'),
    count('residual_fee_items'),
    count('residual_buy_rates'),
    count('residual_plan_code_buckets'),
    count('residual_merchant_rates'),
  ]);

  const { data: tiers } = await supabase
    .from('residual_risk_tiers')
    .select('tier_key, label, is_risk_tier')
    .is('deleted_at', null)
    .eq('is_risk_tier', true)
    .order('sort_order');

  /*
   * The share lives on residual_buy_rate_tiers, per schedule — NOT on
   * residual_risk_tiers, despite what the handoff's section 1 says. Checked
   * against the schema rather than the prose.
   */
  const { data: shares } = await supabase
    .from('residual_buy_rate_tiers')
    .select('risk_tier, tapdash_share, residual_buy_rate_schedules!inner(processor)')
    .is('deleted_at', null);

  const shareByTier = new Map<string, string>();
  for (const s of (shares ?? []) as unknown as {
    risk_tier: string;
    tapdash_share: string;
    residual_buy_rate_schedules: { processor: string };
  }[]) {
    if (s.residual_buy_rate_schedules?.processor === 'MAVERICK') {
      shareByTier.set(s.risk_tier, s.tapdash_share);
    }
  }

  const { data: schedules } = await supabase
    .from('residual_buy_rate_schedules')
    .select('processor, label, is_residual_split')
    .is('deleted_at', null)
    .order('processor');

  const { data: rated } = await supabase
    .from('residual_merchant_rates')
    .select('mid, monthly_fee_tapdash')
    .is('deleted_at', null);

  const rateRows = (rated ?? []) as { mid: string; monthly_fee_tapdash: string | null }[];
  const ratedMidSet = new Set(rateRows.map((r) => r.mid));
  /* A MID counts as having its monthly fee once ANY live rate row carries one,
     because the rows are dated successors of one another and the resolver
     picks the one in force for the month. */
  const midsWithFee = new Set(
    rateRows.filter((r) => r.monthly_fee_tapdash !== null).map((r) => r.mid),
  );

  const { data: statementMids } = await supabase
    .from('residual_lines')
    .select('mid')
    .is('deleted_at', null);
  const statementMidSet = new Set((statementMids ?? []).map((r) => (r as { mid: string }).mid));

  const importCount = async (sourceType: 'excel' | 'pdf') => {
    const { count: n } = await supabase
      .from('residual_imports')
      .select('id', { count: 'exact', head: true })
      .eq('source_type', sourceType)
      .eq('status', 'completed')
      .is('deleted_at', null);
    return n ?? 0;
  };

  const [excelImports, pdfImports, volumeRows] = await Promise.all([
    importCount('excel'),
    importCount('pdf'),
    count('residual_merchant_volumes'),
  ]);

  return {
    rules,
    terms,
    feeItems,
    buyRates,
    planCodes,
    merchantRates,
    ratedMids: ratedMidSet.size,
    outstanding: {
      excelImports,
      pdfImports,
      statementMids: statementMidSet.size,
      midsWithoutRates: [...statementMidSet].filter((m) => !ratedMidSet.has(m)).length,
      midsWithoutMonthlyFee: [...ratedMidSet].filter((m) => !midsWithFee.has(m)).length,
      volumeRows,
    },
    riskTiers: ((tiers ?? []) as { tier_key: string; label: string }[]).map((t) => ({
      tierKey: t.tier_key,
      label: t.label,
      share: shareByTier.get(t.tier_key) ?? null,
    })),
    schedules: ((schedules ?? []) as {
      processor: string;
      label: string;
      is_residual_split: boolean;
    }[]).map((s) => ({
      processor: s.processor,
      label: s.label,
      isResidualSplit: s.is_residual_split,
    })),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * The link worklist
 * ──────────────────────────────────────────────────────────────────────── */

export type LinkCandidate = { recordId: string; mid: string; dealName: string | null };

export type LinkWorklistRow = {
  mid: string;
  lineRows: number;
  volumeRows: number;
  planRows: number;
  matchKind: string;
  candidateCount: number;
  candidates: LinkCandidate[];
};

export async function linkWorklist(
  ctx: AuthContext,
  periodId?: string | null,
): Promise<LinkWorklistRow[]> {
  assertAdmin(ctx);

  /* Request-scoped, not service-role — see the note by `asCaller`. */
  const { data, error } = await (await asCaller()).rpc('residual_link_worklist', {
    p_period_id: periodId ?? null,
  });

  if (error) {
    /*
     * Rethrown, not swallowed. An empty worklist means "every MID resolves",
     * and returning [] on an error says that untruthfully. Better a visible
     * failure on an admin screen than a clean bill of health nobody can
     * distinguish from the real thing.
     */
    console.error('[residuals] link worklist failed', error);
    throw new Error(`Link worklist unavailable: ${error.message}`);
  }

  return ((data ?? []) as {
    mid: string;
    line_rows: number;
    volume_rows: number;
    plan_rows: number;
    match_kind: string;
    candidate_count: number;
    candidates: { record_id: string; mid: string; deal_name: string | null }[];
  }[]).map((r) => ({
    mid: r.mid,
    lineRows: r.line_rows,
    volumeRows: r.volume_rows,
    planRows: r.plan_rows,
    matchKind: r.match_kind,
    candidateCount: r.candidate_count,
    candidates: (r.candidates ?? []).map((c) => ({
      recordId: c.record_id,
      mid: c.mid,
      dealName: c.deal_name,
    })),
  }));
}

/* ────────────────────────────────────────────────────────────────────────
 * Template buy rates — what the processor charges TapDash
 * ──────────────────────────────────────────────────────────────────────── */

export type BuyRateRow = {
  processor: string;
  scheduleLabel: string;
  feeItem: string;
  riskTier: string;
  /** Text, never a number. See the header. */
  rate: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export async function buyRates(ctx: AuthContext, processor = 'MAVERICK'): Promise<BuyRateRow[]> {
  assertAdmin(ctx);

  const { data, error } = await supabaseAdmin()
    .from('residual_buy_rates')
    .select(
      'rate, risk_tier, effective_from, effective_to,' +
        ' residual_fee_items!inner(fee_item_name),' +
        ' residual_buy_rate_schedules!inner(processor, label)',
    )
    .is('deleted_at', null);

  if (error) {
    console.error('[residuals] buy rates failed', error);
    return [];
  }

  return ((data ?? []) as unknown as {
    rate: string | null;
    risk_tier: string;
    effective_from: string;
    effective_to: string | null;
    residual_fee_items: { fee_item_name: string };
    residual_buy_rate_schedules: { processor: string; label: string };
  }[])
    .filter((r) => r.residual_buy_rate_schedules?.processor === processor)
    .map((r) => ({
      processor: r.residual_buy_rate_schedules.processor,
      scheduleLabel: r.residual_buy_rate_schedules.label,
      feeItem: r.residual_fee_items?.fee_item_name ?? '—',
      riskTier: r.risk_tier,
      rate: r.rate,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    }))
    .sort((a, b) => a.feeItem.localeCompare(b.feeItem) || a.riskTier.localeCompare(b.riskTier));
}

/** Which processors have a schedule at all. Only MAVERICK today. */
export async function processors(ctx: AuthContext): Promise<string[]> {
  assertAdmin(ctx);

  /*
   * ── PROCESSORS, NOT VENDORS ─────────────────────────────────────────────
   * `residual_buy_rate_schedules` holds six rows and only ONE of them is a
   * processor:
   *
   *   MAVERICK      Maverick Template Buy Rates        is_residual_split true
   *   ACCEPT_BLUE   Accept.Blue vendor rate card       false
   *   PAYA_ACH_PPD  Paya ACH vendor rate card          false
   *   PAYA_ACH_WEB  Paya ACH vendor rate card          false
   *   RICHARD       Richard vendor rate card           false
   *   TUZO          Tuzo vendor rate card              false
   *
   * Reading the column alone offered all six as processors, so the fee-report
   * importer let an operator file a Maverick statement under ACCEPT_BLUE. That
   * import would commit, and then the engine would find no formula registry
   * for that processor and the month could never compute — a dead end reached
   * by a dropdown that looked like a choice.
   *
   * `is_residual_split` is the distinction and it is DERIVED, not a flag
   * somebody maintains: it asks whether a schedule's tiers are real risk
   * tiers. So a second processor that pays a share of net is classified
   * correctly the day it is seeded, without this list being touched.
   *
   * Request-scoped, because `residual_buy_rate_processors()` is admin-gated on
   * auth.uid() and refuses the service role.
   */
  const { data, error } = await (await asCaller()).rpc('residual_buy_rate_processors');

  if (error) {
    console.error('[residuals] processor list failed', error);
    throw new Error(`The processor list could not be read: ${error.message}`);
  }

  return ((data ?? []) as { processor: string; is_residual_split: boolean }[])
    .filter((r) => r.is_residual_split)
    .map((r) => r.processor)
    .sort();
}
