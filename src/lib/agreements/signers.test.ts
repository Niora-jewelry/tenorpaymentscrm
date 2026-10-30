import { describe, expect, it } from 'vitest';
import { selectSigners, type OwnerInput } from './signers';

const owner = (i: number, percentage: number | string, extra: Partial<OwnerInput> = {}): OwnerInput => ({
  index: i,
  first: `First${i}`,
  last: `Last${i}`,
  email: `owner${i}@example.test`,
  title: 'Owner',
  percentage,
  ...extra,
});
const slots = (pcts: (number | string)[]) => selectSigners(pcts.map((p, i) => owner(i, p)));
const names = (r: ReturnType<typeof selectSigners>) => r.signers.map((s) => s.index);

describe('who signs (spec §4, 25% counts — the client, 30 Oct 2026)', () => {
  it('A 100% → A', () => expect(names(slots([100]))).toEqual([0]));
  it('A 50, B 50 → both', () => expect(names(slots([50, 50]))).toEqual([0, 1]));
  it('A 60, B 20, C 20 → A alone reaches 51', () => expect(names(slots([60, 20, 20]))).toEqual([0]));
  it('A 30, B 15, C 10, D 5 → A, then B and C to reach 51', () => expect(names(slots([30, 15, 10, 5]))).toEqual([0, 1, 2]));
  it('four at 25 → all four are at 25%, so all four sign', () => expect(names(slots([25, 25, 25, 25]))).toEqual([0, 1, 2, 3]));
  it('24, 24, 24, 24, 4 → the first three reach 72 (none mandatory)', () => expect(names(slots([24, 24, 24, 24, 4]))).toEqual([0, 1, 2]));
  it('six at 10 → blocked: needs 6, room for 4', () => expect(slots([10, 10, 10, 10, 10, 10]).problems).toEqual([{ kind: 'too_many', needed: 6 }]));
  it('45 alone → blocked: under 51', () => expect(slots([45]).problems).toEqual([{ kind: 'under_51', total: 45 }]));
  it('nobody → blocked', () => expect(selectSigners([]).problems).toEqual([{ kind: 'no_owners' }]));
  it('ties keep CRM order, slots follow rank', () => {
    const r = selectSigners([owner(0, 20), owner(1, 40), owner(2, 20)]);
    expect(r.signers.map((s) => [s.slot, s.index])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });
  it('percentages as text ("33%", "33.5") are read', () => expect(names(slots(['33%', '33.5', '33']))).toEqual([1, 0, 2]));
});

describe('each signer: name and their own email', () => {
  it('a missing last name blocks', () =>
    expect(selectSigners([owner(0, 100, { last: '' })]).problems).toEqual([{ kind: 'owner_name', index: 0 }]));
  it('an invalid email blocks', () =>
    expect(selectSigners([owner(0, 100, { email: 'nope' })]).problems).toEqual([{ kind: 'owner_email', index: 0 }]));
  it('two signers on one inbox block (case-insensitive)', () =>
    expect(selectSigners([owner(0, 50), owner(1, 50, { email: 'OWNER0@example.test' })]).problems).toEqual([{ kind: 'owner_email_shared', index: 1, withIndex: 0 }]));
  it('an owner outside the signer set may be incomplete', () =>
    expect(selectSigners([owner(0, 100), owner(1, 0, { first: '', last: '', email: '' })]).problems).toEqual([]));
});
