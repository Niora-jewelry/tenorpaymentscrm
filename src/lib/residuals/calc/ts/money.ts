/**
 * Exact decimal arithmetic for the residual calculator.
 *
 * Every amount and rate is a big.js `Big`, built from decimal text, never from
 * a JS number: 0.7 has no exact binary form, so 45¢ × 0.7 comes out as
 * 31.499999999999996 in floating point and rounds to 31¢ instead of 32¢.
 *
 * Rounding happens only through `cents`, so the rule lives in one place:
 * two decimals, half away from zero (Postgres `round(numeric, 2)` does the same).
 */
import Big from 'big.js';

export type Dec = Big;

const ZERO = new Big(0);

/** Decimal text (or null, meaning blank = 0) to a Big. Refuses JS numbers by type. */
export function dec(value: string | Big | null | undefined): Big {
  if (value === null || value === undefined || value === '') return ZERO;
  return new Big(value);
}

/** Round to cents, half away from zero. */
export function cents(value: Big): Big {
  return value.round(2, Big.roundHalfUp);
}

/** Money as text with exactly two decimals. Never "-0.00". */
export function money(value: Big): string {
  const c = cents(value);
  return c.eq(0) ? '0.00' : c.toFixed(2);
}

export function sum(values: Big[]): Big {
  return values.reduce((a, b) => a.plus(b), ZERO);
}

/** |a − b| > tolerance */
export function differs(a: Big, b: Big, tolerance: string): boolean {
  return a.minus(b).abs().gt(tolerance);
}
