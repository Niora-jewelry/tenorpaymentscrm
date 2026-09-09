import { describe, it, expect } from 'vitest';
import { resolveOrder } from './preferences';

describe('resolveOrder — admin default → user override, 19 Aug amendment', () => {
  it('returns the admin order untouched when the user has no saved order', () => {
    expect(resolveOrder(['a', 'b', 'c'], undefined)).toEqual(['a', 'b', 'c']);
  });

  it('returns the admin order untouched for an empty saved order', () => {
    expect(resolveOrder(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('applies a full user reorder', () => {
    expect(resolveOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  it('drift-on-add: a field the admin adds later keeps its admin position, not shoved to the end', () => {
    // User only ever saw/reordered a and c; admin later inserted b in the middle.
    const adminOrder = ['a', 'b', 'c'];
    const userOrder = ['c', 'a']; // saved before 'b' existed
    expect(resolveOrder(adminOrder, userOrder)).toEqual(['c', 'b', 'a']);
  });

  it('drift-on-remove: a field the admin removed just disappears from the result', () => {
    const adminOrder = ['a', 'c']; // admin removed 'b'
    const userOrder = ['c', 'b', 'a']; // saved back when 'b' still existed
    expect(resolveOrder(adminOrder, userOrder)).toEqual(['c', 'a']);
  });

  it('a saved order referencing an id that never existed in admin order is silently ignored, not crashed on', () => {
    expect(resolveOrder(['a', 'b'], ['ghost', 'b', 'a'])).toEqual(['b', 'a']);
  });

  it('a partial user order only reorders the slots it actually touched', () => {
    // User only moved 'a' to the end; 'b' and 'c' were never in their saved
    // order, so the admin's own relative order for the untouched ids holds.
    expect(resolveOrder(['a', 'b', 'c', 'd'], ['d', 'a'])).toEqual(['d', 'b', 'c', 'a']);
  });

  it('is a pure function — never mutates its inputs', () => {
    const adminOrder = ['a', 'b', 'c'];
    const userOrder = ['c', 'a', 'b'];
    const adminCopy = [...adminOrder];
    const userCopy = [...userOrder];
    resolveOrder(adminOrder, userOrder);
    expect(adminOrder).toEqual(adminCopy);
    expect(userOrder).toEqual(userCopy);
  });
});
