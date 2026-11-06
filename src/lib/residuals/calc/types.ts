/**
 * The residual calculator: the contract both engines are held to.
 *
 * Two engines implement this (one in TypeScript, one in Postgres) so the two
 * approaches can be compared on equal terms. Both take the same inputs, must
 * return the same outputs, and run against the same fixtures and test suite
 * (`contract.ts`).
 *
 * Specs: "Acquiring Reconciliation Tab: Spec for Patrick", "Maverick ACH
 * Reconciliation Tab", "Accept.blue Reconciliation Tab: Revised Spec" (all
 * Nov 3, 2026). Where the specs are silent, the choice made here is marked
 * ASSUMPTION and tracked in docs/residuals/open-questions.md.
 *
 * ── NUMBERS ARE TEXT ─────────────────────────────────────────────────────
 * Every amount and rate crosses this boundary as decimal text ("12.30",
 * "0.0015"), never as a JS number, so nothing is lost before an engine sees it.
 * Money results always carry exactly two decimals.
 *
 * Rates are fractions: 0.15% is "0.0015", 80% is "0.80".
 *
 * ── ROUNDING (ASSUMPTION) ────────────────────────────────────────────────
 * Each Merchant payment and Buy rate is computed exactly, then rounded to
 * cents, half away from zero. Income = Merchant payment − Buy rate. A per-MID
 * share (Income × Percentage) is rounded once, to cents, the same way.
 */

export type Money = string;
export type Rate = string;
/** 'YYYY-MM' */
export type Month = string;

export type RiskLevel = 'no_risk' | 'low_risk' | 'moderate_risk' | 'high_risk';

/** Highest priority first: red, orange, light_red, light_green. ACH and Accept.blue use red and green. */
export type FlagColor = 'red' | 'orange' | 'light_red' | 'light_green' | 'green';

/**
 * A problem or note on a row, MID or merchant. `code` is from FLAG_CODES; the
 * message is for people and is not part of the contract. `field` says which
 * part of an Accept.blue row a comparison flag is about.
 */
export type Flag = { code: string; color: FlagColor | null; message: string; field?: string };

/**
 * Every flag code, with the colour it carries. Codes marked ASSUMPTION or
 * PROPOSAL are not in the specs (see docs/residuals/open-questions.md).
 */
export const FLAG_CODES = {
  acquiring: {
    /** Statement volume differs from the report Amount by more than $1. All the MID's rows. */
    VOLUME_MISMATCH: 'red',
    RISK_LEVEL_BLANK: 'red',
    NO_STATEMENT: 'red',
    /** ASSUMPTION: orange, as on Accept.blue. The spec says only "listed in Alerts". */
    MID_NOT_IN_CRM: 'orange',
    UNKNOWN_FEE_ITEM: 'orange',
    CREDIT_REFUND: 'orange',
    NO_EQUIPMENT_ROW: 'orange',
    EQUIPMENT_SUPPLIES_REVIEW: 'orange',
    NEGATIVE_NET_REVENUE: 'orange',
    AGENT_EXPENSE_NONZERO: 'orange',
    /** Calculated Income is more than Net Revenue by over $1. */
    INCOME_ABOVE_REPORTED: 'light_red',
    /** Net Revenue is more than Income by over $1. */
    REPORTED_ABOVE_INCOME: 'light_green',
    /** PROPOSAL: Maverick's Agent % differs from the CRM Risk Level's percentage. Note only. */
    AGENT_PCT_MISMATCH: null,
    /** ASSUMPTION: a statement plan code outside the spec's buckets (e.g. "EB"). Not counted; note only. */
    UNKNOWN_PLAN_CODE: null,
  },
  ach: {
    /** Our Net is higher than the report's Net. */
    OUR_NET_HIGHER: 'red',
    OUR_NET_LOWER: 'green',
    REJECT_FEES_NO_RULE: 'orange',
    NAME_NOT_MATCHED: 'red',
    RISK_LEVEL_BLANK: 'red',
    /** ASSUMPTION: the spec says only that such merchants are not reconciled. */
    ACH_PROVIDER_NOT_MAVERICK: 'orange',
    /** ASSUMPTION: a matched MID with no CRM record. */
    MID_NOT_IN_CRM: 'orange',
    UNKNOWN_FEE_CATEGORY: 'orange',
  },
  acceptBlue: {
    MID_NOT_IN_CRM: 'orange',
    NO_AB_ROW: 'orange',
    AB_NOT_BILLED_TO_ISO: 'orange',
    /** Calculated amount is more than Accept.blue charged. */
    CALC_ABOVE_CHARGED: 'green',
    /** Calculated amount is less than Accept.blue charged. */
    CALC_BELOW_CHARGED: 'red',
    OVER_5_REVIEW: 'orange',
    UNRECOGNIZED_COLUMN: 'orange',
    MULTIPLE_AB_ROWS: null,
    MISSING_FROM_REPORT: 'orange',
    MONTH_MISMATCH: 'orange',
  },
} as const satisfies Record<string, Record<string, FlagColor | null>>;

/* ──────────────────────────────────────────────────────────────────────────
 * Buy Rate Template
 * ────────────────────────────────────────────────────────────────────────── */

/** A template row: one rate per risk level. */
export type TemplateRow = Record<RiskLevel, Rate>;

/** The card (Acquiring) section. Keys follow the spec's row names. */
export type CardTemplate = {
  pciFee: TemplateRow;
  vmdBin: TemplateRow;
  vmdAuthFee: TemplateRow;
  avsFee: TemplateRow;
  monthlyFee: TemplateRow;
  amexOptBlue: TemplateRow;
  monthlyOnlineAccessFee: TemplateRow;
  batchFee: TemplateRow;
  websiteMonitoringFee: TemplateRow;
  irsAnnualFee: TemplateRow;
  chargeback: TemplateRow;
  percentage: TemplateRow;
  iposSpinFeeMonthly: TemplateRow;
  ipospaysTerminalMonthly: TemplateRow;
  acceptBlueMonthly: TemplateRow;
  acceptBlueSetup: TemplateRow;
  acceptBluePerItem: TemplateRow;
  ebtAuthFee: TemplateRow;
  nuvolinq10mbData: TemplateRow;
  usaEpayGold: TemplateRow;
  usaEpaySilver: TemplateRow;
  valorPortalAccess: TemplateRow;
  valorTerminalAddOns: TemplateRow;
};

/** The Maverick ACH section. It has no No Risk column; No Risk uses Low Risk. */
export type AchTemplateRow = Record<'low_risk' | 'moderate_risk' | 'high_risk', Rate>;
export type AchTemplate = {
  transaction: AchTemplateRow;
  achReturn: AchTemplateRow;
  monthly: AchTemplateRow;
  odfiSponsorship: AchTemplateRow;
  debitUnauthorizedFee: AchTemplateRow;
  noc: AchTemplateRow;
};

/* ──────────────────────────────────────────────────────────────────────────
 * Shared CRM inputs
 * ────────────────────────────────────────────────────────────────────────── */

/** One row of the record's Merchant Equipment Setup tab. Blank fees are null and count as $0. */
export type EquipmentRow = {
  provider: string;
  billedBy: string;
  billedTo: string;
  monthlyFee: Money | null;
  perItemFee: Money | null;
  oneTimeFee: Money | null;
};

/* ──────────────────────────────────────────────────────────────────────────
 * Acquiring (Maverick card fee item report)
 * ────────────────────────────────────────────────────────────────────────── */

export type AcquiringReportRow = {
  mid: string;
  feeItemName: string;
  /** 'YYYY-MM'. Rows for other months are ignored. */
  date: Month;
  count: string;
  amount: Money;
  netRevenue: Money;
  agentExpense: Money;
  /** Maverick's percentage, e.g. "90". Not used in the money (the CRM Risk Level is); only compared. */
  agentPct: string;
};

/** Processor-TD Merchant Pricing fields. Null = blank = $0. */
export type CardPricing = {
  amexAuthFee: Rate | null;
  vmdAuthFee: Rate | null;
  pinDebitAuthFee: Rate | null;
  amexVolume: Rate | null;
  vmdVolume: Rate | null;
  pinDebitVolume: Rate | null;
  chargebackFee: Rate | null;
  vmdTransactionFee: Rate | null;
  avsFee: Rate | null;
  batchFee: Rate | null;
  monthlyFee: Rate | null;
  ebtVolume: Rate | null;
  amexOptBlueFee: Rate | null;
  monthlyWebsiteMonitoringFee: Rate | null;
  pciFee: Rate | null;
  ebtAuthFee: Rate | null;
  /** Adjustments section: when set, replaces the template rate for that volume. */
  amexVolumeBuyRateAdjustment: Rate | null;
  vmdVolumeBuyRateAdjustment: Rate | null;
  pinDebitVolumeBuyRateAdjustment: Rate | null;
};

/** One Plan Summary row from the merchant's statement. */
export type StatementPlanRow = { planCode: string; amount: Money; creditAmount: Money };

export type AcquiringMerchant = {
  mid: string;
  /** Null = blank in the CRM: the merchant is not calculated. */
  riskLevel: RiskLevel | null;
  pricing: CardPricing;
  /** Null = no statement for the month. */
  statement: StatementPlanRow[] | null;
  equipment: EquipmentRow[];
};

export type AcquiringInput = {
  month: Month;
  template: CardTemplate;
  reportRows: AcquiringReportRow[];
  merchants: AcquiringMerchant[];
  /** The user's choice when a MID has no statement. False: the MID is not calculated. */
  proceedWithoutStatement: boolean;
};

export type AcquiringRowResult = {
  mid: string;
  feeItemName: string;
  netRevenue: Money;
  /** Null when the row is not calculated. */
  merchantPayment: Money | null;
  buyRate: Money | null;
  income: Money | null;
  flags: Flag[];
  color: FlagColor | null;
};

export type AcquiringMidResult = {
  mid: string;
  calculated: boolean;
  riskLevel: RiskLevel | null;
  /** Statement volumes used (gross sales). Null if there was no statement. */
  volumes: { vmd: Money; amex: Money; debit: Money; ebt: Money } | null;
  income: Money | null;
  percentage: Rate | null;
  /** Sent to the Final Tally as this MID's Acquiring net. */
  netIncome: Money | null;
  flags: Flag[];
};

export type AcquiringResult = {
  rows: AcquiringRowResult[];
  mids: AcquiringMidResult[];
  /** The final Acquiring number: the sum of calculated MIDs' Net income. */
  total: Money;
};

/* ──────────────────────────────────────────────────────────────────────────
 * ACH (Maverick ACH fee item report)
 * ────────────────────────────────────────────────────────────────────────── */

export type AchReportRow = {
  merchantName: string;
  date: Month;
  feeCategory: string;
  /** For Discount this is the dollar volume. */
  count: string;
  net: Money;
};

export type AchMerchant = {
  mid: string;
  riskLevel: RiskLevel | null;
  achProvider: string | null;
  achTransactionFee: Rate | null;
  achReturn: Rate | null;
  achMonthlyGatewayFee: Rate | null;
  achExceptionCorrectionsFee: Rate | null;
  achBin: Rate | null;
};

export type AchInput = {
  month: Month;
  template: AchTemplate;
  reportRows: AchReportRow[];
  /** The remembered name → MID matches (the matching sub-tab). */
  nameMatches: Record<string, string>;
  merchants: AchMerchant[];
};

export type AchRowResult = {
  merchantName: string;
  mid: string | null;
  feeCategory: string;
  reportNet: Money;
  merchantPayment: Money | null;
  buyRate: Money | null;
  net: Money | null;
  split: Money | null;
  flags: Flag[];
  color: FlagColor | null;
};

export type AchMidResult = {
  mid: string;
  calculated: boolean;
  net: Money | null;
  percentage: Rate | null;
  /** Sent to the Final Tally. */
  total: Money | null;
  flags: Flag[];
};

export type AchResult = {
  rows: AchRowResult[];
  mids: AchMidResult[];
  /** Report names with no MID yet: the matching sub-tab's worklist. */
  unmatchedNames: string[];
  total: Money;
};

/* ──────────────────────────────────────────────────────────────────────────
 * Accept.blue
 * ────────────────────────────────────────────────────────────────────────── */

export type AcceptBlueReportRow = {
  name: string;
  /** As text, full digits. Null when the report has none (ERTCFunding LLC). */
  mid: string | null;
  /** Null when the report has no Setup Fee ISO column (August 2026). */
  setupFeeIso: Money | null;
  monthlyGatewayFeeIso: Money;
  transactionFeeIso: Money;
  transactionCount: string;
  paymentPagesIso: Money;
  cardUpdaterMonthlyIso: Money;
  cardUpdaterPerUpdateIso: Money;
  dafTransactionFeeIso: Money;
  isoTotal: Money;
  /** Any report column this spec does not list, with its value. */
  otherColumns: Record<string, Money>;
};

export type AcceptBlueMerchant = { mid: string; equipment: EquipmentRow[] };

export type AcceptBlueInput = {
  month: Month;
  /** The report's Month cell: an Excel date serial (46235) or 'YYYY-MM'. */
  reportMonth: number | string;
  reportRows: AcceptBlueReportRow[];
  merchants: AcceptBlueMerchant[];
};

export type AcceptBlueAmounts = {
  setup: Money | null;
  monthly: Money;
  transaction: Money;
  cardUpdaterPerUpdate: Money;
  daf: Money;
  total: Money;
};

export type AcceptBlueMerchantResult = {
  name: string;
  reportMid: string | null;
  /** The CRM MID it was matched to. */
  mid: string | null;
  matchedBy: 'exact' | 'trailing_zero' | 'name_exception' | null;
  /** Null when not set up (flagged; expected counts as $0). */
  expected: AcceptBlueAmounts | null;
  /** What Accept.blue charged, grouped the same way. `monthly` is the three monthly columns summed. */
  charged: AcceptBlueAmounts;
  /** Sent to the Final Tally. */
  isoTotal: Money;
  flags: Flag[];
};

export type AcceptBlueResult = {
  merchants: AcceptBlueMerchantResult[];
  /** CRM merchants with an Accept.blue row billed to ISO that are not on the report. */
  missingFromReport: string[];
  alerts: Flag[];
  /** Expected Accept.blue Charge: what Accept.blue should have charged. */
  expectedTotal: Money;
  /** Sum of ISO Total: what Accept.blue did charge. */
  chargedTotal: Money;
};

/* ──────────────────────────────────────────────────────────────────────────
 * The engine
 * ────────────────────────────────────────────────────────────────────────── */

export interface ResidualCalcEngine {
  acquiring(input: AcquiringInput): Promise<AcquiringResult>;
  ach(input: AchInput): Promise<AchResult>;
  acceptBlue(input: AcceptBlueInput): Promise<AcceptBlueResult>;
}
