/**
 * What a proposal says, worked out from the record: no server code, so the
 * preview, the send and the tests all use the same arithmetic.
 *
 * Rules (client, "Proposal template Instructions" and "Proposal items", 3 Nov 2026):
 *   Cover            the Legal business name.
 *   Savings Analysis always. Rows Effective Rate, Transaction Fees, Monthly Fees,
 *                    Monthly Totals; columns Item, Current volume, Current rate,
 *                    Current cost, Proposed rate, Proposed cost, Savings:
 *                      Effective rate     cost = volume × rate
 *                      Transaction fees   cost = transactions × auth fee
 *                      Monthly fees       the fees as entered
 *                      Totals             the sums; savings = current − proposed
 *                    then Monthly, Annual (×12) and 3-year (×36) savings.
 *   POS Architecture only when ticked to include and something is filled in.
 *   Detailed POS     only when ticked to include, listing the Merchant Equipment
 *                    Setup rows ticked "Proposal": Product name = Item, else the
 *                    provider, Amount = Item amount, Hardware cost = Per item fee,
 *                    Setup fee = One-time fee, Monthly cost = Amount × Monthly fee.
 *   Closing          the relationship manager's email, else sales@tenorpayments.com.
 */
import { TENOR } from '@/lib/brand/tenor';

export const TENOR_CONTACT = { company: TENOR.company, salesEmail: TENOR.salesEmail, phone: TENOR.phone, address: TENOR.address };

/** Every field a proposal reads: a sender who can't see one can't send it. */
export const PROPOSAL_FIELD_KEYS = [
  'legal_business_name', 'savings_description',
  'prior_monthly_volume', 'prior_effective_rate', 'tenor_effective_rate',
  'prior_monthly_transactions', 'prior_auth_fees', 'tenor_auth_fees', 'prior_monthly_fees', 'tenor_monthly_fees',
  'pos_in_proposal', 'pos_description', 'merchant_requirements', 'tenor_features',
  'pos_detail_in_proposal',
] as const;

/** The inputs of the Savings Analysis table. */
export const SAVINGS_INPUTS = [
  'prior_monthly_volume', 'prior_effective_rate', 'tenor_effective_rate',
  'prior_monthly_transactions', 'prior_auth_fees', 'tenor_auth_fees', 'prior_monthly_fees', 'tenor_monthly_fees',
] as const;

export const DEFAULT_SAVINGS_DESCRIPTION =
  'The savings outlined in this analysis are based on our review of the processing statement(s) we received. We assume this statement is representative of typical monthly processing activity. Actual savings may vary from month to month based on volume, ticket size, card mix and customer payment preferences.';

/** The template's own words, TapDash → Tenor (client, 3 Nov 2026). */
export const DEFAULT_POS_DESCRIPTION =
  'Tenor is a full-service payment processor built to integrate seamlessly with a wide range of POS systems. Based on your requirements, we’ve outlined a recommended POS solution below that aligns with your workflow and growth goals. While this is our recommended solution, Tenor is highly integrable. If you prefer to use a different POS, we can typically support it as long as the platform allows processor integrations—giving you flexibility without limiting your options.';
export const TAGLINE = 'Transparent pricing. Measurable savings.';
/** "Processing fees eliminated. Profits maximized." was to go (client): the cover's own line replaces it. */
export const HEADLINE = 'Real support. Real results. Real savings.';
export const MISSION =
  'At Tenor, we believe processing shouldn’t drain your profits—it should fuel your growth. Our mission is simple: eliminate the complexity and cost of payment processing while delivering transparent, cutting-edge solutions that scale with your business. No hidden fees. No surprises. Just honest partnerships built on integrity and results.';

export type SavingsRow = {
  item: string;
  /** Money for the effective-rate row, a count of transactions for the fees row. */
  volume: number | null;
  volumeKind: 'money' | 'count' | null;
  currentRate: number | null;
  proposedRate: number | null;
  /** Percent for the effective-rate row, money per transaction for the fees row. */
  rateKind: 'percent' | 'money' | null;
  currentCost: number;
  proposedCost: number;
  savings: number;
};

export type ChecklistItem = { text: string; check: boolean };
export type PosRow = { product: string; amount: number | null; hardwareCost: number | null; setupFee: number | null; monthlyCost: number | null };

export type ProposalContent = {
  version: 1;
  merchantName: string;
  preparedOn: string;
  savings: {
    description: string;
    rows: SavingsRow[];
    totals: { currentCost: number; proposedCost: number; savings: number };
    monthly: number;
    annual: number;
    threeYear: number;
  };
  pos: { description: string; requirements: ChecklistItem[]; features: ChecklistItem[] } | null;
  detailedPos: { rows: PosRow[] } | null;
  closing: { email: string; phone: string; address: string; company: string };
};

/** "1,234.50", "$12", 12, "2.5%" → a number; blank or nonsense → null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[$,%\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const rows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object') : [];
export const ticked = (v: unknown) => v === true || v === 'Yes' || v === 'yes' || v === 'true';

export function checklist(v: unknown, textColumn: string): ChecklistItem[] {
  return rows(v)
    .map((r) => ({ text: text(r[textColumn]), check: ticked(r.Check) }))
    .filter((r) => r.text);
}

/** One Merchant Equipment Setup row, as the sender may see it. A hidden column is absent. */
export type EquipmentLine = {
  provider?: unknown;
  item?: unknown;
  amount?: unknown;
  monthlyFee?: unknown;
  perItemFee?: unknown;
  oneTimeFee?: unknown;
  proposal?: unknown;
};

export function posRows(lines: readonly EquipmentLine[]): PosRow[] {
  return lines
    .filter((r) => ticked(r.proposal))
    .map((r) => {
      const amount = num(r.amount);
      const monthly = num(r.monthlyFee);
      return {
        product: text(r.item) || text(r.provider),
        amount,
        hardwareCost: num(r.perItemFee),
        setupFee: num(r.oneTimeFee),
        monthlyCost: monthly === null ? null : cents((amount ?? 1) * monthly),
      };
    })
    .filter((r) => r.product || r.amount !== null || r.monthlyCost !== null);
}

/** Whether any figure of the Savings Analysis has been filled in. */
export function hasSavingsFigures(values: Record<string, unknown>): boolean {
  return SAVINGS_INPUTS.some((k) => num(values[k]) !== null);
}

export function buildProposal(
  values: Record<string, unknown>,
  opts: { dealName: string; relationshipManagerEmail: string | null; preparedOn: Date; equipment?: readonly EquipmentLine[] },
): ProposalContent {
  const vol = num(values.prior_monthly_volume);
  const priorRate = num(values.prior_effective_rate);
  const tenorRate = num(values.tenor_effective_rate);
  const tx = num(values.prior_monthly_transactions);
  const priorAuth = num(values.prior_auth_fees);
  const tenorAuth = num(values.tenor_auth_fees);
  const priorMonthly = num(values.prior_monthly_fees) ?? 0;
  const tenorMonthly = num(values.tenor_monthly_fees) ?? 0;

  const effCurrent = cents((vol ?? 0) * ((priorRate ?? 0) / 100));
  const effProposed = cents((vol ?? 0) * ((tenorRate ?? 0) / 100));
  const txCurrent = cents((tx ?? 0) * (priorAuth ?? 0));
  const txProposed = cents((tx ?? 0) * (tenorAuth ?? 0));
  const savingsRows: SavingsRow[] = [
    { item: 'Effective Rate', volume: vol, volumeKind: 'money', currentRate: priorRate, proposedRate: tenorRate, rateKind: 'percent',
      currentCost: effCurrent, proposedCost: effProposed, savings: cents(effCurrent - effProposed) },
    { item: 'Transaction Fees', volume: tx, volumeKind: 'count', currentRate: priorAuth, proposedRate: tenorAuth, rateKind: 'money',
      currentCost: txCurrent, proposedCost: txProposed, savings: cents(txCurrent - txProposed) },
    { item: 'Monthly Fees', volume: null, volumeKind: null, currentRate: null, proposedRate: null, rateKind: null,
      currentCost: cents(priorMonthly), proposedCost: cents(tenorMonthly), savings: cents(priorMonthly - tenorMonthly) },
  ];
  const currentCost = cents(savingsRows.reduce((n, r) => n + r.currentCost, 0));
  const proposedCost = cents(savingsRows.reduce((n, r) => n + r.proposedCost, 0));
  const monthly = cents(currentCost - proposedCost);

  const description = text(values.pos_description);
  const requirements = checklist(values.merchant_requirements, 'Requirement');
  const features = checklist(values.tenor_features, 'Feature');
  // "Solely based on whether the POS tab has info", and ticked to include.
  const pos = ticked(values.pos_in_proposal) && (description || requirements.length || features.length)
    ? { description: description || DEFAULT_POS_DESCRIPTION, requirements, features }
    : null;
  const posList = posRows(opts.equipment ?? []);
  const detailedPos = ticked(values.pos_detail_in_proposal) && posList.length ? { rows: posList } : null;

  return {
    version: 1,
    merchantName: text(values.legal_business_name) || opts.dealName,
    preparedOn: opts.preparedOn.toISOString().slice(0, 10),
    savings: {
      description: text(values.savings_description) || DEFAULT_SAVINGS_DESCRIPTION,
      rows: savingsRows,
      totals: { currentCost, proposedCost, savings: monthly },
      monthly,
      annual: cents(monthly * 12),
      threeYear: cents(monthly * 36),
    },
    pos,
    detailedPos,
    closing: {
      email: opts.relationshipManagerEmail?.trim() || TENOR_CONTACT.salesEmail,
      phone: TENOR_CONTACT.phone,
      address: TENOR_CONTACT.address,
      company: TENOR_CONTACT.company,
    },
  };
}

// ── words on the page ─────────────────────────────────────────────────────────
export const money = (n: number | null, opts: { blank?: string } = {}) =>
  n === null ? opts.blank ?? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const percent = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: 3 })}%`);
export const count = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 0 }));
