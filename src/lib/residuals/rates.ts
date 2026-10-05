/**
 * A merchant's rates — the field vocabulary, client-safe.
 *
 * No imports, nothing that runs. Same reason as `reconciliation.ts`: the rate
 * editor is a client component, and a label map is a runtime value that would
 * drag `server-only` into the browser bundle if it lived beside the queries.
 *
 * ── THESE ARE THE SELL SIDE ──────────────────────────────────────────────
 * What the MERCHANT pays TapDash. The buy side — what the processor charges
 * TapDash — is the template schedule in `residual_buy_rates` and is not
 * editable per merchant. Confusing the two would be expensive: the engine
 * computes income from these and cost from those, and swapping one for the
 * other produces a number that looks entirely reasonable.
 *
 * ── A BLANK IS NOT A ZERO, AND THE DIFFERENCE IS LOAD-BEARING ────────────
 * Daniel's contract, kept verbatim because the sentence is the specification:
 *
 *   "A merchant with no AVS arrangement has no AVS rate, and NULL says that;
 *    0.000000 would assert a rate of zero, which is a different claim and one
 *    the engine would multiply by a count and book as real."
 *
 * So the form submits `null` for an empty field, never `0`, and the engine
 * treats a NULL rate as a reason to skip the line and record why rather than
 * as free.
 */

/** One editable rate or provider field. */
export type RateField = {
  key: string;
  label: string;
  hint?: string;
  /** 'rate' is a per-item or per-dollar figure; 'money' is a flat charge. */
  kind: 'rate' | 'money' | 'text';
};

/**
 * Grouped the way the operator thinks about them, not the way the table
 * stores them.
 *
 * `monthly_fee_maverick` sits in its own group because of a decision rather
 * than a category: Maverick no longer collects the merchant monthly fee, so
 * the live registry does not read it. It is still editable because months
 * before the changeover are priced by the predecessor registry, which does.
 */
export const RATE_GROUPS: { title: string; note?: string; fields: RateField[] }[] = [
  {
    title: 'Per-item fees',
    note: 'Multiplied by the item count the statement reports.',
    fields: [
      { key: 'vmd_auth_fee', label: 'VMD auth fee', kind: 'rate', hint: 'Visa / Mastercard / Discover authorisations.' },
      { key: 'pin_debit_auth_fee', label: 'PIN debit auth fee', kind: 'rate' },
      { key: 'avs_fee', label: 'AVS fee', kind: 'rate' },
      { key: 'batch_fee', label: 'Batch fee', kind: 'rate' },
      { key: 'vmd_transaction_fee', label: 'VMD transaction fee', kind: 'rate' },
      { key: 'chargeback_fee', label: 'Chargeback fee', kind: 'money' },
    ],
  },
  {
    title: 'Volume rates',
    note: 'Applied to the volume buckets from the PDF statement, not to a count.',
    fields: [
      { key: 'vmd_volume', label: 'VMD volume', kind: 'rate' },
      { key: 'amex_volume', label: 'Amex volume', kind: 'rate' },
      { key: 'pin_debit_volume', label: 'PIN debit volume', kind: 'rate' },
      {
        key: 'amex_template_volume_fee',
        label: 'Amex template volume fee',
        kind: 'rate',
        hint: 'The OptBlue template rate, where it differs from the merchant’s own.',
      },
    ],
  },
  {
    title: 'Monthly charges',
    fields: [
      {
        key: 'monthly_fee_tapdash',
        label: 'Monthly fee (TapDash)',
        kind: 'money',
        hint: 'Billed by TapDash directly, so it is additional income OUTSIDE the processor’s split.',
      },
      {
        key: 'monthly_fee_maverick',
        label: 'Monthly fee (Maverick)',
        kind: 'money',
        hint: 'Only read for months before the changeover — Maverick no longer collects this.',
      },
      { key: 'gateway_monthly_mav', label: 'Gateway monthly', kind: 'money' },
      { key: 'terminal_monthly_mav', label: 'Terminal monthly', kind: 'money' },
    ],
  },
  {
    title: 'Providers',
    note: 'Which vendor the gateway and terminal come from. Used to look up vendor costs, not to compute income.',
    fields: [
      { key: 'gateway_provider_mav', label: 'Gateway provider', kind: 'text' },
      { key: 'terminal_provider_mav', label: 'Terminal provider', kind: 'text' },
    ],
  },
];

/** Every editable key, in one flat list. */
export const RATE_KEYS: readonly string[] = RATE_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

/** key -> field, for looking one up by the name a failure reports. */
export const RATE_FIELD: Record<string, RateField> = Object.fromEntries(
  RATE_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f] as const)),
);

/**
 * The four risk levels, and what each one costs.
 *
 * ── THE TIER IS THE MOST EXPENSIVE FIELD ON THIS FORM ────────────────────
 * It selects the split percentage, which multiplies EVERY line. Ninety per
 * cent versus seventy per cent of a month is the single largest thing on the
 * screen that can be quietly wrong, which is why
 * `residual_tier_from_pricing_choice` returns NULL for an unrecognised value
 * rather than guessing, and why the options here are a closed list.
 */
export const RISK_TIERS: { key: string; label: string }[] = [
  { key: 'no_program', label: 'No risk' },
  { key: 'low', label: 'Low risk' },
  { key: 'medium', label: 'Moderate risk' },
  { key: 'high', label: 'High risk' },
];

/** The standing rate row, as `residual_merchant_rate_editor` returns it. */
export type StandingRate = {
  id: string;
  mid: string;
  risk_tier: string | null;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
} & Record<string, string | number | null>;

export type RateEditorData = {
  mid: string;
  /** Null when no rate row covers the month being looked at. */
  standing: StandingRate | null;
  /**
   * True when a calculated month depends on this row.
   *
   * A locked row cannot be edited in place — a change would silently restate a
   * month somebody has already read. The successor path is still open, which
   * is the whole point of dating the rows.
   */
  isLocked: boolean;
  /** How many statement lines this merchant has in the period. */
  lineCount: number;
  /** How many dated versions exist. More than one means a rate has changed. */
  versionCount: number;
  /** Rate key -> why the engine could not use it. */
  fieldFailures: Record<string, string>;
  /** Set when the merchant was skipped whole, naming the reason. */
  merchantFailure: string | null;
  /** Vendor providers the gateway/terminal fields can name. */
  vendorProviders: string[];
  period: string | null;
};

/** Reason codes the engine records, in words. */
export const FAILURE_REASON: Record<string, string> = {
  no_merchant_rates: 'No rates on file for this month',
  no_rate: 'The rate this rule needs is blank',
  no_buy_rate: 'No buy rate on file for the fee item at this tier',
  no_tier: 'No risk level set, so the split percentage is unknown',
  no_volumes: 'No volume figures for the month',
  no_rule: 'The fee item matches no calculation rule',
  no_registry: 'No calculation rules in force for that month',
};
