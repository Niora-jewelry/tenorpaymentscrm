/**
 * The Residuals workspace: everything the Residuals page shows for one month, read from the
 * database and run through the TypeScript calculator.
 *
 * Inputs, all from the database:
 *   residual_lines                 the Maverick card fee item report rows
 *   residual_plan_volumes          statement Plan Summary rows (volumes)
 *   residual_ach_lines             the Maverick ACH fee item report rows
 *   residual_ach_name_matches      ACH merchant name → MID
 *   residual_acceptblue_lines      the Accept.blue report rows
 *   records.values                 Risk Level, Merchant Pricing (card + ACH), ACH Provider
 *   equipment_rows                 Merchant Equipment Setup
 *   residual_buy_rates (+ tiers)   the Buy Rate Template, MAVERICK and MAVERICK_ACH schedules
 *   residual_partners / residual_mid_partners   partner splits
 *
 * Nothing here is saved: the calculation runs on every load. Saving and locking come later.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from '@/lib/records/permissions';
import { assertAdminPage } from '@/lib/records/adminConfig';
import { tsEngine } from './calc/ts';
import type {
  AcceptBlueMerchantResult, AcceptBlueReportRow, AchMerchant, AchReportRow, AchTemplate, AcquiringMerchant,
  AcquiringReportRow, CardPricing, CardTemplate, EquipmentRow, Flag, FlagColor, RiskLevel, TemplateRow,
} from './calc/types';

/* ── Small helpers ────────────────────────────────────────────────────────── */

type Num = number | string | null | undefined;
const txt = (v: Num) => (v == null || v === '' ? '0' : String(v));
const blank = (v: unknown) => v == null || v === '' || v === 'null';
const val = (v: unknown) => (blank(v) ? null : String(v));
/** CRM percentage fields are stored as percent (0.25 = 0.25%); the engine wants fractions. */
const pct = (v: unknown) => (blank(v) ? null : String(Number(v) / 100));
const digits = (v: unknown) => String(v ?? '').replace(/[^0-9]/g, '');
const RISKS: RiskLevel[] = ['no_risk', 'low_risk', 'moderate_risk', 'high_risk'];
const risk = (v: unknown): RiskLevel | null => (RISKS.includes(v as RiskLevel) ? (v as RiskLevel) : null);
const toNum = (s: string | null | undefined) => (s == null ? null : Number(s));
const sum = (xs: (number | null)[]) => Math.round(xs.reduce<number>((s, x) => s + (x ?? 0), 0) * 100) / 100;

/** Database tier keys → engine risk levels. */
const DB_TIER: Record<string, RiskLevel> = { no_program: 'no_risk', low: 'low_risk', medium: 'moderate_risk', high: 'high_risk' };

const COLOR_RANK: FlagColor[] = ['red', 'orange', 'light_red', 'light_green', 'green'];
const worst = (colors: (FlagColor | null)[]) => COLOR_RANK.find((c) => colors.includes(c)) ?? null;

async function all<T>(query: PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(`Residuals: could not read ${what}: ${error.message}`);
  return data ?? [];
}

/* ── Public shapes (plain JSON, safe to hand to a client component) ──────── */

export type PeriodOption = { id: string; month: string; label: string; status: string };

export type RowView = {
  mid: string;
  feeItem: string;
  category: string;
  count: number | null;
  amount: number | null;
  reported: number;
  merchantPayment: number | null;
  buyRate: number | null;
  result: number | null;
  color: FlagColor | null;
  alerts: { code: string; message: string; color: FlagColor | null }[];
};

export type MidView = {
  mid: string;
  name: string;
  recordId: string | null;
  riskLevel: RiskLevel | null;
  calculated: boolean;
  color: FlagColor | null;
  alertCount: number;
  income: number | null;
  percentage: number | null;
  net: number | null;
  midAlerts: { code: string; message: string; color: FlagColor | null }[];
  rows: RowView[];
};

export type ReconView = {
  source: { file: string | null; rows: number; importedAt: string | null };
  mids: MidView[];
  total: number;
  notes: string[];
};

export type AcceptBlueView = {
  source: { file: string | null; rows: number; importedAt: string | null };
  merchants: (Omit<AcceptBlueMerchantResult, 'flags'> & {
    displayName: string;
    recordId: string | null;
    color: FlagColor | null;
    alerts: { code: string; message: string; color: FlagColor | null; field?: string }[];
  })[];
  missingFromReport: string[];
  expectedTotal: number;
  chargedTotal: number;
};

export type TallyRow = {
  mid: string;
  name: string;
  recordId: string | null;
  color: FlagColor | null;
  acquiring: number | null;
  ach: number | null;
  acceptBlue: number | null;
  aggregate: number;
  partner: { id: string; name: string } | null;
  split: number;
  adjusted: boolean;
  payout: number;
  isoRetained: number;
};

export type TemplateGridRow = { key: string; label: string; kind: 'amount' | 'rate' | 'share'; values: Record<string, number | null> };

export type WorkspaceData = {
  periods: PeriodOption[];
  period: PeriodOption | null;
  acquiring: ReconView | null;
  ach: (ReconView & { nameMatches: { name: string; mid: string | null; matchedBy: string | null; recordName: string | null }[] }) | null;
  acceptBlue: AcceptBlueView | null;
  tally: TallyRow[];
  totals: { acquiring: number; ach: number; acceptBlue: number; aggregate: number; payout: number; isoRetained: number };
  counts: { midsCalculated: number; midsSkipped: number; skippedReasons: Record<string, number> };
  trend: { month: string; label: string; acquiring: number; ach: number; acceptBlue: number }[];
  partners: { id: string; name: string; defaultSplit: number; active: boolean; mids: { mid: string; name: string; split: number; adjusted: boolean; riskLevel: RiskLevel | null }[] }[];
  template: { card: TemplateGridRow[]; ach: TemplateGridRow[]; missing: string[] };
};

/* ── Template from the database ───────────────────────────────────────────── */

const CARD_KEYS: Record<string, keyof CardTemplate> = {
  pci_fee: 'pciFee', vmd_bin: 'vmdBin', vmd_auth_fee: 'vmdAuthFee', avs_fee: 'avsFee', monthly_fee: 'monthlyFee',
  amex_optblue: 'amexOptBlue', monthly_online_access_fee: 'monthlyOnlineAccessFee', batch_fee: 'batchFee',
  website_monitoring_fee: 'websiteMonitoringFee', irs_annual_fee: 'irsAnnualFee', chargeback: 'chargeback',
  ipos_spin_fee_monthly: 'iposSpinFeeMonthly', ipospays_terminal_monthly: 'ipospaysTerminalMonthly',
  accept_blue_monthly: 'acceptBlueMonthly', accept_blue_setup: 'acceptBlueSetup', accept_blue_per_item: 'acceptBluePerItem',
  ebt_auth_fee: 'ebtAuthFee', nuvolinq_10mb_data: 'nuvolinq10mbData', usa_epay_gold: 'usaEpayGold', usa_epay_silver: 'usaEpaySilver',
  valor_portal_access: 'valorPortalAccess', valor_terminal_add_ons: 'valorTerminalAddOns',
};
const ACH_KEYS: Record<string, keyof AchTemplate> = {
  ach_transaction: 'transaction', ach_return: 'achReturn', ach_monthly: 'monthly',
  ach_odfi_sponsorship: 'odfiSponsorship', ach_debit_unauthorized_fee: 'debitUnauthorizedFee', ach_noc: 'noc',
};

type RateRow = { rate: Num; risk_tier: string; fee_item_key: string; schedule_id: string };
type ScheduleRow = { id: string; processor: string; effective_from: string; effective_to: string | null };

async function loadTemplate(month: string) {
  const db = supabaseAdmin();
  const day = `${month}-01`;
  const schedules = (await all<ScheduleRow>(
    db.from('residual_buy_rate_schedules').select('id, processor, effective_from, effective_to')
      .in('processor', ['MAVERICK', 'MAVERICK_ACH']).is('deleted_at', null), 'buy rate schedules',
  )).filter((s) => s.effective_from <= day && (!s.effective_to || s.effective_to > day));
  const ids = schedules.map((s) => s.id);
  const [rates, tiers, items] = await Promise.all([
    all<RateRow>(db.from('residual_buy_rates').select('rate, risk_tier, fee_item_key, schedule_id').in('schedule_id', ids).is('deleted_at', null), 'buy rates'),
    all<{ schedule_id: string; risk_tier: string; tapdash_share: Num }>(
      db.from('residual_buy_rate_tiers').select('schedule_id, risk_tier, tapdash_share').in('schedule_id', ids).is('deleted_at', null), 'buy rate tiers'),
    all<{ fee_item_key: string; label: string; rate_kind: 'amount' | 'rate'; sort_order: number }>(
      db.from('residual_fee_items').select('fee_item_key, label, rate_kind, sort_order').is('deleted_at', null), 'fee items'),
  ]);
  const card = schedules.find((s) => s.processor === 'MAVERICK');
  const ach = schedules.find((s) => s.processor === 'MAVERICK_ACH');
  const missing: string[] = [];

  const cardTemplate = {} as CardTemplate;
  for (const [dbKey, key] of Object.entries(CARD_KEYS)) {
    const row = {} as TemplateRow;
    for (const [dbTier, r] of Object.entries(DB_TIER)) {
      const hit = rates.find((x) => x.schedule_id === card?.id && x.fee_item_key === dbKey && x.risk_tier === dbTier);
      if (!hit) missing.push(`Maverick ${dbKey} / ${dbTier}`);
      row[r] = txt(hit?.rate ?? 0);
    }
    cardTemplate[key] = row;
  }
  const share = {} as TemplateRow;
  for (const [dbTier, r] of Object.entries(DB_TIER)) {
    const hit = tiers.find((t) => t.schedule_id === card?.id && t.risk_tier === dbTier);
    if (!hit) missing.push(`Maverick percentage / ${dbTier}`);
    share[r] = txt(hit?.tapdash_share ?? 0);
  }
  cardTemplate.percentage = share;

  const achTemplate = {} as AchTemplate;
  for (const [dbKey, key] of Object.entries(ACH_KEYS)) {
    const row = {} as AchTemplate[keyof AchTemplate];
    for (const [dbTier, r] of [['low', 'low_risk'], ['medium', 'moderate_risk'], ['high', 'high_risk']] as const) {
      const hit = rates.find((x) => x.schedule_id === ach?.id && x.fee_item_key === dbKey && x.risk_tier === dbTier);
      if (!hit) missing.push(`Maverick ACH ${dbKey} / ${dbTier}`);
      row[r] = txt(hit?.rate ?? 0);
    }
    achTemplate[key] = row;
  }
  const achShare: Record<string, number> = {};
  for (const t of tiers.filter((t) => t.schedule_id === ach?.id)) achShare[DB_TIER[t.risk_tier]] = Number(t.tapdash_share);

  const label = (k: string) => items.find((i) => i.fee_item_key === k);
  const grid = (keys: string[], scheduleId: string | undefined, tierKeys: string[]): TemplateGridRow[] =>
    keys.map((k) => ({
      key: k,
      label: label(k)?.label ?? k,
      kind: label(k)?.rate_kind ?? 'amount',
      values: Object.fromEntries(tierKeys.map((t) => {
        const hit = rates.find((x) => x.schedule_id === scheduleId && x.fee_item_key === k && x.risk_tier === t);
        return [DB_TIER[t], hit ? Number(hit.rate) : null];
      })),
    })).sort((a, b) => (label(a.key)?.sort_order ?? 0) - (label(b.key)?.sort_order ?? 0));

  const cardGrid = [
    ...grid(Object.keys(CARD_KEYS), card?.id, Object.keys(DB_TIER)),
    { key: 'tapdash_share', label: 'Percentage', kind: 'share' as const,
      values: Object.fromEntries(Object.values(DB_TIER).map((r) => [r, Number(share[r])])) },
  ];
  const achGrid = [
    ...grid(Object.keys(ACH_KEYS), ach?.id, ['low', 'medium', 'high']),
    { key: 'ach_tapdash_share', label: 'Percentage', kind: 'share' as const,
      values: { low_risk: achShare.low_risk ?? null, moderate_risk: achShare.moderate_risk ?? null, high_risk: achShare.high_risk ?? null } },
  ];
  return { cardTemplate, achTemplate, cardGrid, achGrid, missing };
}

/* ── The workspace ───────────────────────────────────────────────────────── */

type RecordRow = { id: string; deal_name: string; values: Record<string, unknown> };
type EquipmentDbRow = { record_id: string; billed_by: string | null; billed_to: string | null; monthly_fee: Num; per_item_fee: Num; one_time_fee: Num; equipment_providers: { name: string } | { name: string }[] | null };

const alertsOf = (flags: Flag[]) => flags.map((f) => ({ code: f.code, message: f.message, color: f.color, ...(f.field ? { field: f.field } : {}) }));
const monthLabel = (iso: string) => new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export async function listWorkspacePeriods(ctx: AuthContext): Promise<PeriodOption[]> {
  await assertAdminPage(ctx, 'residuals');
  const rows = await all<{ id: string; statement_month: string; status: string }>(
    supabaseAdmin().from('residual_periods').select('id, statement_month, status').is('deleted_at', null).order('statement_month', { ascending: false }),
    'periods',
  );
  return rows.map((p) => ({ id: p.id, month: p.statement_month.slice(0, 7), label: monthLabel(p.statement_month), status: p.status }));
}

/** One month, calculated. Used for the selected month and for each bar of the trend. */
async function calculateMonth(period: PeriodOption, shared: { records: RecordRow[]; equipment: EquipmentDbRow[] }) {
  const db = supabaseAdmin();
  const { records, equipment } = shared;
  const byMid = new Map<string, RecordRow>();
  for (const r of records) { const m = digits(r.values?.mid); if (m && !byMid.has(m)) byMid.set(m, r); }
  const eqFor = (recordId: string): EquipmentRow[] =>
    equipment.filter((e) => e.record_id === recordId).map((e) => {
      const ep = Array.isArray(e.equipment_providers) ? e.equipment_providers[0] : e.equipment_providers;
      const provider = ep?.name ?? '';
      return {
        provider,
        billedBy: e.billed_by === 'provider' ? provider : e.billed_by === 'tenor' ? 'Tenor' : (e.billed_by ?? ''),
        billedTo: e.billed_to === 'iso' ? 'ISO' : e.billed_to === 'merchant' ? 'Merchant' : (e.billed_to ?? ''),
        monthlyFee: val(e.monthly_fee), perItemFee: val(e.per_item_fee), oneTimeFee: val(e.one_time_fee),
      };
    });

  const [template, lines, plan, achLines, matches, abLines, imports] = await Promise.all([
    loadTemplate(period.month),
    all<{ mid: string; merchant_name: string | null; fee_category: string | null; fee_item_name: string; item_count: Num; amount: Num; net_revenue: Num; agent_expense: Num }>(
      db.from('residual_lines').select('mid, merchant_name, fee_category, fee_item_name, item_count, amount, net_revenue, agent_expense')
        .eq('period_id', period.id).is('deleted_at', null).order('created_at').order('id'), 'fee item report lines'),
    all<{ mid: string; plan_code: string; amount: Num; credit_amount: Num }>(
      db.from('residual_plan_volumes').select('mid, plan_code, amount, credit_amount').eq('period_id', period.id).is('deleted_at', null), 'statement volumes'),
    all<{ merchant_name: string; fee_category: string; item_count: Num; net: Num; source_file: string | null; created_at: string }>(
      db.from('residual_ach_lines').select('merchant_name, fee_category, item_count, net, source_file, created_at')
        .eq('period_id', period.id).is('deleted_at', null).order('created_at').order('id'), 'ACH report lines'),
    all<{ merchant_name: string; mid: string; matched_by: string }>(db.from('residual_ach_name_matches').select('merchant_name, mid, matched_by'), 'ACH name matches'),
    all<{ name: string; mid: string | null; report_month: string | null; setup_fee_iso: Num; monthly_gateway_fee_iso: Num; transaction_fee_iso: Num; transaction_count: Num;
      payment_pages_iso: Num; card_updater_monthly_iso: Num; card_updater_per_update_iso: Num; daf_transaction_fee_iso: Num; iso_total: Num;
      other_columns: Record<string, string> | null; source_file: string | null; created_at: string }>(
      db.from('residual_acceptblue_lines').select('*').eq('period_id', period.id).is('deleted_at', null).order('created_at').order('id'), 'Accept.blue report lines'),
    all<{ original_filename: string | null; source_type: string; row_count: number | null; created_at: string }>(
      db.from('residual_imports').select('original_filename, source_type, row_count, created_at').eq('period_id', period.id).eq('source_type', 'excel').is('deleted_at', null).order('created_at', { ascending: false }), 'imports'),
  ]);

  const nameOf = (mid: string, fallback?: string | null) => byMid.get(mid)?.deal_name ?? fallback ?? mid;

  /* Acquiring */
  let acquiring: ReconView | null = null;
  if (lines.length) {
    const reportRows: AcquiringReportRow[] = lines.map((l) => ({
      mid: l.mid, feeItemName: l.fee_item_name, date: period.month, count: txt(l.item_count), amount: txt(l.amount),
      netRevenue: txt(l.net_revenue), agentExpense: txt(l.agent_expense), agentPct: '',
    }));
    const mids = [...new Set(lines.map((l) => l.mid))];
    const merchants: AcquiringMerchant[] = mids.flatMap((mid) => {
      const r = byMid.get(mid);
      if (!r) return [];
      const v = r.values;
      const p = plan.filter((x) => x.mid === mid);
      const pricing: CardPricing = {
        amexAuthFee: val(v.td_amex_auth_fee), vmdAuthFee: val(v.td_vmd_auth_fee), pinDebitAuthFee: val(v.td_pin_debit_auth_fee),
        amexVolume: pct(v.td_amex_volume), vmdVolume: pct(v.td_vmd_volume), pinDebitVolume: pct(v.td_pin_debit_volume),
        chargebackFee: val(v.td_chargeback_fee), vmdTransactionFee: val(v.td_vmd_transaction_fee), avsFee: val(v.td_avs_fee),
        batchFee: val(v.td_batch_fee), monthlyFee: val(v.td_monthly_fee), ebtVolume: pct(v.td_ebt_volume),
        amexOptBlueFee: pct(v.td_amex_template_volume_fee), monthlyWebsiteMonitoringFee: val(v.ovmp_monthly_website_monitoring_fee),
        pciFee: val(v.td_pci_fee), ebtAuthFee: val(v.td_ebt_auth_fee),
        amexVolumeBuyRateAdjustment: pct(v.td_amex_volume_buy_rate_adj), vmdVolumeBuyRateAdjustment: pct(v.td_vmd_volume_buy_rate_adj),
        pinDebitVolumeBuyRateAdjustment: pct(v.td_pin_debit_volume_buy_rate_adj),
      };
      return [{
        mid, riskLevel: risk(v.pricing_risk_level), pricing,
        statement: p.length ? p.map((x) => ({ planCode: x.plan_code, amount: txt(x.amount), creditAmount: txt(x.credit_amount) })) : null,
        equipment: eqFor(r.id),
      }];
    });
    const out = await tsEngine.acquiring({ month: period.month, template: template.cardTemplate, reportRows, merchants, proceedWithoutStatement: true });
    const rows: RowView[] = out.rows.map((r, i) => ({
      mid: r.mid, feeItem: r.feeItemName, category: lines[i]?.fee_category ?? '', count: toNum(txt(lines[i]?.item_count)),
      amount: toNum(txt(lines[i]?.amount)), reported: Number(r.netRevenue), merchantPayment: toNum(r.merchantPayment),
      buyRate: toNum(r.buyRate), result: toNum(r.income), color: r.color, alerts: alertsOf(r.flags),
    }));
    acquiring = {
      source: { file: imports[0]?.original_filename ?? null, rows: lines.length, importedAt: imports[0]?.created_at ?? null },
      mids: out.mids.map((m) => {
        const midRows = rows.filter((r) => r.mid === m.mid);
        return {
          mid: m.mid, name: nameOf(m.mid, lines.find((l) => l.mid === m.mid)?.merchant_name), recordId: byMid.get(m.mid)?.id ?? null,
          riskLevel: m.riskLevel, calculated: m.calculated, color: worst(midRows.map((r) => r.color)),
          alertCount: midRows.reduce((s, r) => s + r.alerts.length, 0) + m.flags.filter((f) => f.color).length,
          income: toNum(m.income), percentage: toNum(m.percentage), net: toNum(m.netIncome), midAlerts: alertsOf(m.flags), rows: midRows,
        };
      }),
      total: Number(out.total),
      notes: [`Statements on file for ${out.mids.filter((m) => m.volumes && !m.flags.some((f) => f.code === 'NO_STATEMENT')).length} of ${out.mids.length} MIDs`],
    };
  }

  /* ACH */
  let ach: WorkspaceData['ach'] = null;
  if (achLines.length) {
    const reportRows: AchReportRow[] = achLines.map((l) => ({
      merchantName: l.merchant_name, date: period.month, feeCategory: l.fee_category, count: txt(l.item_count), net: txt(l.net),
    }));
    const names = [...new Set(achLines.map((l) => l.merchant_name))];
    const nameMatches = Object.fromEntries(matches.filter((m) => names.includes(m.merchant_name)).map((m) => [m.merchant_name, m.mid]));
    const merchants: AchMerchant[] = [...new Set(Object.values(nameMatches))].flatMap((mid) => {
      const r = byMid.get(mid);
      if (!r) return [];
      const v = r.values;
      return [{
        mid, riskLevel: risk(v.pricing_risk_level), achProvider: val(v.ach_provider),
        achTransactionFee: val(v.td_ach_transaction_fee), achReturn: val(v.td_ach_return), achMonthlyGatewayFee: val(v.td_ach_monthly_gateway_fee),
        achExceptionCorrectionsFee: val(v.td_ach_exception_fee), achBin: pct(v.td_ach_bin),
      }];
    });
    const out = await tsEngine.ach({ month: period.month, template: template.achTemplate, reportRows, nameMatches, merchants });
    const rows: (RowView & { name: string })[] = out.rows.map((r) => ({
      name: r.merchantName, mid: r.mid ?? `name:${r.merchantName}`, feeItem: r.feeCategory, category: 'ACH',
      count: toNum(reportRows.find((x) => x.merchantName === r.merchantName && x.feeCategory === r.feeCategory)?.count ?? null),
      amount: null, reported: Number(r.reportNet), merchantPayment: toNum(r.merchantPayment), buyRate: toNum(r.buyRate),
      result: toNum(r.net), color: r.color, alerts: alertsOf(r.flags),
    }));
    const groups = [...new Set(rows.map((r) => r.mid))];
    ach = {
      source: { file: achLines[0]?.source_file ?? null, rows: achLines.length, importedAt: achLines[0]?.created_at ?? null },
      mids: groups.map((key) => {
        const midRows = rows.filter((r) => r.mid === key);
        const m = out.mids.find((x) => x.mid === key);
        const matched = !key.startsWith('name:');
        return {
          mid: matched ? key : '', name: matched ? nameOf(key, midRows[0].name) : midRows[0].name, recordId: matched ? byMid.get(key)?.id ?? null : null,
          riskLevel: matched ? risk(byMid.get(key)?.values.pricing_risk_level) : null, calculated: m?.calculated ?? false,
          color: worst(midRows.map((r) => r.color)), alertCount: midRows.reduce((s, r) => s + r.alerts.length, 0),
          income: toNum(m?.net), percentage: toNum(m?.percentage), net: toNum(m?.total), midAlerts: alertsOf(m?.flags ?? []), rows: midRows,
        };
      }),
      total: Number(out.total),
      notes: out.unmatchedNames.length ? [`${out.unmatchedNames.length} report names have no MID yet`] : [],
      nameMatches: names.map((n) => {
        const m = matches.find((x) => x.merchant_name === n);
        return { name: n, mid: m?.mid ?? null, matchedBy: m?.matched_by ?? null, recordName: m ? byMid.get(m.mid)?.deal_name ?? null : null };
      }),
    };
  }

  /* Accept.blue */
  let acceptBlue: AcceptBlueView | null = null;
  if (abLines.length) {
    const reportRows: AcceptBlueReportRow[] = abLines.map((r) => ({
      name: r.name, mid: r.mid, setupFeeIso: r.setup_fee_iso == null ? null : txt(r.setup_fee_iso),
      monthlyGatewayFeeIso: txt(r.monthly_gateway_fee_iso), transactionFeeIso: txt(r.transaction_fee_iso), transactionCount: txt(r.transaction_count),
      paymentPagesIso: txt(r.payment_pages_iso), cardUpdaterMonthlyIso: txt(r.card_updater_monthly_iso), cardUpdaterPerUpdateIso: txt(r.card_updater_per_update_iso),
      dafTransactionFeeIso: txt(r.daf_transaction_fee_iso), isoTotal: txt(r.iso_total), otherColumns: r.other_columns ?? {},
    }));
    const reportMonth = abLines[0].report_month;
    const out = await tsEngine.acceptBlue({
      month: period.month, reportMonth: reportMonth && /^\d+$/.test(reportMonth) ? Number(reportMonth) : (reportMonth ?? period.month), reportRows,
      merchants: records.map((r) => ({ mid: digits(r.values?.mid), equipment: eqFor(r.id) })).filter((m) => m.mid && m.equipment.length),
    });
    acceptBlue = {
      source: { file: abLines[0]?.source_file ?? null, rows: abLines.length, importedAt: abLines[0]?.created_at ?? null },
      merchants: out.merchants.map(({ flags, ...m }) => ({
        ...m, displayName: m.mid ? nameOf(m.mid, m.name) : m.name, recordId: m.mid ? byMid.get(m.mid)?.id ?? null : null,
        color: worst(flags.map((f) => f.color)), alerts: alertsOf(flags),
      })),
      missingFromReport: out.missingFromReport,
      expectedTotal: Number(out.expectedTotal),
      chargedTotal: Number(out.chargedTotal),
    };
  }

  return { acquiring, ach, acceptBlue, template };
}

export async function loadWorkspace(ctx: AuthContext, month: string | null): Promise<WorkspaceData> {
  await assertAdminPage(ctx, 'residuals');
  const db = supabaseAdmin();
  const periods = await listWorkspacePeriods(ctx);
  const period = periods.find((p) => p.month === month) ?? periods[0] ?? null;

  const [records, equipment, partnersDb, midPartners] = await Promise.all([
    all<RecordRow>(db.from('records').select('id, deal_name, values').is('deleted_at', null).not('values->>mid', 'is', null), 'merchant records'),
    all<EquipmentDbRow>(db.from('equipment_rows').select('record_id, billed_by, billed_to, monthly_fee, per_item_fee, one_time_fee, equipment_providers(name)').is('deleted_at', null), 'equipment'),
    all<{ id: string; name: string; default_split: Num; is_active: boolean }>(
      db.from('residual_partners').select('id, name, default_split, is_active').is('deleted_at', null).order('name'), 'partners'),
    all<{ mid: string; partner_id: string; split: Num; effective_from: string; effective_to: string | null }>(
      db.from('residual_mid_partners').select('mid, partner_id, split, effective_from, effective_to').is('deleted_at', null), 'partner assignments'),
  ]);
  const byMid = new Map<string, RecordRow>();
  for (const r of records) { const m = digits(r.values?.mid); if (m && !byMid.has(m)) byMid.set(m, r); }
  const shared = { records, equipment };

  const empty: WorkspaceData = {
    periods, period, acquiring: null, ach: null, acceptBlue: null, tally: [],
    totals: { acquiring: 0, ach: 0, acceptBlue: 0, aggregate: 0, payout: 0, isoRetained: 0 },
    counts: { midsCalculated: 0, midsSkipped: 0, skippedReasons: {} }, trend: [], partners: [],
    template: { card: [], ach: [], missing: [] },
  };
  if (!period) return empty;

  const current = await calculateMonth(period, shared);
  const { acquiring, ach, acceptBlue, template } = current;

  /* Final Tally: one row per MID across the three sources. */
  const day = `${period.month}-01`;
  const assignment = (mid: string) =>
    midPartners.find((a) => a.mid === mid && a.effective_from <= day && (!a.effective_to || a.effective_to > day)) ?? null;
  const tallyMids = new Set<string>([
    ...(acquiring?.mids.map((m) => m.mid) ?? []),
    ...(ach?.mids.filter((m) => m.mid).map((m) => m.mid) ?? []),
    ...(acceptBlue?.merchants.filter((m) => m.mid).map((m) => m.mid as string) ?? []),
  ]);
  const tally: TallyRow[] = [...tallyMids].map((mid) => {
    const a = acquiring?.mids.find((m) => m.mid === mid);
    const h = ach?.mids.find((m) => m.mid === mid);
    const b = acceptBlue?.merchants.find((m) => m.mid === mid);
    const acq = a?.calculated ? a.net : null;
    const achNet = h?.calculated ? h.net : null;
    // ASSUMPTION: Accept.blue's ISO Total is what Accept.blue charged TapDash, so it is a deduction.
    const abCharged = b ? Number(b.isoTotal) : null;
    const aggregate = sum([acq, achNet, abCharged == null ? null : -abCharged]);
    const asg = assignment(mid);
    const partner = asg ? partnersDb.find((p) => p.id === asg.partner_id) ?? null : null;
    const split = asg ? Number(asg.split) : 0;
    const payout = aggregate > 0 ? Math.round(aggregate * split * 100) / 100 : 0;
    return {
      mid, name: byMid.get(mid)?.deal_name ?? a?.name ?? b?.name ?? mid, recordId: byMid.get(mid)?.id ?? null,
      color: worst([a?.color ?? null, h?.color ?? null, b?.color ?? null]),
      acquiring: acq, ach: achNet, acceptBlue: abCharged, aggregate,
      partner: partner ? { id: partner.id, name: partner.name } : null, split,
      adjusted: !!(asg && partner && Number(asg.split) !== Number(partner.default_split)),
      payout, isoRetained: Math.round((aggregate - payout) * 100) / 100,
    };
  }).sort((x, y) => y.aggregate - x.aggregate);

  const skippedReasons: Record<string, number> = {};
  for (const m of acquiring?.mids ?? []) {
    if (m.calculated) continue;
    const code = m.midAlerts.find((f) => f.color === 'red' || f.color === 'orange')?.code ?? 'OTHER';
    skippedReasons[code] = (skippedReasons[code] ?? 0) + 1;
  }

  /* Trend: the last six periods, each calculated the same way. */
  const trendPeriods = periods.slice(0, 6).reverse();
  const trend = await Promise.all(trendPeriods.map(async (p) => {
    const m = p.id === period.id ? current : await calculateMonth(p, shared);
    return { month: p.month, label: new Date(`${p.month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      acquiring: m.acquiring?.total ?? 0, ach: m.ach?.total ?? 0, acceptBlue: m.acceptBlue?.chargedTotal ?? 0 };
  }));

  const totals = {
    acquiring: acquiring?.total ?? 0,
    ach: ach?.total ?? 0,
    acceptBlue: acceptBlue?.chargedTotal ?? 0,
    aggregate: sum(tally.map((t) => t.aggregate)),
    payout: sum(tally.map((t) => t.payout)),
    isoRetained: sum(tally.map((t) => t.isoRetained)),
  };

  return {
    periods, period, acquiring, ach, acceptBlue, tally, totals,
    counts: {
      midsCalculated: acquiring?.mids.filter((m) => m.calculated).length ?? 0,
      midsSkipped: acquiring?.mids.filter((m) => !m.calculated).length ?? 0,
      skippedReasons,
    },
    trend,
    partners: partnersDb.map((p) => ({
      id: p.id, name: p.name, defaultSplit: Number(p.default_split), active: p.is_active,
      mids: midPartners.filter((a) => a.partner_id === p.id && a.effective_from <= day && (!a.effective_to || a.effective_to > day)).map((a) => ({
        mid: a.mid, name: byMid.get(a.mid)?.deal_name ?? a.mid, split: Number(a.split),
        adjusted: Number(a.split) !== Number(p.default_split), riskLevel: risk(byMid.get(a.mid)?.values.pricing_risk_level),
      })),
    })),
    template: { card: template.cardGrid, ach: template.achGrid, missing: template.missing },
  };
}
