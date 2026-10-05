'use server';

/**
 * Entering a merchant's rates for a statement month.
 *
 * ── THIS IS THE PATH THAT UN-BLOCKS A PAST MONTH ─────────────────────────
 * The Pricing tab sync writes rates effective from the CURRENT month
 * (`date_trunc('month', now())`), so it cannot reach a statement for May. A
 * blocked merchant on a past month is only fixable by naming the effective
 * date, which is what `residual_supersede_merchant_rate` takes and what these
 * actions pass through.
 *
 * ── RATES CROSS AS TEXT ──────────────────────────────────────────────────
 * Every value is parsed as a STRING here and handed to the RPC as one, which
 * casts to `numeric(14,6)`. A rate is multiplied by an item count, so a
 * sixth-decimal error from a float round trip becomes real money on a merchant
 * with forty thousand authorisations. The Zod schema therefore validates the
 * SHAPE of a decimal and never calls `Number`.
 *
 * ── AN EMPTY FIELD IS NULL ───────────────────────────────────────────────
 * Not zero. "A merchant with no AVS arrangement has no AVS rate, and NULL says
 * that; 0.000000 would assert a rate of zero, which is a different claim and
 * one the engine would multiply by a count and book as real." The empty string
 * is normalised to null in `lib/records/residualRates.ts`, once.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { rateEditor, supersedeRates, updateRateRow } from '@/lib/records/residualRates';
import { RATE_KEYS, RISK_TIERS, type RateEditorData } from '@/lib/residuals/rates';

export type RateActionResult = { ok: boolean; message: string };

/**
 * Loads one merchant's rates on demand.
 *
 * ── WHY ON DEMAND AND NOT WITH THE PAGE ──────────────────────────────────
 * `residual_merchant_rate_editor` is one call per merchant and returns the
 * whole standing row plus the engine's per-field failures. Fetching it for
 * every merchant in a month would be thirty-odd round trips to render a form
 * nobody has opened, on the page that already makes one call per period for
 * its state. It is fetched when the operator asks for it.
 *
 * The period is passed because that is what makes `field_failures` and
 * `merchant_failure` mean anything: they are the engine's record of which rate
 * it wanted for THAT month. Without it they come back empty, which would read
 * as "nothing wrong" rather than "not asked".
 */
export async function loadRateEditorAction(
  periodId: string,
  mid: string,
): Promise<{ ok: true; data: RateEditorData } | { ok: false; message: string }> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const parsed = z
    .object({ periodId: z.string().uuid(), mid: z.string().trim().min(1).max(32) })
    .safeParse({ periodId, mid });
  if (!parsed.success) return { ok: false, message: 'That is not a merchant.' };

  try {
    const data = await rateEditor(ctx, parsed.data.mid, parsed.data.periodId);
    return { ok: true, data };
  } catch (e) {
    console.error('[residuals] loading the rate editor failed', e);
    return { ok: false, message: e instanceof Error ? e.message : 'Those rates could not be read.' };
  }
}

/**
 * A decimal, as text, or blank.
 *
 * Deliberately not `z.coerce.number()`: coercing would put the value through a
 * float on the way to a string, which is the exact round trip the whole module
 * avoids. This checks the shape and passes the characters along.
 *
 * Negative is allowed. A rebate is a real thing in this data — two Interchange
 * rows in the May sample carry a positive net revenue, which under the mirror
 * rule is a legitimately negative buy rate — and there is deliberately no
 * CHECK forbidding one in the schema either.
 */
const DECIMAL = z
  .string()
  .trim()
  .refine((v) => v === '' || /^-?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(v), {
    message: 'Rates are plain decimals, up to six places — no currency symbols or thousands marks.',
  });

const TIER = z.enum(RISK_TIERS.map((t) => t.key) as [string, ...string[]]);

/** Day 1 of a month: the rate tables are dated to month boundaries. */
const MONTH = z.string().regex(/^\d{4}-\d{2}-01$/, 'Pick the month the rates take effect from.');

/** The rate fields, each optional and each a decimal-shaped string. */
const VALUES = z.record(z.string(), DECIMAL);

function readValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of RATE_KEYS) {
    const v = formData.get(k);
    out[k] = typeof v === 'string' ? v : '';
  }
  return out;
}

/**
 * The two provider fields are free text, not decimals.
 *
 * They name a vendor so the vendor-cost lookup can find a card. Validating
 * them as decimals would reject every real value, which is why they are pulled
 * out of `VALUES` before it is parsed.
 */
const TEXT_KEYS = ['gateway_provider_mav', 'terminal_provider_mav'] as const;

export async function supersedeRatesAction(
  periodId: string,
  mid: string,
  formData: FormData,
): Promise<RateActionResult> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const ids = z
    .object({ periodId: z.string().uuid(), mid: z.string().trim().min(1).max(32) })
    .safeParse({ periodId, mid });
  if (!ids.success) return { ok: false, message: 'That is not a merchant.' };

  const month = MONTH.safeParse(formData.get('effective_from'));
  if (!month.success) return { ok: false, message: month.error.issues[0].message };

  const tier = TIER.safeParse(formData.get('risk_tier'));
  if (!tier.success) {
    /*
     * Said as a sentence because of what it costs. The tier selects the split
     * percentage, which multiplies every line — 90% versus 70% of a month is
     * the largest thing on this form that can be quietly wrong, which is why
     * `residual_tier_from_pricing_choice` returns NULL for an unrecognised
     * value rather than guessing.
     */
    return {
      ok: false,
      message: 'Pick a risk level. It sets the split percentage, which applies to every line.',
    };
  }

  const raw = readValues(formData);
  const text: Record<string, string> = {};
  for (const k of TEXT_KEYS) {
    text[k] = raw[k] ?? '';
    delete raw[k];
  }

  const values = VALUES.safeParse(raw);
  if (!values.success) {
    const issue = values.error.issues[0];
    const field = String(issue.path[0] ?? 'A rate');
    return { ok: false, message: `${field}: ${issue.message}` };
  }

  const notes = formData.get('notes');

  const r = await supersedeRates(
    ctx,
    ids.data.mid,
    month.data,
    tier.data,
    { ...values.data, ...text },
    typeof notes === 'string' ? notes : null,
  );

  if (!r.ok) return { ok: false, message: r.message };

  revalidatePath(`/admin/residuals/${ids.data.periodId}`);
  return {
    ok: true,
    message: r.closedPrevious
      ? `Rates set from ${r.effectiveFrom}. The previous rates were closed on that date, so earlier months still read what they always did — re-calculate the month to apply these.`
      : `Rates set from ${r.effectiveFrom}. Re-calculate the month to apply them.`,
  };
}

/**
 * Edits an existing row in place.
 *
 * Only legal where no calculated month depends on it. The RPC checks
 * `residual_merchant_rate_is_locked` and refuses otherwise, and the refusal is
 * the behaviour being protected: editing a row a stamped month read would
 * restate figures somebody has already seen, with nothing in the history
 * saying so.
 */
export async function updateRatesAction(
  periodId: string,
  rateId: string,
  formData: FormData,
): Promise<RateActionResult> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const ids = z
    .object({ periodId: z.string().uuid(), rateId: z.string().uuid() })
    .safeParse({ periodId, rateId });
  if (!ids.success) return { ok: false, message: 'That is not a rate row.' };

  const tier = TIER.safeParse(formData.get('risk_tier'));
  if (!tier.success) {
    return {
      ok: false,
      message: 'Pick a risk level. It sets the split percentage, which applies to every line.',
    };
  }

  const raw = readValues(formData);
  const text: Record<string, string> = {};
  for (const k of TEXT_KEYS) {
    text[k] = raw[k] ?? '';
    delete raw[k];
  }

  const values = VALUES.safeParse(raw);
  if (!values.success) {
    const issue = values.error.issues[0];
    const field = String(issue.path[0] ?? 'A rate');
    return { ok: false, message: `${field}: ${issue.message}` };
  }

  const r = await updateRateRow(ctx, ids.data.rateId, tier.data, { ...values.data, ...text });
  if (!r.ok) return r;

  revalidatePath(`/admin/residuals/${ids.data.periodId}`);
  return { ok: true, message: 'Saved. Re-calculate the month to apply it.' };
}
