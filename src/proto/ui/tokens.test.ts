import { describe, it, expect } from 'vitest';
import { MONTHS_NONE, toggleMonth } from './tokens';

describe('toggleMonth', () => {
  it('adds and removes months', () => {
    expect(toggleMonth([], 'Jan')).toEqual(['Jan']);
    expect(toggleMonth(['Jan'], 'Mar')).toEqual(['Jan', 'Mar']);
    expect(toggleMonth(['Jan', 'Mar'], 'Jan')).toEqual(['Mar']);
  });

  it('"No" is exclusive both ways', () => {
    expect(toggleMonth(['Jan', 'Feb'], MONTHS_NONE)).toEqual([MONTHS_NONE]);
    expect(toggleMonth([MONTHS_NONE], 'Jun')).toEqual(['Jun']);
    expect(toggleMonth([MONTHS_NONE], MONTHS_NONE)).toEqual([]);
  });
});
