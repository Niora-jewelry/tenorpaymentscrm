/**
 * ACH reconciliation: the Maverick ACH fee item report.
 *
 * The report has no MID, so each merchant name is matched to a MID first.
 * Per row: Merchant payment − Buy rate = our Net, compared with the report's
 * Net; Split = Net × the ACH percentage for the CRM Risk Level.
 */
import type { AchInput, AchMerchant, AchMidResult, AchResult, AchRowResult, AchTemplate, Flag, RiskLevel } from '../types';
import { flag, rowColor } from './flags';
import { cents, dec, money, sum, type Dec } from './money';

/** ACH spec: High Risk is 90% on purpose (the card template has 70%). */
const ACH_PERCENTAGE: Record<RiskLevel, string> = {
  no_risk: '0.90',
  low_risk: '0.90',
  moderate_risk: '0.80',
  high_risk: '0.90',
};

/** Debit Unauth Fees, what the merchant pays, by Risk Level (No Risk uses Low). */
const DEBIT_UNAUTH: Record<RiskLevel, string> = {
  no_risk: '5.00',
  low_risk: '5.00',
  moderate_risk: '7.50',
  high_risk: '10.00',
};

/** The ACH template has no No Risk column; No Risk uses Low Risk. */
const column = (risk: RiskLevel) => (risk === 'no_risk' ? 'low_risk' : risk);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function reconcileAch(input: AchInput): AchResult {
  const rows = input.reportRows.filter((r) => r.date === input.month);
  const merchants = new Map(input.merchants.map((m) => [m.mid, m]));
  const matches = new Map(Object.entries(input.nameMatches).map(([name, mid]) => [norm(name), mid]));

  const unmatched: string[] = [];
  const midOrder: string[] = [];
  const blocks = new Map<string, Flag | null>();
  const nets = new Map<string, Dec[]>();
  const splits = new Map<string, Dec[]>();

  const blockFor = (mid: string, m: AchMerchant | undefined): Flag | null => {
    if (!blocks.has(mid)) {
      let b: Flag | null = null;
      if (!m) b = flag('ach', 'MID_NOT_IN_CRM', `MID ${mid} is not in the CRM`);
      else if (!m.riskLevel) b = flag('ach', 'RISK_LEVEL_BLANK', 'Risk Level is blank in the CRM');
      else if (norm(m.achProvider ?? '') !== 'maverick')
        b = flag('ach', 'ACH_PROVIDER_NOT_MAVERICK', `ACH Provider is ${m.achProvider ?? 'blank'}, not Maverick`);
      blocks.set(mid, b);
    }
    return blocks.get(mid)!;
  };

  const out: AchRowResult[] = rows.map((r) => {
    const base = { merchantName: r.merchantName, feeCategory: r.feeCategory, reportNet: money(dec(r.net)) };
    const blank = (mid: string | null, flags: Flag[]): AchRowResult => ({
      ...base,
      mid,
      merchantPayment: null,
      buyRate: null,
      net: null,
      split: null,
      flags,
      color: rowColor(flags),
    });

    const mid = matches.get(norm(r.merchantName)) ?? null;
    if (!mid) {
      if (!unmatched.includes(r.merchantName)) unmatched.push(r.merchantName);
      return blank(null, [flag('ach', 'NAME_NOT_MATCHED', `"${r.merchantName}" has no MID`)]);
    }
    if (!midOrder.includes(mid)) midOrder.push(mid);

    const m = merchants.get(mid);
    const block = blockFor(mid, m);
    if (block) return blank(mid, [block]);

    const risk = m!.riskLevel as RiskLevel;
    const res = calculate(r.feeCategory, dec(r.count), dec(r.net), m!, input.template, risk);
    if (!res.mp || !res.br) return blank(mid, res.flags);

    const net = cents(res.mp).minus(cents(res.br));
    const split = cents(net.times(dec(ACH_PERCENTAGE[risk])));
    nets.set(mid, [...(nets.get(mid) ?? []), net]);
    splits.set(mid, [...(splits.get(mid) ?? []), split]);

    const flags = [...res.flags];
    const reported = dec(r.net);
    if (net.minus(reported).gt(1))
      flags.push(flag('ach', 'OUR_NET_HIGHER', `Our Net ${money(net)} is higher than the report's ${money(reported)}`));
    if (reported.minus(net).gt(1))
      flags.push(flag('ach', 'OUR_NET_LOWER', `Our Net ${money(net)} is lower than the report's ${money(reported)}`));

    return {
      ...base,
      mid,
      merchantPayment: money(res.mp),
      buyRate: money(res.br),
      net: money(net),
      split: money(split),
      flags,
      color: rowColor(flags),
    };
  });

  const mids: AchMidResult[] = midOrder.map((mid) => {
    const block = blocks.get(mid);
    if (block) return { mid, calculated: false, net: null, percentage: null, total: null, flags: [block] };
    const risk = merchants.get(mid)!.riskLevel as RiskLevel;
    const net = sum(nets.get(mid) ?? []);
    // Negative Net: the total is the Net, the percentage not applied.
    const total = net.lt(0) ? net : sum(splits.get(mid) ?? []);
    return { mid, calculated: true, net: money(net), percentage: ACH_PERCENTAGE[risk], total: money(total), flags: [] };
  });

  return {
    rows: out,
    mids,
    unmatchedNames: unmatched,
    total: money(sum(mids.filter((m) => m.calculated).map((m) => dec(m.total)))),
  };
}

function calculate(
  category: string,
  count: Dec,
  reportNet: Dec,
  m: AchMerchant,
  template: AchTemplate,
  risk: RiskLevel,
): { mp: Dec | null; br: Dec | null; flags: Flag[] } {
  const t = (key: keyof AchTemplate) => dec(template[key][column(risk)]);
  const ok = (mp: Dec, br: Dec) => ({ mp, br, flags: [] as Flag[] });

  switch (norm(category)) {
    case 'account on file':
      return ok(dec('0'), t('monthly'));
    case 'credit trans fees':
    case 'debit trans fees':
      return ok(count.times(dec(m.achTransactionFee)), count.times(t('transaction')));
    case 'debit fees':
    case 'debit late fees':
      return ok(count.times(dec(m.achReturn)), count.times(t('achReturn')));
    case 'debit unauth fees':
      // ASSUMPTION X6: per occurrence (× Count).
      return ok(count.times(dec(DEBIT_UNAUTH[risk])), count.times(t('debitUnauthorizedFee')));
    case 'discount':
      // Count is the dollar volume here.
      return ok(count.times(dec(m.achBin)), count.times(t('odfiSponsorship')));
    case 'gateway fees':
      return ok(dec(m.achMonthlyGatewayFee), dec('0'));
    case 'noc':
      return ok(count.times(dec(m.achExceptionCorrectionsFee)), dec('0'));
    case 'reject fees':
      // No rule yet. Flagged only when the row carries an amount.
      return {
        mp: null,
        br: null,
        flags: count.eq(0) && reportNet.eq(0) ? [] : [flag('ach', 'REJECT_FEES_NO_RULE', 'Reject Fees: no rule yet')],
      };
    default:
      return { mp: null, br: null, flags: [flag('ach', 'UNKNOWN_FEE_CATEGORY', `Unknown fee category "${category}"`)] };
  }
}
