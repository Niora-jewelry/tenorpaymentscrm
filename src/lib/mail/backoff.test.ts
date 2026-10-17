import { describe, it, expect } from 'vitest';
import { breakerOpen, nextSyncDelayMinutes, retryDelayMs } from './backoff';

describe('retryDelayMs', () => {
  it('stays inside the jittered window and grows with the attempt', () => {
    expect(retryDelayMs(0, () => 0.999)).toBeLessThan(2_000);
    expect(retryDelayMs(3, () => 0.999)).toBeLessThan(16_000);
    expect(retryDelayMs(3, () => 0.999)).toBeGreaterThan(15_000);
    expect(retryDelayMs(10, () => 0.999)).toBeLessThan(60_000);
    expect(retryDelayMs(5, () => 0)).toBe(0);
  });
});

describe('nextSyncDelayMinutes', () => {
  it('follows 1, 2, 4, 8, 16, then holds at 30', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(nextSyncDelayMinutes)).toEqual([0, 1, 2, 4, 8, 16, 30, 30]);
  });
});

describe('breakerOpen', () => {
  const now = 1_800_000_000_000;
  it('opens after five throttles inside ten minutes', () => {
    const five = [1, 2, 3, 4, 5].map((m) => now - m * 60_000);
    expect(breakerOpen(five, now)).toBe(true);
    expect(breakerOpen(five.slice(0, 4), now)).toBe(false);
  });
  it('closes fifteen minutes after the last throttle', () => {
    const five = [1, 2, 3, 4, 5].map((m) => now - m * 60_000);
    expect(breakerOpen(five, now + 15 * 60_000)).toBe(false);
  });
});
