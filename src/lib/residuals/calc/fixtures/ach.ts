/**
 * ACH test month: six made-up merchants.
 *
 *   A1  Moderate Risk, all ten fee categories, ties out
 *   A2  High Risk: our Net higher on one row (red), lower on another (green),
 *       and a Reject Fees row with an amount (orange, no rule)
 *   A3  Low Risk, negative total: the percentage is not applied
 *   A4  report name with no MID match
 *   A5  Risk Level blank
 *   A6  ACH Provider is not Maverick
 *
 * ACH percentages (ACH spec): No/Low 90%, Moderate 80%, High 90%.
 */
import type { AchInput, AchReportRow, Money, Rate } from '../types';
import { ACH_TEMPLATE } from './template';

const r = (merchantName: string, feeCategory: string, count: string, net: Money, date = '2026-09'): AchReportRow => ({
  merchantName,
  feeCategory,
  count,
  net,
  date,
});

export const A1 = 'Sunrise Bakery';
export const A2 = 'Harbor Tools';
export const A3 = 'Corner Deli';
export const A4 = 'Unknown Name LLC';
export const A5 = 'Blank Risk Co';
export const A6 = 'Other ACH Inc';

export const ACH_INPUT: AchInput = {
  month: '2026-09',
  template: ACH_TEMPLATE,
  nameMatches: {
    [A1]: '900000000001',
    [A2]: '900000000002',
    [A3]: '900000000003',
    [A5]: '900000000004',
    [A6]: '900000000006',
  },
  reportRows: [
    r(A1, 'Discount', '99999.00', '999.00', '2026-08'), // other month: ignored

    /* A1, Moderate: transaction 0.30, return 5.00, gateway 10.00, NOC 2.50, BIN 0.50% */
    r(A1, 'Discount', '20000.00', '100.00'), // 20000×0.005=100.00 − 20000×0 = 100.00
    r(A1, 'Credit Trans Fees', '50', '7.50'), // 50×0.30=15.00 − 50×0.15=7.50
    r(A1, 'Debit Trans Fees', '100', '15.00'), // 30.00 − 15.00
    r(A1, 'Debit Fees', '2', '8.50'), // 2×5.00=10.00 − 2×0.75=1.50
    r(A1, 'Debit Late Fees', '0', '0.00'),
    r(A1, 'Account On File', '1', '-7.50'), // 0.00 − template Monthly 7.50
    r(A1, 'NOC', '1', '2.50'), // 1×2.50 − 0.00
    r(A1, 'Gateway Fees', '1', '10.00'), // 10.00 − 0.00
    r(A1, 'Debit Unauth Fees', '1', '2.50'), // Moderate 7.50 − 5.00
    r(A1, 'Reject Fees', '0', '0.00'), // no amount: not calculated, not flagged
    // Net 138.50; splits at 80% sum to 110.80

    /* A2, High: transaction 0.35, BIN 1.00%; template transaction 0.25, ODFI 0.15% */
    r(A2, 'Discount', '5000.00', '40.00'), // 50.00 − 7.50 = 42.50 vs 40.00: ours higher → red
    r(A2, 'Debit Trans Fees', '33', '5.00'), // 11.55 − 8.25 = 3.30 vs 5.00: ours lower → green
    r(A2, 'Account On File', '1', '-7.50'),
    r(A2, 'Reject Fees', '2', '-10.00'), // has an amount: orange
    // Net 38.30; splits at 90%: 38.25 + 2.97 − 6.75 = 34.47

    /* A3, Low: transaction 0.10 */
    r(A3, 'Account On File', '1', '-7.50'),
    r(A3, 'Credit Trans Fees', '5', '0.00'), // 0.50 − 0.50
    // Net −7.50: negative, so the total is the Net

    r(A4, 'Gateway Fees', '1', '10.00'),
    r(A5, 'Gateway Fees', '1', '10.00'),
    r(A6, 'Gateway Fees', '1', '10.00'),
  ],
  merchants: [
    {
      mid: '900000000001',
      riskLevel: 'moderate_risk',
      achProvider: 'Maverick',
      achTransactionFee: '0.30',
      achReturn: '5.00',
      achMonthlyGatewayFee: '10.00',
      achExceptionCorrectionsFee: '2.50',
      achBin: '0.0050',
    },
    {
      mid: '900000000002',
      riskLevel: 'high_risk',
      achProvider: 'Maverick',
      achTransactionFee: '0.35',
      achReturn: '4.00',
      achMonthlyGatewayFee: null,
      achExceptionCorrectionsFee: null,
      achBin: '0.0100',
    },
    {
      mid: '900000000003',
      riskLevel: 'low_risk',
      achProvider: 'Maverick',
      achTransactionFee: '0.10',
      achReturn: null,
      achMonthlyGatewayFee: null,
      achExceptionCorrectionsFee: null,
      achBin: null,
    },
    {
      mid: '900000000004',
      riskLevel: null,
      achProvider: 'Maverick',
      achTransactionFee: '0.10',
      achReturn: null,
      achMonthlyGatewayFee: '10.00',
      achExceptionCorrectionsFee: null,
      achBin: null,
    },
    {
      mid: '900000000006',
      riskLevel: 'low_risk',
      achProvider: 'Other',
      achTransactionFee: null,
      achReturn: null,
      achMonthlyGatewayFee: '10.00',
      achExceptionCorrectionsFee: null,
      achBin: null,
    },
  ],
};

export type ExpectedAchRow = {
  merchantName: string;
  mid: string | null;
  feeCategory: string;
  merchantPayment: Money | null;
  buyRate: Money | null;
  net: Money | null;
  split: Money | null;
  flags: string[];
  color: string | null;
};

const e = (
  merchantName: string,
  mid: string | null,
  feeCategory: string,
  merchantPayment: Money | null,
  buyRate: Money | null,
  net: Money | null,
  split: Money | null,
  flags: string[] = [],
  color: string | null = null,
): ExpectedAchRow => ({ merchantName, mid, feeCategory, merchantPayment, buyRate, net, split, flags, color });

const m1 = '900000000001';
const m2 = '900000000002';
const m3 = '900000000003';

export const ACH_EXPECTED_ROWS: ExpectedAchRow[] = [
  e(A1, m1, 'Discount', '100.00', '0.00', '100.00', '80.00'),
  e(A1, m1, 'Credit Trans Fees', '15.00', '7.50', '7.50', '6.00'),
  e(A1, m1, 'Debit Trans Fees', '30.00', '15.00', '15.00', '12.00'),
  e(A1, m1, 'Debit Fees', '10.00', '1.50', '8.50', '6.80'),
  e(A1, m1, 'Debit Late Fees', '0.00', '0.00', '0.00', '0.00'),
  e(A1, m1, 'Account On File', '0.00', '7.50', '-7.50', '-6.00'),
  e(A1, m1, 'NOC', '2.50', '0.00', '2.50', '2.00'),
  e(A1, m1, 'Gateway Fees', '10.00', '0.00', '10.00', '8.00'),
  e(A1, m1, 'Debit Unauth Fees', '7.50', '5.00', '2.50', '2.00'),
  e(A1, m1, 'Reject Fees', null, null, null, null),

  e(A2, m2, 'Discount', '50.00', '7.50', '42.50', '38.25', ['OUR_NET_HIGHER'], 'red'),
  e(A2, m2, 'Debit Trans Fees', '11.55', '8.25', '3.30', '2.97', ['OUR_NET_LOWER'], 'green'),
  e(A2, m2, 'Account On File', '0.00', '7.50', '-7.50', '-6.75'),
  e(A2, m2, 'Reject Fees', null, null, null, null, ['REJECT_FEES_NO_RULE'], 'orange'),

  e(A3, m3, 'Account On File', '0.00', '7.50', '-7.50', '-6.75'),
  e(A3, m3, 'Credit Trans Fees', '0.50', '0.50', '0.00', '0.00'),

  e(A4, null, 'Gateway Fees', null, null, null, null, ['NAME_NOT_MATCHED'], 'red'),
  e(A5, '900000000004', 'Gateway Fees', null, null, null, null, ['RISK_LEVEL_BLANK'], 'red'),
  e(A6, '900000000006', 'Gateway Fees', null, null, null, null, ['ACH_PROVIDER_NOT_MAVERICK'], 'orange'),
];

export type ExpectedAchMid = {
  mid: string;
  calculated: boolean;
  net: Money | null;
  percentage: Rate | null;
  total: Money | null;
  flags: string[];
};

export const ACH_EXPECTED_MIDS: ExpectedAchMid[] = [
  { mid: m1, calculated: true, net: '138.50', percentage: '0.80', total: '110.80', flags: [] },
  { mid: m2, calculated: true, net: '38.30', percentage: '0.90', total: '34.47', flags: [] },
  { mid: m3, calculated: true, net: '-7.50', percentage: '0.90', total: '-7.50', flags: [] },
  { mid: '900000000004', calculated: false, net: null, percentage: null, total: null, flags: ['RISK_LEVEL_BLANK'] },
  {
    mid: '900000000006',
    calculated: false,
    net: null,
    percentage: null,
    total: null,
    flags: ['ACH_PROVIDER_NOT_MAVERICK'],
  },
];

export const ACH_EXPECTED_UNMATCHED = [A4];

/** 110.80 + 34.47 − 7.50 */
export const ACH_EXPECTED_TOTAL = '137.77';
