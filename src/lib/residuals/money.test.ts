/**
 * Presenting residual money.
 *
 * The rule the whole module is built on is that a figure crosses from SQL as
 * text and is never parsed, so the formatter is tested on what it preserves as
 * much as on what it adds.
 */
import { describe, expect, it } from 'vitest';
import { formatMoneyText } from './reconciliation';

describe('formatMoneyText', () => {
  it('adds the symbol and groups thousands', () => {
    expect(formatMoneyText('633.78')).toBe('$633.78');
    expect(formatMoneyText('1234567.89')).toBe('$1,234,567.89');
    expect(formatMoneyText('1000')).toBe('$1,000');
  });

  it('puts the sign outside the symbol', () => {
    expect(formatMoneyText('-375.32')).toBe('-$375.32');
    expect(formatMoneyText('-1234.00')).toBe('-$1,234.00');
  });

  /*
   * The point of the function. numeric(14,2) already decided how many decimals
   * the figure carries; re-rounding here would be a second opinion about a
   * number that is not ours to round — and a trailing "0.00" that becomes
   * "0" reads as a different claim.
   */
  it('leaves the decimals exactly as SQL produced them', () => {
    expect(formatMoneyText('0.00')).toBe('$0.00');
    expect(formatMoneyText('7.20')).toBe('$7.20');
    expect(formatMoneyText('1234567.5')).toBe('$1,234,567.5');
    expect(formatMoneyText('10.000000')).toBe('$10.000000');
  });

  it('passes a value it cannot read through untouched', () => {
    /* Better seen verbatim than mangled into something plausible. */
    expect(formatMoneyText('n/a')).toBe('n/a');
    expect(formatMoneyText('')).toBe('');
    expect(formatMoneyText('1.2.3')).toBe('1.2.3');
  });

  it('keeps null as null, so a missing figure stays missing', () => {
    /* Null means "withheld" throughout this module. Turning it into "$0.00"
       would assert a figure that was deliberately not disclosed. */
    expect(formatMoneyText(null)).toBeNull();
  });
});
