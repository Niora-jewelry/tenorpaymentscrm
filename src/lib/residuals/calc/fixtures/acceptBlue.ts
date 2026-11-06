/**
 * Accept.blue test month (August 2026; the report's Month cell is the Excel
 * date serial 46235). This report includes the Setup Fee ISO column, plus one
 * column the spec does not list ("Mystery Fee ISO").
 *
 *   B1   ties out (mirrors the spec's first worked example)
 *   B2   report MID has the extra trailing 0 (12 digits vs the CRM's 11)
 *   B3   ERTCFunding LLC: no MID on the report, CRM MID 30119801440
 *   B4   charged more than the CRM says (monthly group and setup, both red)
 *        and a card-updater charge over $5 (orange, still counted)
 *   B5   Accept.blue row billed to the Merchant, not ISO
 *   B6   MID not in the CRM
 *   B7   in the CRM but no Accept.blue row
 *   B8   has an Accept.blue/ISO row but is missing from the report
 *   B9   charged less than the CRM says (green)
 *   B10  a 0.01 difference (inside the 0.02 tolerance) and an unlisted column
 *
 * Names and MIDs are made up, except ERTCFunding LLC → 30119801440, which the
 * spec makes a matching rule the engine itself must apply.
 */
import type { AcceptBlueAmounts, AcceptBlueInput, AcceptBlueReportRow, EquipmentRow, Money } from '../types';

const row = (
  name: string,
  mid: string | null,
  o: Partial<Omit<AcceptBlueReportRow, 'name' | 'mid'>>,
): AcceptBlueReportRow => ({
  name,
  mid,
  setupFeeIso: '0.00',
  monthlyGatewayFeeIso: '0.00',
  transactionFeeIso: '0.00',
  transactionCount: '0',
  paymentPagesIso: '0.00',
  cardUpdaterMonthlyIso: '0.00',
  cardUpdaterPerUpdateIso: '0.00',
  dafTransactionFeeIso: '0.00',
  isoTotal: '0.00',
  otherColumns: {},
  ...o,
});

const ab = (monthlyFee: Money | null, perItemFee: Money | null, oneTimeFee: Money | null = null, billedTo = 'ISO'): EquipmentRow => ({
  provider: 'Accept.blue',
  billedBy: 'Accept.blue',
  billedTo,
  monthlyFee,
  perItemFee,
  oneTimeFee,
});

export const ACCEPT_BLUE_INPUT: AcceptBlueInput = {
  month: '2026-08',
  reportMonth: 46235,
  reportRows: [
    row('Bluebird Hardware', '201100000001', {
      monthlyGatewayFeeIso: '15.00',
      paymentPagesIso: '5.00',
      transactionFeeIso: '17.20',
      transactionCount: '344',
      isoTotal: '37.20',
    }),
    row('Maple Street Cafe', '301198000020', {
      monthlyGatewayFeeIso: '15.00',
      transactionFeeIso: '3.00',
      transactionCount: '60',
      dafTransactionFeeIso: '0.05',
      isoTotal: '18.05',
    }),
    row('ERTCFunding LLC', null, {
      monthlyGatewayFeeIso: '15.00',
      transactionFeeIso: '0.75',
      transactionCount: '15',
      isoTotal: '15.75',
    }),
    row('Overcharged Services LLC', '201100000004', {
      setupFeeIso: '59.99',
      monthlyGatewayFeeIso: '15.00',
      paymentPagesIso: '25.00',
      cardUpdaterPerUpdateIso: '7.50',
      isoTotal: '107.49',
    }),
    row('Billed Elsewhere Co', '201100000005', { monthlyGatewayFeeIso: '15.00', isoTotal: '15.00' }),
    row('Not In CRM Inc', '201100000099', { monthlyGatewayFeeIso: '15.00', isoTotal: '15.00' }),
    row('No AB Row LLC', '201100000007', { monthlyGatewayFeeIso: '10.00', isoTotal: '10.00' }),
    row('Undercharged Co', '201100000009', {
      monthlyGatewayFeeIso: '15.00',
      transactionFeeIso: '1.00',
      transactionCount: '10',
      isoTotal: '16.00',
    }),
    row('Penny Off LLC', '201100000010', {
      monthlyGatewayFeeIso: '10.00',
      transactionFeeIso: '0.24',
      transactionCount: '7',
      isoTotal: '12.24',
      otherColumns: { 'Mystery Fee ISO': '2.00' },
    }),
  ],
  merchants: [
    { mid: '201100000001', equipment: [ab('20.00', '0.05')] },
    { mid: '30119800002', equipment: [ab('15.00', '0.05')] },
    { mid: '30119801440', equipment: [ab('15.00', '0.05')] },
    { mid: '201100000004', equipment: [ab('15.00', '0.05', '49.99')] },
    { mid: '201100000005', equipment: [ab('15.00', '0.05', null, 'Merchant')] },
    {
      mid: '201100000007',
      equipment: [{ provider: 'NMI', billedBy: 'NMI', billedTo: 'ISO', monthlyFee: '10.00', perItemFee: null, oneTimeFee: null }],
    },
    { mid: '201100000008', equipment: [ab('15.00', '0.05')] },
    { mid: '201100000009', equipment: [ab('20.00', '0.10')] },
    { mid: '201100000010', equipment: [ab('10.00', '0.033')] },
  ],
};

const amounts = (
  setup: Money | null,
  monthly: Money,
  transaction: Money,
  cardUpdaterPerUpdate: Money,
  daf: Money,
  total: Money,
): AcceptBlueAmounts => ({ setup, monthly, transaction, cardUpdaterPerUpdate, daf, total });

export type ExpectedAcceptBlueMerchant = {
  name: string;
  reportMid: string | null;
  mid: string | null;
  matchedBy: 'exact' | 'trailing_zero' | 'name_exception' | null;
  expected: AcceptBlueAmounts | null;
  charged: AcceptBlueAmounts;
  isoTotal: Money;
  /** "CODE" or "CODE:field" */
  flags: string[];
};

export const ACCEPT_BLUE_EXPECTED_MERCHANTS: ExpectedAcceptBlueMerchant[] = [
  {
    name: 'Bluebird Hardware',
    reportMid: '201100000001',
    mid: '201100000001',
    matchedBy: 'exact',
    // setup is not compared (report Setup Fee ISO is 0); 344 × 0.05 = 17.20
    expected: amounts(null, '20.00', '17.20', '0.00', '0.00', '37.20'),
    charged: amounts('0.00', '20.00', '17.20', '0.00', '0.00', '37.20'),
    isoTotal: '37.20',
    flags: [],
  },
  {
    name: 'Maple Street Cafe',
    reportMid: '301198000020',
    mid: '30119800002',
    matchedBy: 'trailing_zero',
    // DAF 0.05 is under $5: accepted and counted
    expected: amounts(null, '15.00', '3.00', '0.00', '0.05', '18.05'),
    charged: amounts('0.00', '15.00', '3.00', '0.00', '0.05', '18.05'),
    isoTotal: '18.05',
    flags: [],
  },
  {
    name: 'ERTCFunding LLC',
    reportMid: null,
    mid: '30119801440',
    matchedBy: 'name_exception',
    expected: amounts(null, '15.00', '0.75', '0.00', '0.00', '15.75'),
    charged: amounts('0.00', '15.00', '0.75', '0.00', '0.00', '15.75'),
    isoTotal: '15.75',
    flags: [],
  },
  {
    name: 'Overcharged Services LLC',
    reportMid: '201100000004',
    mid: '201100000004',
    matchedBy: 'exact',
    // 49.99 + 15.00 + 0.00 + 7.50 (reported, counted) + 0.00
    expected: amounts('49.99', '15.00', '0.00', '7.50', '0.00', '72.49'),
    charged: amounts('59.99', '40.00', '0.00', '7.50', '0.00', '107.49'),
    isoTotal: '107.49',
    flags: ['CALC_BELOW_CHARGED:monthly', 'CALC_BELOW_CHARGED:setup', 'OVER_5_REVIEW:cardUpdaterPerUpdate'],
  },
  {
    name: 'Billed Elsewhere Co',
    reportMid: '201100000005',
    mid: '201100000005',
    matchedBy: 'exact',
    expected: null,
    charged: amounts('0.00', '15.00', '0.00', '0.00', '0.00', '15.00'),
    isoTotal: '15.00',
    flags: ['AB_NOT_BILLED_TO_ISO'],
  },
  {
    name: 'Not In CRM Inc',
    reportMid: '201100000099',
    mid: null,
    matchedBy: null,
    expected: null,
    charged: amounts('0.00', '15.00', '0.00', '0.00', '0.00', '15.00'),
    isoTotal: '15.00',
    flags: ['MID_NOT_IN_CRM'],
  },
  {
    name: 'No AB Row LLC',
    reportMid: '201100000007',
    mid: '201100000007',
    matchedBy: 'exact',
    expected: null,
    charged: amounts('0.00', '10.00', '0.00', '0.00', '0.00', '10.00'),
    isoTotal: '10.00',
    flags: ['NO_AB_ROW'],
  },
  {
    name: 'Undercharged Co',
    reportMid: '201100000009',
    mid: '201100000009',
    matchedBy: 'exact',
    expected: amounts(null, '20.00', '1.00', '0.00', '0.00', '21.00'),
    charged: amounts('0.00', '15.00', '1.00', '0.00', '0.00', '16.00'),
    isoTotal: '16.00',
    flags: ['CALC_ABOVE_CHARGED:monthly'],
  },
  {
    name: 'Penny Off LLC',
    reportMid: '201100000010',
    mid: '201100000010',
    matchedBy: 'exact',
    // 7 × 0.033 = 0.231 → 0.23 vs 0.24 charged: 0.01, inside the 0.02 tolerance
    expected: amounts(null, '10.00', '0.23', '0.00', '0.00', '10.23'),
    charged: amounts('0.00', '10.00', '0.24', '0.00', '0.00', '10.24'),
    isoTotal: '12.24',
    flags: ['UNRECOGNIZED_COLUMN:Mystery Fee ISO'],
  },
];

export const ACCEPT_BLUE_EXPECTED_MISSING = ['201100000008'];
export const ACCEPT_BLUE_EXPECTED_ALERTS = ['MISSING_FROM_REPORT:201100000008', 'UNRECOGNIZED_COLUMN:Mystery Fee ISO'];
/** 37.20 + 18.05 + 15.75 + 72.49 + 21.00 + 10.23 (not set up: $0) */
export const ACCEPT_BLUE_EXPECTED_TOTAL = '174.72';
/** Sum of ISO Total */
export const ACCEPT_BLUE_CHARGED_TOTAL = '246.73';
