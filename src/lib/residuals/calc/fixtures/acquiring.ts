/**
 * Acquiring test month: seven made-up merchants, one scenario each.
 *
 *   M1  ties out: statement volumes match, every row equals Net Revenue
 *   M2  Agent % differs (Maverick 90%, CRM High Risk 70%), Cash Disc program,
 *       a VMD buy-rate adjustment, and a total that floating point rounds wrong
 *   M3  different transactions reported: report volume ≠ statement volume
 *   M4  Risk Level blank in the CRM
 *   M5  no statement (user did not choose to proceed)
 *   M6  gateway/terminal equipment, Credit/Refund, unknown fee item,
 *       Equipment & Supplies, fee item name alias, negative income
 *   M7  MID on the report but not in the CRM
 *
 * Every expected figure is worked by hand in the comments. MIDs are made up
 * (9000…); no real merchant data is used.
 */
import type { AcquiringInput, AcquiringReportRow, CardPricing, Money, Rate, RiskLevel } from '../types';
import { CARD_TEMPLATE } from './template';

const NO_PRICING: CardPricing = {
  amexAuthFee: null,
  vmdAuthFee: null,
  pinDebitAuthFee: null,
  amexVolume: null,
  vmdVolume: null,
  pinDebitVolume: null,
  chargebackFee: null,
  vmdTransactionFee: null,
  avsFee: null,
  batchFee: null,
  monthlyFee: null,
  ebtVolume: null,
  amexOptBlueFee: null,
  monthlyWebsiteMonitoringFee: null,
  pciFee: null,
  ebtAuthFee: null,
  amexVolumeBuyRateAdjustment: null,
  vmdVolumeBuyRateAdjustment: null,
  pinDebitVolumeBuyRateAdjustment: null,
};
const pricing = (p: Partial<CardPricing>): CardPricing => ({ ...NO_PRICING, ...p });

const r = (
  mid: string,
  feeItemName: string,
  netRevenue: Money,
  o: { count?: string; amount?: Money; agentExpense?: Money; agentPct?: string; date?: string } = {},
): AcquiringReportRow => ({
  mid,
  feeItemName,
  date: o.date ?? '2026-09',
  count: o.count ?? '1',
  amount: o.amount ?? '0.00',
  netRevenue,
  agentExpense: o.agentExpense ?? '0.00',
  agentPct: o.agentPct ?? '90',
});

export const M1 = '900000000001';
export const M2 = '900000000002';
export const M3 = '900000000003';
export const M4 = '900000000004';
export const M5 = '900000000005';
export const M6 = '900000000006';
export const M7 = '900000000099';

export const ACQUIRING_INPUT: AcquiringInput = {
  month: '2026-09',
  template: CARD_TEMPLATE,
  proceedWithoutStatement: false,
  reportRows: [
    // A different month in the same year-to-date file: must be ignored.
    r(M1, 'AVS Fee', '999.00', { count: '999', date: '2026-08', agentPct: '80' }),

    /* ── M1, Moderate Risk, ties out ─────────────────────────────────────
       Statement: VMD 15,000 gross (VS 10,000 with 200 refunds + MC 5,000),
       Amex 4,000, Debit 2,000. No Cash Disc row, so BIN Sponsorship is
       checked against net VMD + Debit + EBT + Amex = 14,800 + 2,000 + 0 +
       4,000 = 20,800, and Amex OptBlue against gross Amex = 4,000. */
    r(M1, 'AVS Fee', '6.00', { count: '200', agentPct: '80' }), // 200×0.05=10.00 − 200×0.02=4.00
    r(M1, 'Authorization Fee IP/SSL', '21.00', { count: '300', agentPct: '80' }), // 300×0.10=30.00 − 300×0.03=9.00
    r(M1, 'Merchant Deposit Transaction', '2.62', { count: '21', agentPct: '80' }), // 21×0.15=3.15 − 21×0.025=0.525→0.53
    r(M1, 'Monthly Fee', '5.95', { agentPct: '80' }), // 9.95 − 4.00
    r(M1, 'Monthly Online Access Fee', '-8.00', { agentPct: '80' }), // 0.00 (paid on Monthly Fee) − 8.00
    r(M1, 'PCI Program', '4.95', { agentPct: '80' }), // 9.95 − 5.00
    r(M1, 'Amex OptBlue Fee', '6.00', { count: '40', amount: '4000.00', agentPct: '80' }), // 4000×0.003=12.00 − 4000×0.0015=6.00
    // 4000×0.035 + 15000×0.0275 + 2000×0.015 + 250×0.10 = 140+412.50+30+25 = 607.50
    // − (15000×0.0002 + 2000×0.0002) = 3.40  →  604.10
    r(M1, 'BIN Sponsorship Fees', '604.10', { count: '250', amount: '20800.00', agentPct: '80' }),

    /* ── M2, High Risk, Agent % 90 vs CRM 70% ────────────────────────────
       Statement: VMD 3,000, Amex 1,000, Debit 500 (DD). Has a Cash Disc row:
       Cash Disc checked against all four gross = 4,500; BIN against net
       VMD + Debit + EBT = 3,500; OptBlue against Amex = 1,000. */
    // 1000×0.04 + 3000×0.04 + 500×0.02 + 80×0.20 = 40+120+10+16 = 186.00, buy 0
    r(M2, 'Cash Disc/Surcharge Program', '186.00', { count: '80', amount: '4500.00' }),
    // Merchant pays 0 (Cash Disc row exists). Buy: 3000×0.0015 (VMD adjustment) + 500×0.0020 = 4.50+1.00
    r(M2, 'BIN Sponsorship Fees', '-5.50', { count: '70', amount: '3500.00' }),
    r(M2, 'Amex OptBlue Fee', '2.00', { count: '10', amount: '1000.00' }), // 1000×0.004=4.00 − 1000×0.002=2.00
    r(M2, 'Authorization Fee IP/SSL', '4.50', { count: '45' }), // 45×0.15=6.75 − 45×0.05=2.25
    r(M2, 'Chargeback Fee', '10.00'), // 35.00 − 25.00
    r(M2, 'PCI Program', '-5.00'), // blank PCI Fee = 0.00 − 5.00
    r(M2, 'Card Brand Fees V/MC/D/PP', '-12.34'), // pass-through
    r(M2, 'Monthly Fee', '12.99'), // 19.99 − 7.00
    // Income 186−5.50+2+4.50+10−5−12.34+12.99 = 192.65; ×0.70 = 134.855 → 134.86
    // (floating point gives 134.85499999999999 → 134.85)

    /* ── M3, Low Risk, report volume differs ─────────────────────────────
       Statement: VMD 8,000, Debit 1,000, plus 50 under plan code "EB" (not in
       the spec's buckets). BIN expects 9,000; the report says 9,250. */
    // 8000×0.025 + 1000×0.01 + 100×0.05 = 215.00 − (8000×0.0002 + 1000×0.0002 = 1.80) = 213.20
    // Maverick reports 219.43 (on its higher volume): 6.23 more than our Income
    r(M3, 'BIN Sponsorship Fees', '219.43', { count: '100', amount: '9250.00' }),
    r(M3, 'Authorization Fee IP/SSL', '7.20', { count: '120' }), // 120×0.08=9.60 − 120×0.02=2.40
    r(M3, 'Monthly Fee', '10.95'), // 14.95 − 4.00
    r(M3, 'Monthly Online Access Fee', '-6.50'), // 0.00 − 6.50
    // Income 213.20+7.20+10.95−6.50 = 224.85; ×0.90 = 202.365 → 202.37

    /* ── M4, Risk Level blank ─────────────────────────────────────────── */
    r(M4, 'Monthly Fee', '5.95'),

    /* ── M5, no statement ─────────────────────────────────────────────── */
    r(M5, 'AVS Fee', '0.40', { count: '10' }),

    /* ── M6, Moderate Risk, equipment and review items ───────────────────
       Equipment: Accept.blue billed by Maverick (monthly 15.00, per item 0.10,
       one-time 49.99) and Valor billed by Tenor (ignored: not Maverick). */
    // Gateway group (Accept Blue Monthly + USA ePay Gold): one payment, the
    // Maverick-billed Accept.blue/UsaEpay rows' monthly total = 15.00, on the first row.
    r(M6, 'Accept Blue Monthly', '5.00', { agentExpense: '10.00', agentPct: '80' }), // 15.00 − 10.00
    r(M6, 'USA ePay Monthly Fee - Gold', '-20.00', { agentPct: '80' }), // alias of "USA ePay Gold": 0.00 − 20.00
    r(M6, 'Accept.blue Per Item Total', '1.50', { count: '30', agentPct: '80' }), // 30×0.10=3.00 − 30×0.05=1.50
    r(M6, 'Accept Blue Setup', '0.00', { agentPct: '80' }), // 49.99 − 49.99
    // Terminal group: no IPOS/Valor row billed by Maverick → 0.00 − 4.95, and Maverick charged → flag
    r(M6, 'Valor Portal Access', '-4.95', { agentExpense: '4.95', agentPct: '80' }),
    r(M6, 'Credit/Refund', '-3.00', { agentPct: '80' }), // not calculated
    r(M6, 'Mystery Fee', '1.00', { agentPct: '80' }), // unknown fee item
    r(M6, 'Equipment & Supplies', '100.00', { agentPct: '80' }), // payment 0.00 (no Maverick-provider row), buy not calculated
    // Income 5.00−20.00+1.50+0.00−4.95 = −18.45: negative, so Net income = Income

    /* ── M7, not in the CRM ───────────────────────────────────────────── */
    r(M7, 'Monthly Fee', '5.95'),
  ],
  merchants: [
    {
      mid: M1,
      riskLevel: 'moderate_risk',
      pricing: pricing({
        avsFee: '0.05',
        vmdAuthFee: '0.10',
        batchFee: '0.15',
        monthlyFee: '9.95',
        pciFee: '9.95',
        amexOptBlueFee: '0.0030',
        amexVolume: '0.0350',
        vmdVolume: '0.0275',
        pinDebitVolume: '0.0150',
        ebtVolume: '0',
        vmdTransactionFee: '0.10',
      }),
      statement: [
        { planCode: 'VS', amount: '10000.00', creditAmount: '200.00' },
        { planCode: 'MC', amount: '5000.00', creditAmount: '0.00' },
        { planCode: 'AM', amount: '4000.00', creditAmount: '0.00' },
        { planCode: 'MD', amount: '2000.00', creditAmount: '0.00' },
      ],
      equipment: [],
    },
    {
      mid: M2,
      riskLevel: 'high_risk',
      pricing: pricing({
        vmdAuthFee: '0.15',
        chargebackFee: '35.00',
        monthlyFee: '19.99',
        amexOptBlueFee: '0.0040',
        amexVolume: '0.04',
        vmdVolume: '0.04',
        pinDebitVolume: '0.02',
        ebtVolume: '0',
        vmdTransactionFee: '0.20',
        vmdVolumeBuyRateAdjustment: '0.0015',
      }),
      statement: [
        { planCode: 'VS', amount: '3000.00', creditAmount: '0.00' },
        { planCode: 'AM', amount: '1000.00', creditAmount: '0.00' },
        { planCode: 'DD', amount: '500.00', creditAmount: '0.00' },
      ],
      equipment: [],
    },
    {
      mid: M3,
      riskLevel: 'low_risk',
      pricing: pricing({
        vmdAuthFee: '0.08',
        vmdVolume: '0.025',
        pinDebitVolume: '0.01',
        amexVolume: '0',
        vmdTransactionFee: '0.05',
        monthlyFee: '14.95',
      }),
      statement: [
        { planCode: 'VS', amount: '8000.00', creditAmount: '0.00' },
        { planCode: 'MD', amount: '1000.00', creditAmount: '0.00' },
        { planCode: 'EB', amount: '50.00', creditAmount: '0.00' },
      ],
      equipment: [],
    },
    {
      mid: M4,
      riskLevel: null,
      pricing: pricing({ monthlyFee: '9.95' }),
      statement: [{ planCode: 'VS', amount: '100.00', creditAmount: '0.00' }],
      equipment: [],
    },
    { mid: M5, riskLevel: 'low_risk', pricing: pricing({ avsFee: '0.05' }), statement: null, equipment: [] },
    {
      mid: M6,
      riskLevel: 'moderate_risk',
      pricing: pricing({}),
      statement: [],
      equipment: [
        {
          provider: 'Accept.blue',
          billedBy: 'Maverick',
          billedTo: 'Merchant',
          monthlyFee: '15.00',
          perItemFee: '0.10',
          oneTimeFee: '49.99',
        },
        { provider: 'Valor', billedBy: 'Tenor', billedTo: 'Merchant', monthlyFee: '20.00', perItemFee: null, oneTimeFee: null },
      ],
    },
  ],
};

/* ──────────────────────────────────────────────────────────────────────────
 * Expected
 * ────────────────────────────────────────────────────────────────────────── */

export type ExpectedAcquiringRow = {
  mid: string;
  feeItemName: string;
  merchantPayment: Money | null;
  buyRate: Money | null;
  income: Money | null;
  flags: string[];
  color: string | null;
};

const e = (
  mid: string,
  feeItemName: string,
  merchantPayment: Money | null,
  buyRate: Money | null,
  income: Money | null,
  flags: string[] = [],
  color: string | null = null,
): ExpectedAcquiringRow => ({ mid, feeItemName, merchantPayment, buyRate, income, flags, color });

const RED = 'red';
const ORANGE = 'orange';

export const ACQUIRING_EXPECTED_ROWS: ExpectedAcquiringRow[] = [
  e(M1, 'AVS Fee', '10.00', '4.00', '6.00'),
  e(M1, 'Authorization Fee IP/SSL', '30.00', '9.00', '21.00'),
  e(M1, 'Merchant Deposit Transaction', '3.15', '0.53', '2.62'),
  e(M1, 'Monthly Fee', '9.95', '4.00', '5.95'),
  e(M1, 'Monthly Online Access Fee', '0.00', '8.00', '-8.00', ['NEGATIVE_NET_REVENUE'], ORANGE),
  e(M1, 'PCI Program', '9.95', '5.00', '4.95'),
  e(M1, 'Amex OptBlue Fee', '12.00', '6.00', '6.00'),
  e(M1, 'BIN Sponsorship Fees', '607.50', '3.40', '604.10'),

  e(M2, 'Cash Disc/Surcharge Program', '186.00', '0.00', '186.00'),
  e(M2, 'BIN Sponsorship Fees', '0.00', '5.50', '-5.50', ['NEGATIVE_NET_REVENUE'], ORANGE),
  e(M2, 'Amex OptBlue Fee', '4.00', '2.00', '2.00'),
  e(M2, 'Authorization Fee IP/SSL', '6.75', '2.25', '4.50'),
  e(M2, 'Chargeback Fee', '35.00', '25.00', '10.00'),
  e(M2, 'PCI Program', '0.00', '5.00', '-5.00', ['NEGATIVE_NET_REVENUE'], ORANGE),
  e(M2, 'Card Brand Fees V/MC/D/PP', '-12.34', '0.00', '-12.34', ['NEGATIVE_NET_REVENUE'], ORANGE),
  e(M2, 'Monthly Fee', '19.99', '7.00', '12.99'),

  e(M3, 'BIN Sponsorship Fees', '215.00', '1.80', '213.20', ['REPORTED_ABOVE_INCOME', 'VOLUME_MISMATCH'], RED),
  e(M3, 'Authorization Fee IP/SSL', '9.60', '2.40', '7.20', ['VOLUME_MISMATCH'], RED),
  e(M3, 'Monthly Fee', '14.95', '4.00', '10.95', ['VOLUME_MISMATCH'], RED),
  e(M3, 'Monthly Online Access Fee', '0.00', '6.50', '-6.50', ['NEGATIVE_NET_REVENUE', 'VOLUME_MISMATCH'], RED),

  e(M4, 'Monthly Fee', null, null, null, ['RISK_LEVEL_BLANK'], RED),
  e(M5, 'AVS Fee', null, null, null, ['NO_STATEMENT'], RED),

  e(M6, 'Accept Blue Monthly', '15.00', '10.00', '5.00', ['AGENT_EXPENSE_NONZERO'], ORANGE),
  e(M6, 'USA ePay Monthly Fee - Gold', '0.00', '20.00', '-20.00', ['NEGATIVE_NET_REVENUE'], ORANGE),
  e(M6, 'Accept.blue Per Item Total', '3.00', '1.50', '1.50'),
  e(M6, 'Accept Blue Setup', '49.99', '49.99', '0.00'),
  e(
    M6,
    'Valor Portal Access',
    '0.00',
    '4.95',
    '-4.95',
    ['AGENT_EXPENSE_NONZERO', 'NEGATIVE_NET_REVENUE', 'NO_EQUIPMENT_ROW'],
    ORANGE,
  ),
  e(M6, 'Credit/Refund', null, '0.00', null, ['CREDIT_REFUND', 'NEGATIVE_NET_REVENUE'], ORANGE),
  e(M6, 'Mystery Fee', null, null, null, ['UNKNOWN_FEE_ITEM'], ORANGE),
  e(M6, 'Equipment & Supplies', '0.00', null, null, ['EQUIPMENT_SUPPLIES_REVIEW'], ORANGE),

  e(M7, 'Monthly Fee', null, null, null, ['MID_NOT_IN_CRM'], ORANGE),
];

export type ExpectedAcquiringMid = {
  mid: string;
  calculated: boolean;
  riskLevel: RiskLevel | null;
  volumes: { vmd: Money; amex: Money; debit: Money; ebt: Money } | null;
  income: Money | null;
  percentage: Rate | null;
  netIncome: Money | null;
  flags: string[];
};

export const ACQUIRING_EXPECTED_MIDS: ExpectedAcquiringMid[] = [
  {
    mid: M1,
    calculated: true,
    riskLevel: 'moderate_risk',
    volumes: { vmd: '15000.00', amex: '4000.00', debit: '2000.00', ebt: '0.00' },
    income: '642.62',
    percentage: '0.80',
    netIncome: '514.10', // 642.62 × 0.80 = 514.096
    flags: [],
  },
  {
    mid: M2,
    calculated: true,
    riskLevel: 'high_risk',
    volumes: { vmd: '3000.00', amex: '1000.00', debit: '500.00', ebt: '0.00' },
    income: '192.65',
    percentage: '0.70',
    netIncome: '134.86',
    flags: ['AGENT_PCT_MISMATCH'],
  },
  {
    mid: M3,
    calculated: true,
    riskLevel: 'low_risk',
    volumes: { vmd: '8000.00', amex: '0.00', debit: '1000.00', ebt: '0.00' },
    income: '224.85',
    percentage: '0.90',
    netIncome: '202.37',
    flags: ['UNKNOWN_PLAN_CODE', 'VOLUME_MISMATCH'],
  },
  {
    mid: M4,
    calculated: false,
    riskLevel: null,
    volumes: { vmd: '100.00', amex: '0.00', debit: '0.00', ebt: '0.00' },
    income: null,
    percentage: null,
    netIncome: null,
    flags: ['RISK_LEVEL_BLANK'],
  },
  {
    mid: M5,
    calculated: false,
    riskLevel: 'low_risk',
    volumes: null,
    income: null,
    percentage: null,
    netIncome: null,
    flags: ['NO_STATEMENT'],
  },
  {
    mid: M6,
    calculated: true,
    riskLevel: 'moderate_risk',
    volumes: { vmd: '0.00', amex: '0.00', debit: '0.00', ebt: '0.00' },
    income: '-18.45',
    percentage: '0.80',
    netIncome: '-18.45',
    flags: [],
  },
  {
    mid: M7,
    calculated: false,
    riskLevel: null,
    volumes: null,
    income: null,
    percentage: null,
    netIncome: null,
    flags: ['MID_NOT_IN_CRM'],
  },
];

/** 514.10 + 134.86 + 202.37 − 18.45 */
export const ACQUIRING_EXPECTED_TOTAL = '832.88';
