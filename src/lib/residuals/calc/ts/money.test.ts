import { describe, expect, it } from 'vitest';
import { cents, dec, differs, money, sum } from './money';

describe('money', () => {
  it('45¢ × 70% is 32¢ (floating point says 31¢)', () => {
    expect(Math.round(45 * 0.7)).toBe(31); // the bug this module exists for
    expect(money(dec('0.45').times(dec('0.70')))).toBe('0.32');
  });

  it('192.65 × 70% is 134.86 (floating point says 134.85)', () => {
    expect(Math.round(192.65 * 0.7 * 100) / 100).toBe(134.85);
    expect(money(dec('192.65').times(dec('0.70')))).toBe('134.86');
  });

  it('rounds half away from zero, like Postgres round(numeric, 2)', () => {
    expect(money(dec('0.525'))).toBe('0.53');
    expect(money(dec('-0.525'))).toBe('-0.53');
    expect(money(dec('0.524999'))).toBe('0.52');
  });

  it('never prints negative zero', () => {
    expect(money(dec('-0.004'))).toBe('0.00');
    expect(money(dec('-0'))).toBe('0.00');
  });

  it('treats a blank as zero and keeps every digit of a rate', () => {
    expect(money(dec(null))).toBe('0.00');
    expect(money(dec('314954.72').times(dec('0.033816')))).toBe('10650.51');
  });

  it('sums exactly and compares against a tolerance', () => {
    expect(money(sum(['0.10', '0.20', '0.30'].map(dec)))).toBe('0.60');
    expect(0.1 + 0.2 + 0.3).not.toBe(0.6);
    expect(differs(dec('10.02'), dec('10.00'), '0.02')).toBe(false);
    expect(differs(dec('10.03'), dec('10.00'), '0.02')).toBe(true);
    expect(cents(dec('1.005')).toFixed(2)).toBe('1.01');
  });
});
