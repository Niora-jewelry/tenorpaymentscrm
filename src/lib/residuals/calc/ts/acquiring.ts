/**
 * Acquiring reconciliation: the Maverick card fee item report.
 *
 * For each report row in the chosen month: Merchant payment (what the merchant
 * should have paid, from the CRM), Buy rate (what Maverick charges, from the
 * template), Income = the difference. Per MID: Income × the template
 * Percentage for the CRM Risk Level (not Maverick's Agent %).
 */
import type {
  AcquiringInput,
  AcquiringMerchant,
  AcquiringMidResult,
  AcquiringReportRow,
  AcquiringResult,
  AcquiringRowResult,
  CardPricing,
  CardTemplate,
  EquipmentRow,
  Flag,
  RiskLevel,
} from '../types';
import { flag, rowColor } from './flags';
import { cents, dec, differs, money, sum, type Dec } from './money';

/* ── Fee item names → rule keys ─────────────────────────────────────────── */

type Rule =
  | 'amex_optblue' | 'bin' | 'cash_disc' | 'auth' | 'avs' | 'deposit' | 'chargeback' | 'ebt_auth'
  | 'pin_auth' | 'credit_refund' | 'monthly' | 'online_access' | 'pci' | 'website' | 'irs'
  | 'passthrough' | 'ab_monthly' | 'epay_gold' | 'epay_silver' | 'ab_setup' | 'ab_per_item'
  | 'ipos_spin' | 'ipospays' | 'nuvolinq' | 'valor_portal' | 'valor_addons' | 'equipment_supplies';

/** Spec names and the names the real report uses (C6 in open-questions). */
const RULES: Record<string, Rule> = {
  'amex optblue fee': 'amex_optblue',
  'bin sponsorship fees': 'bin',
  'cash disc/surcharge program': 'cash_disc',
  'authorization fee ip/ssl': 'auth',
  'avs fee': 'avs',
  'merchant deposit transaction': 'deposit',
  'chargeback fee': 'chargeback',
  'ebt authorization fee': 'ebt_auth',
  'pin debit auth fee': 'pin_auth',
  'credit/refund': 'credit_refund',
  'monthly fee': 'monthly',
  'monthly online access fee': 'online_access',
  'pci program': 'pci',
  'website monitoring fee': 'website',
  'irs annual fee': 'irs',
  interchange: 'passthrough',
  'card brand fees': 'passthrough',
  'card brand fees v/mc/d/pp': 'passthrough',
  'amex pass thru fees (non ob)': 'passthrough',
  'pin debit interchange': 'passthrough',
  'accept blue monthly': 'ab_monthly',
  'usa epay gold': 'epay_gold',
  'usa epay monthly fee - gold': 'epay_gold',
  'usa epay silver': 'epay_silver',
  'usa epay monthly fee - silver': 'epay_silver',
  'accept blue setup': 'ab_setup',
  'accept.blue per item total': 'ab_per_item',
  'ipos spin': 'ipos_spin',
  'ipos spin fee': 'ipos_spin',
  'ipospays terminal': 'ipospays',
  nuvolinq: 'nuvolinq',
  'nuvolinq 10mb data': 'nuvolinq',
  'nuvolinq 10mb data plan': 'nuvolinq',
  'valor portal access': 'valor_portal',
  'valor terminal add-ons': 'valor_addons',
  'equipment & supplies': 'equipment_supplies',
};

/** Matching ignores dash style, capitalization and repeated spaces. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();
}

const ruleFor = (name: string): Rule | undefined => RULES[normalizeName(name)];

/** Gateway and terminal groups share one merchant payment (ASSUMPTION X3, X4). */
const GROUPS: Record<'gateway' | 'terminal', { rules: Rule[]; providers: string[] }> = {
  gateway: { rules: ['ab_monthly', 'epay_gold', 'epay_silver'], providers: ['acceptblue', 'usaepay'] },
  terminal: { rules: ['ipos_spin', 'ipospays', 'nuvolinq', 'valor_portal', 'valor_addons'], providers: ['ipos', 'valor'] },
};
const groupOf = (rule: Rule) =>
  (Object.keys(GROUPS) as (keyof typeof GROUPS)[]).find((g) => GROUPS[g].rules.includes(rule));

const ITEM_TEMPLATE: Partial<Record<Rule, keyof CardTemplate>> = {
  ab_monthly: 'acceptBlueMonthly',
  epay_gold: 'usaEpayGold',
  epay_silver: 'usaEpaySilver',
  ipos_spin: 'iposSpinFeeMonthly',
  ipospays: 'ipospaysTerminalMonthly',
  nuvolinq: 'nuvolinq10mbData',
  valor_portal: 'valorPortalAccess',
  valor_addons: 'valorTerminalAddOns',
};

export const provider = (p: string) => p.toLowerCase().replace(/[^a-z0-9]/g, '');
const byMaverick = (e: EquipmentRow) => provider(e.billedBy) === 'maverick';

/* ── Statement volumes ──────────────────────────────────────────────────── */

const BUCKETS: Record<string, 'vmd' | 'amex' | 'debit' | 'ebt'> = {
  VS: 'vmd', VB: 'vmd', MC: 'vmd', MB: 'vmd', JC: 'vmd', DS: 'vmd', DZ: 'vmd', DJ: 'vmd', DB: 'vmd',
  AM: 'amex',
  MD: 'debit', DD: 'debit', VD: 'debit',
  EBT: 'ebt',
};

type Volumes = { vmd: Dec; amex: Dec; debit: Dec; ebt: Dec };
const zeroVolumes = (): Volumes => ({ vmd: dec('0'), amex: dec('0'), debit: dec('0'), ebt: dec('0') });

function statementVolumes(statement: NonNullable<AcquiringMerchant['statement']>) {
  const gross = zeroVolumes();
  const net = zeroVolumes();
  const unknown: string[] = [];
  for (const p of statement) {
    const b = BUCKETS[p.planCode.trim().toUpperCase()];
    if (!b) {
      if (!dec(p.amount).eq(0)) unknown.push(p.planCode);
      continue;
    }
    gross[b] = gross[b].plus(dec(p.amount));
    net[b] = net[b].plus(dec(p.amount).minus(dec(p.creditAmount)));
  }
  return { gross, net, unknown };
}

const all4 = (v: Volumes) => v.vmd.plus(v.amex).plus(v.debit).plus(v.ebt);
const moneyVolumes = (v: Volumes) => ({ vmd: money(v.vmd), amex: money(v.amex), debit: money(v.debit), ebt: money(v.ebt) });

/* ── The calculation ────────────────────────────────────────────────────── */

export function reconcileAcquiring(input: AcquiringInput): AcquiringResult {
  const { template } = input;
  const rows = input.reportRows.filter((r) => r.date === input.month);
  const merchants = new Map(input.merchants.map((m) => [m.mid, m]));
  const mids = [...new Set(rows.map((r) => r.mid))];

  const rowResults = new Map<AcquiringReportRow, AcquiringRowResult>();
  const midResults: AcquiringMidResult[] = [];

  for (const mid of mids) {
    const midRows = rows.filter((r) => r.mid === mid);
    const merchant = merchants.get(mid);
    const midFlags: Flag[] = [];

    // Which reason, if any, stops this MID from being calculated.
    let block: Flag | null = null;
    if (!merchant) block = flag('acquiring', 'MID_NOT_IN_CRM', `MID ${mid} is not in the CRM`);
    else if (!merchant.riskLevel) block = flag('acquiring', 'RISK_LEVEL_BLANK', 'Risk Level is blank in the CRM');
    else if (!merchant.statement && !input.proceedWithoutStatement)
      block = flag('acquiring', 'NO_STATEMENT', 'No statement for this month');

    const stmt = merchant?.statement ? statementVolumes(merchant.statement) : null;

    if (block) {
      midFlags.push(block);
      for (const r of midRows) {
        const flags = [block, ...reportFlags(r)];
        rowResults.set(r, blankRow(r, flags));
      }
      midResults.push({
        mid,
        calculated: false,
        riskLevel: merchant?.riskLevel ?? null,
        volumes: stmt ? moneyVolumes(stmt.gross) : null,
        income: null,
        percentage: null,
        netIncome: null,
        flags: midFlags,
      });
      continue;
    }

    const m = merchant!;
    const risk = m.riskLevel as RiskLevel;
    const rulesOf = (rule: Rule) => midRows.filter((r) => ruleFor(r.feeItemName) === rule);
    const hasCashDisc = rulesOf('cash_disc').length > 0;
    const rowFlags: Flag[] = []; // MID-level flags that also go on every row

    let gross: Volumes;
    if (stmt) {
      const { net } = stmt;
      gross = stmt.gross;
      if (stmt.unknown.length)
        midFlags.push(flag('acquiring', 'UNKNOWN_PLAN_CODE', `Plan code not counted: ${stmt.unknown.join(', ')}`));

      // Volume check (ASSUMPTION X2: BIN net of refunds, the others gross).
      const checks: [Rule, Dec][] = [
        ['cash_disc', all4(gross)],
        ['bin', hasCashDisc ? net.vmd.plus(net.debit).plus(net.ebt) : all4(net)],
        ['amex_optblue', gross.amex],
      ];
      const off = checks.flatMap(([rule, expected]) =>
        rulesOf(rule)
          .filter((r) => differs(dec(r.amount), expected, '1'))
          .map((r) => `${r.feeItemName}: report ${money(dec(r.amount))}, statement ${money(expected)}`),
      );
      if (off.length) {
        const f = flag('acquiring', 'VOLUME_MISMATCH', `Volume check failed. ${off.join('; ')}`);
        midFlags.push(f);
        rowFlags.push(f);
      }
    } else {
      // Proceeding without a statement (ASSUMPTION X5).
      const amex = sum(rulesOf('amex_optblue').map((r) => dec(r.amount)));
      const bin = sum(rulesOf('bin').map((r) => dec(r.amount)));
      gross = { vmd: hasCashDisc ? bin : bin.minus(amex), amex, debit: dec('0'), ebt: dec('0') };
      const f = flag('acquiring', 'NO_STATEMENT', 'No statement: volumes taken from the report Amount');
      midFlags.push(f);
      rowFlags.push(f);
    }

    const pct = template.percentage[risk];
    const agentPct = midRows[0] ? dec(midRows[0].agentPct).div(100) : null;
    if (agentPct && !agentPct.eq(dec(pct)))
      midFlags.push(
        flag('acquiring', 'AGENT_PCT_MISMATCH', `Maverick's Agent % is ${midRows[0].agentPct}; the CRM Risk Level gives ${dec(pct).times(100).toString()}`),
      );

    const ctx: Ctx = {
      template,
      risk,
      p: m.pricing,
      equipment: m.equipment,
      vol: gross,
      hasCashDisc,
      hasMonthlyRow: rulesOf('monthly').length > 0,
      firstOfGroup: new Map(),
    };
    for (const g of Object.keys(GROUPS) as (keyof typeof GROUPS)[]) {
      const first = midRows.find((r) => GROUPS[g].rules.includes(ruleFor(r.feeItemName) as Rule));
      if (first) ctx.firstOfGroup.set(g, first);
    }

    const incomes: Dec[] = [];
    for (const r of midRows) {
      const res = calculateRow(r, ctx);
      const flags = [...rowFlags, ...res.flags, ...reportFlags(r)];
      let income: Dec | null = null;
      if (res.mp && res.br) {
        income = cents(res.mp).minus(cents(res.br));
        incomes.push(income);
        const nr = dec(r.netRevenue);
        if (income.minus(nr).gt(1))
          flags.push(flag('acquiring', 'INCOME_ABOVE_REPORTED', `Income ${money(income)} is above Net Revenue ${money(nr)}`));
        if (nr.minus(income).gt(1))
          flags.push(flag('acquiring', 'REPORTED_ABOVE_INCOME', `Net Revenue ${money(nr)} is above Income ${money(income)}`));
      }
      rowResults.set(r, {
        mid,
        feeItemName: r.feeItemName,
        netRevenue: money(dec(r.netRevenue)),
        merchantPayment: res.mp ? money(res.mp) : null,
        buyRate: res.br ? money(res.br) : null,
        income: income ? money(income) : null,
        flags,
        color: rowColor(flags),
      });
    }

    const income = sum(incomes);
    // Negative income: the percentage is not applied.
    const netIncome = income.lt(0) ? income : cents(income.times(dec(pct)));
    midResults.push({
      mid,
      calculated: true,
      riskLevel: risk,
      volumes: moneyVolumes(gross),
      income: money(income),
      percentage: pct,
      netIncome: money(netIncome),
      flags: midFlags,
    });
  }

  return {
    rows: rows.map((r) => rowResults.get(r)!),
    mids: midResults,
    total: money(sum(midResults.filter((m) => m.calculated).map((m) => dec(m.netIncome)))),
  };
}

type Ctx = {
  template: CardTemplate;
  risk: RiskLevel;
  p: CardPricing;
  equipment: EquipmentRow[];
  vol: Volumes;
  hasCashDisc: boolean;
  hasMonthlyRow: boolean;
  firstOfGroup: Map<'gateway' | 'terminal', AcquiringReportRow>;
};

/** Merchant payment and Buy rate for one row, unrounded. Null = not calculated. */
function calculateRow(r: AcquiringReportRow, c: Ctx): { mp: Dec | null; br: Dec | null; flags: Flag[] } {
  const t = (key: keyof CardTemplate) => dec(c.template[key][c.risk]);
  const p = (key: keyof CardPricing) => dec(c.p[key]);
  const count = dec(r.count);
  const { vol } = c;
  const volumeFormula = () =>
    vol.amex.times(p('amexVolume'))
      .plus(vol.vmd.times(p('vmdVolume')))
      .plus(vol.debit.times(p('pinDebitVolume')))
      .plus(vol.ebt.times(p('ebtVolume')))
      .plus(count.times(p('vmdTransactionFee')));
  const adj = (key: keyof CardPricing, fallback: keyof CardTemplate) => (c.p[key] !== null ? dec(c.p[key]) : t(fallback));
  const noEquipment = (): Flag[] =>
    dec(r.agentExpense).gt(0)
      ? [flag('acquiring', 'NO_EQUIPMENT_ROW', 'No matching Equipment row, but Maverick charged for it')]
      : [];
  const ok = (mp: Dec, br: Dec) => ({ mp, br, flags: [] as Flag[] });

  const rule = ruleFor(r.feeItemName);
  switch (rule) {
    case 'amex_optblue':
      return ok(vol.amex.times(p('amexOptBlueFee')), vol.amex.times(adj('amexVolumeBuyRateAdjustment', 'amexOptBlue')));
    case 'bin':
      return ok(
        c.hasCashDisc ? dec('0') : volumeFormula(),
        vol.vmd.times(adj('vmdVolumeBuyRateAdjustment', 'vmdBin')).plus(vol.debit.times(adj('pinDebitVolumeBuyRateAdjustment', 'vmdBin'))),
      );
    case 'cash_disc':
      return ok(volumeFormula(), dec('0'));
    case 'auth':
      return ok(count.times(p('vmdAuthFee')), count.times(t('vmdAuthFee')));
    case 'avs':
      return ok(count.times(p('avsFee')), count.times(t('avsFee')));
    case 'deposit':
      return ok(count.times(p('batchFee')), count.times(t('batchFee')));
    case 'chargeback':
      return ok(count.times(p('chargebackFee')), count.times(t('chargeback')));
    case 'ebt_auth':
      return ok(count.times(p('ebtAuthFee')), count.times(t('ebtAuthFee')));
    case 'pin_auth':
      return ok(count.times(p('pinDebitAuthFee')), dec('0'));
    case 'credit_refund':
      return { mp: null, br: dec('0'), flags: [flag('acquiring', 'CREDIT_REFUND', 'Credit/Refund: review manually')] };
    case 'monthly':
      return ok(p('monthlyFee'), t('monthlyFee'));
    case 'online_access':
      // The CRM Monthly Fee covers both rows; it sits on the Monthly Fee row (ASSUMPTION X3).
      return ok(c.hasMonthlyRow ? dec('0') : p('monthlyFee'), t('monthlyOnlineAccessFee'));
    case 'pci':
      return ok(p('pciFee'), t('pciFee'));
    case 'website':
      return ok(p('monthlyWebsiteMonitoringFee'), t('websiteMonitoringFee'));
    case 'irs':
      return ok(dec(r.netRevenue), t('irsAnnualFee'));
    case 'passthrough':
      return ok(dec(r.netRevenue), dec('0'));
    case 'ab_setup': {
      const eq = c.equipment.filter((e) => byMaverick(e) && provider(e.provider) === 'acceptblue');
      return { mp: sum(eq.map((e) => dec(e.oneTimeFee))), br: t('acceptBlueSetup'), flags: eq.length ? [] : noEquipment() };
    }
    case 'ab_per_item': {
      const eq = c.equipment.filter((e) => byMaverick(e) && provider(e.provider) === 'acceptblue');
      return {
        mp: count.times(sum(eq.map((e) => dec(e.perItemFee)))),
        br: count.times(t('acceptBluePerItem')),
        flags: eq.length ? [] : noEquipment(),
      };
    }
    case 'equipment_supplies': {
      const eq = c.equipment.filter((e) => provider(e.provider) === 'maverick');
      return {
        mp: sum(eq.map((e) => dec(e.oneTimeFee))),
        br: null,
        flags: [
          flag('acquiring', 'EQUIPMENT_SUPPLIES_REVIEW', 'Equipment & Supplies: buy rate needs manual review'),
          ...(eq.length ? [] : noEquipment()),
        ],
      };
    }
    case undefined:
      return { mp: null, br: null, flags: [flag('acquiring', 'UNKNOWN_FEE_ITEM', `Unknown fee item "${r.feeItemName}"`)] };
    default: {
      const group = groupOf(rule)!;
      const eq = c.equipment.filter((e) => byMaverick(e) && GROUPS[group].providers.includes(provider(e.provider)));
      const first = c.firstOfGroup.get(group) === r;
      return {
        mp: first ? sum(eq.map((e) => dec(e.monthlyFee))) : dec('0'),
        br: t(ITEM_TEMPLATE[rule]!),
        flags: eq.length ? [] : noEquipment(),
      };
    }
  }
}

/** Checks on the report's own figures; they apply to every row. */
function reportFlags(r: AcquiringReportRow): Flag[] {
  const out: Flag[] = [];
  if (dec(r.netRevenue).lt(0)) out.push(flag('acquiring', 'NEGATIVE_NET_REVENUE', 'Net Revenue is below $0'));
  if (!dec(r.agentExpense).eq(0)) out.push(flag('acquiring', 'AGENT_EXPENSE_NONZERO', 'Agent Expense is not $0'));
  return out;
}

function blankRow(r: AcquiringReportRow, flags: Flag[]): AcquiringRowResult {
  return {
    mid: r.mid,
    feeItemName: r.feeItemName,
    netRevenue: money(dec(r.netRevenue)),
    merchantPayment: null,
    buyRate: null,
    income: null,
    flags,
    color: rowColor(flags),
  };
}
