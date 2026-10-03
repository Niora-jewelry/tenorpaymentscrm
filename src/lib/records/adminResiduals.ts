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
import type { AuthContext } from './permissions';

function assertAdmin(ctx: AuthContext): void {
  if (!ctx.isAdmin) throw new Error('Admin only');
}

/* ────────────────────────────────────────────────────────────────────────
 * Periods
 * ──────────────────────────────────────────────────────────────────────── */

export type ResidualPeriod = {
  id: string;
  statementMonth: string;
  status: string;
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

  return periods.map((p) => ({
    id: p.id,
    statementMonth: p.statement_month,
    status: p.status,
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
    .select('mid')
    .is('deleted_at', null);

  return {
    rules,
    terms,
    feeItems,
    buyRates,
    planCodes,
    merchantRates,
    ratedMids: new Set((rated ?? []).map((r) => (r as { mid: string }).mid)).size,
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

  const { data, error } = await supabaseAdmin().rpc('residual_link_worklist', {
    p_period_id: periodId ?? null,
  });

  if (error) {
    console.error('[residuals] link worklist failed', error);
    return [];
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
  const { data } = await supabaseAdmin()
    .from('residual_buy_rate_schedules')
    .select('processor')
    .is('deleted_at', null);
  return [...new Set((data ?? []).map((r) => (r as { processor: string }).processor))].sort();
}
