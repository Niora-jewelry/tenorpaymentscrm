import { describe, expect, it } from 'vitest';
import { addressCityState, asAddress, formatAddress, splitLargest, splitSummary } from './value';
import { formatPhone, isValidEmail, websiteHref } from './fieldLinks';
import { spanFor, isFullRow } from '@/app/(app)/[module]/FieldCard';

const parts = [
  { key: 'business', value: 'Business' },
  { key: 'gov', value: 'Gov' },
  { key: 'individual', value: 'Individual' },
] satisfies import('../schema').Choice[];

/* Stored addresses come in older, partial shapes — that is the point of
   `asAddress`, so the tests feed it what the database actually holds. */
const stored = (o: Record<string, string>) => asAddress(o as unknown as import('../schema').FieldValue);

describe('address in one list column (UI spec §6)', () => {
  it('reads "City, State"', () => {
    expect(addressCityState(stored({ street: '1 Main', city: 'Austin', state: 'TX', zip: '78701' }))).toBe('Austin, TX');
  });
  it('keeps Address 2 in the full line', () => {
    expect(formatAddress(stored({ street: '1 Main', street2: 'Suite 5', city: 'Austin', state: 'TX', zip: '78701' })))
      .toBe('1 Main, Suite 5, Austin, TX 78701');
  });
  it('an old value without street2 still reads', () => {
    expect(stored({ street: '1 Main', city: 'Austin' }).street2).toBe('');
  });
});

describe('percentage = 100% in one list column (UI spec §6)', () => {
  it('shows the largest part', () => {
    expect(splitLargest({ business: 60, gov: 15, individual: 25 }, parts)).toEqual({ label: 'Business', pct: 60 });
  });
  it('nothing filled → nothing to show', () => {
    expect(splitLargest({ business: 0, gov: 0 }, parts)).toBeNull();
  });
  it('the full breakdown is still available for hover', () => {
    expect(splitSummary({ business: 100, gov: 0 }, parts)).toBe('Business 100%');
  });
});

describe('email / phone / website', () => {
  it('validates email', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('not an email')).toBe(false);
  });
  it('formats a US phone and leaves anything else alone', () => {
    expect(formatPhone('+17173675878')).toBe('(717) 367-5878');
    expect(formatPhone('7173675878')).toBe('(717) 367-5878');
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });
  it('opens a bare domain as https', () => {
    expect(websiteHref('acme.com')).toBe('https://acme.com');
    expect(websiteHref('http://acme.com')).toBe('http://acme.com');
  });
});

describe('grid spans (UI spec §3)', () => {
  it('only Address and Percentage = 100% take the full row among standard types', () => {
    expect(spanFor({ type: 'address' })).toBe('1 / -1');
    expect(spanFor({ type: 'percent_split' })).toBe('1 / -1');
    for (const t of ['text', 'long_text', 'team_member', 'months', 'dropdown', 'currency', 'date'] as const) {
      expect(spanFor({ type: t })).toBe('span 1');
      expect(isFullRow(t)).toBe(false);
    }
  });
});
