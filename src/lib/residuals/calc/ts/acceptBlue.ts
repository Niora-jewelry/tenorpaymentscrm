/**
 * Accept.blue reconciliation.
 *
 * Not income: this checks what Accept.blue charged TapDash against each
 * merchant's own Accept.blue setup in the CRM (Merchant Equipment Setup, the
 * Accept.blue row billed to ISO). No buy-rate template.
 */
import type {
  AcceptBlueAmounts,
  AcceptBlueInput,
  AcceptBlueMerchantResult,
  AcceptBlueReportRow,
  AcceptBlueResult,
  Flag,
} from '../types';
import { provider } from './acquiring';
import { flag } from './flags';
import { cents, dec, money, sum, type Dec } from './money';

const TOLERANCE = '0.02';
const REVIEW_OVER = '5';
/** ERTCFunding LLC has no MID on the report (AB spec). */
const NAME_EXCEPTIONS: Record<string, string> = { 'ertcfunding llc': '30119801440' };

/** The report's Month cell: an Excel date serial or 'YYYY-MM[-DD]'. */
export function reportMonthOf(value: number | string): string {
  if (typeof value === 'number') {
    // Excel day 0 is 1899-12-30 (it counts the non-existent 1900-02-29).
    const d = new Date(Date.UTC(1899, 11, 30) + value * 86_400_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return value.slice(0, 7);
}

const isAb = (p: string) => provider(p) === 'acceptblue';
const isIso = (t: string) => t.trim().toLowerCase() === 'iso';

export function reconcileAcceptBlue(input: AcceptBlueInput): AcceptBlueResult {
  const merchants = new Map(input.merchants.map((m) => [m.mid, m]));
  const alerts: Flag[] = [];

  const reportMonth = reportMonthOf(input.reportMonth);
  if (reportMonth !== input.month)
    alerts.push(flag('acceptBlue', 'MONTH_MISMATCH', `The report is for ${reportMonth}, not ${input.month}`));

  const unknownColumns: string[] = [];
  for (const r of input.reportRows)
    for (const c of Object.keys(r.otherColumns)) if (!unknownColumns.includes(c)) unknownColumns.push(c);
  for (const c of unknownColumns)
    alerts.push(flag('acceptBlue', 'UNRECOGNIZED_COLUMN', `Column "${c}" is not in the spec`, c));

  const matched = new Set<string>();

  const results: AcceptBlueMerchantResult[] = input.reportRows.map((r) => {
    const flags: Flag[] = [];
    const { mid, matchedBy } = match(r, merchants);
    if (mid) matched.add(mid);

    const charged = chargedAmounts(r);
    let expected: AcceptBlueAmounts | null = null;

    const m = mid ? merchants.get(mid) : undefined;
    if (!m) {
      flags.push(flag('acceptBlue', 'MID_NOT_IN_CRM', 'MID not found in the CRM'));
    } else {
      const abRows = m.equipment.filter((e) => isAb(e.provider));
      const isoRows = abRows.filter((e) => isIso(e.billedTo));
      if (!abRows.length) flags.push(flag('acceptBlue', 'NO_AB_ROW', 'No Accept.blue row in Merchant Equipment Setup'));
      else if (!isoRows.length)
        flags.push(flag('acceptBlue', 'AB_NOT_BILLED_TO_ISO', `Accept.blue row is billed to ${abRows[0].billedTo}, not ISO`));
      else {
        if (isoRows.length > 1)
          flags.push(flag('acceptBlue', 'MULTIPLE_AB_ROWS', `${isoRows.length} Accept.blue rows billed to ISO, added together`));

        const setupCompared = r.setupFeeIso !== null && dec(r.setupFeeIso).gt(0);
        const exp = {
          setup: setupCompared ? cents(sum(isoRows.map((e) => dec(e.oneTimeFee)))) : null,
          monthly: cents(sum(isoRows.map((e) => dec(e.monthlyFee)))),
          // Per item fee × Transaction Count, rounded once to cents.
          transaction: cents(sum(isoRows.map((e) => dec(e.perItemFee))).times(dec(r.transactionCount))),
          cardUpdaterPerUpdate: dec(r.cardUpdaterPerUpdateIso),
          daf: dec(r.dafTransactionFeeIso),
        };
        expected = amounts(exp);

        const compare = (field: string, calc: Dec, actual: Dec) => {
          if (calc.minus(actual).gt(TOLERANCE))
            flags.push(flag('acceptBlue', 'CALC_ABOVE_CHARGED', `Calculated ${money(calc)} is ${money(calc.minus(actual))} more than charged ${money(actual)}`, field));
          else if (actual.minus(calc).gt(TOLERANCE))
            flags.push(flag('acceptBlue', 'CALC_BELOW_CHARGED', `Charged ${money(actual)} is ${money(actual.minus(calc))} more than calculated ${money(calc)}`, field));
        };
        compare('monthly', exp.monthly, dec(charged.monthly));
        compare('transaction', exp.transaction, dec(charged.transaction));
        if (exp.setup) compare('setup', exp.setup, dec(r.setupFeeIso));
      }
    }

    if (dec(r.cardUpdaterPerUpdateIso).gt(REVIEW_OVER))
      flags.push(flag('acceptBlue', 'OVER_5_REVIEW', 'Card Updater Per Update over $5: manual review', 'cardUpdaterPerUpdate'));
    if (dec(r.dafTransactionFeeIso).gt(REVIEW_OVER))
      flags.push(flag('acceptBlue', 'OVER_5_REVIEW', 'DAF Transaction Fee over $5: manual review', 'daf'));
    for (const c of Object.keys(r.otherColumns))
      flags.push(flag('acceptBlue', 'UNRECOGNIZED_COLUMN', `Column "${c}" is not in the spec`, c));

    return {
      name: r.name,
      reportMid: r.mid,
      mid: m ? mid : null,
      matchedBy: m ? matchedBy : null,
      expected,
      charged,
      isoTotal: money(dec(r.isoTotal)),
      flags,
    };
  });

  const missingFromReport = input.merchants
    .filter((m) => !matched.has(m.mid) && m.equipment.some((e) => isAb(e.provider) && isIso(e.billedTo)))
    .map((m) => m.mid);
  for (const mid of missingFromReport)
    alerts.push(flag('acceptBlue', 'MISSING_FROM_REPORT', `MID ${mid} has an Accept.blue row but is missing from the report`, mid));

  return {
    merchants: results,
    missingFromReport,
    alerts,
    expectedTotal: money(sum(results.map((m) => dec(m.expected?.total ?? null)))),
    chargedTotal: money(sum(results.map((m) => dec(m.isoTotal)))),
  };
}

function match(
  r: AcceptBlueReportRow,
  merchants: Map<string, unknown>,
): { mid: string | null; matchedBy: AcceptBlueMerchantResult['matchedBy'] } {
  if (!r.mid) {
    const mid = NAME_EXCEPTIONS[r.name.trim().toLowerCase()];
    return mid ? { mid, matchedBy: 'name_exception' } : { mid: null, matchedBy: null };
  }
  const digits = r.mid.trim();
  if (merchants.has(digits)) return { mid: digits, matchedBy: 'exact' };
  // Some MIDs carry one extra trailing digit on the report: drop it and retry.
  const shorter = digits.slice(0, -1);
  if (shorter && merchants.has(shorter)) return { mid: shorter, matchedBy: 'trailing_zero' };
  return { mid: digits, matchedBy: null };
}

function chargedAmounts(r: AcceptBlueReportRow): AcceptBlueAmounts {
  return amounts({
    setup: r.setupFeeIso === null ? null : dec(r.setupFeeIso),
    monthly: dec(r.monthlyGatewayFeeIso).plus(dec(r.paymentPagesIso)).plus(dec(r.cardUpdaterMonthlyIso)),
    transaction: dec(r.transactionFeeIso),
    cardUpdaterPerUpdate: dec(r.cardUpdaterPerUpdateIso),
    daf: dec(r.dafTransactionFeeIso),
  });
}

function amounts(a: { setup: Dec | null; monthly: Dec; transaction: Dec; cardUpdaterPerUpdate: Dec; daf: Dec }): AcceptBlueAmounts {
  const total = sum([a.setup ?? dec('0'), a.monthly, a.transaction, a.cardUpdaterPerUpdate, a.daf]);
  return {
    setup: a.setup === null ? null : money(a.setup),
    monthly: money(a.monthly),
    transaction: money(a.transaction),
    cardUpdaterPerUpdate: money(a.cardUpdaterPerUpdate),
    daf: money(a.daf),
    total: money(total),
  };
}
