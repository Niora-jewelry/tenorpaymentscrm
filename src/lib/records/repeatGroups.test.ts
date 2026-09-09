import { describe, it, expect } from 'vitest';
import { repeatInstanceCount } from './repeatGroups';

describe('repeatInstanceCount — "a record always has one instance, even with zero stored data"', () => {
  it('returns 1 when no sibling has any stored array at all', () => {
    expect(repeatInstanceCount({}, ['owner_ownership', 'owner_private'])).toBe(1);
  });

  it('returns 1 for a genuinely empty array on every sibling', () => {
    expect(repeatInstanceCount({ owner_ownership: [], owner_private: [] }, ['owner_ownership', 'owner_private'])).toBe(1);
  });

  it('returns the length of a single populated sibling', () => {
    const values = { owners: [{ first: 'A' }, { first: 'B' }, { first: 'C' }] };
    expect(repeatInstanceCount(values, ['owners'])).toBe(3);
  });

  it('returns the MAX length across siblings — the whole reason migration 27 exists (owner_private/owner_ownership must agree)', () => {
    const values = {
      owner_ownership: [{ first: 'A' }, { first: 'B' }],
      owner_private: [{ ssn: '1' }],
    };
    expect(repeatInstanceCount(values, ['owner_ownership', 'owner_private'])).toBe(2);
  });

  it('ignores a non-array value on a sibling key rather than throwing', () => {
    const values = { owners: 'not-an-array' };
    expect(repeatInstanceCount(values, ['owners'])).toBe(1);
  });

  it('ignores keys not in the sibling list', () => {
    const values = { owners: [{}, {}, {}], unrelated_field: [{}, {}, {}, {}, {}] };
    expect(repeatInstanceCount(values, ['owners'])).toBe(3);
  });
});
