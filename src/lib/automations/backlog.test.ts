import { describe, expect, it } from 'vitest';
import { backlogOf } from './backlog';

const none = { count: 0, oldest: null };

describe('backlogOf', () => {
  it('is nothing when nothing is late', () => {
    expect(backlogOf(none, none)).toBeNull();
  });
  it('counts queued triggers', () => {
    expect(backlogOf({ count: 3, oldest: '2026-11-05T07:52:00Z' }, none)).toEqual({ count: 3, since: '2026-11-05T07:52:00Z' });
  });
  it('counts waits that should have ended', () => {
    expect(backlogOf(none, { count: 1, oldest: '2026-11-05T09:00:00Z' })).toEqual({ count: 1, since: '2026-11-05T09:00:00Z' });
  });
  it('adds both and reports the older date', () => {
    expect(backlogOf({ count: 2, oldest: '2026-11-05T09:00:00Z' }, { count: 1, oldest: '2026-11-04T16:00:00Z' })).toEqual({ count: 3, since: '2026-11-04T16:00:00Z' });
  });
  it('compares dates, not their text', () => {
    expect(backlogOf({ count: 1, oldest: '2026-11-05T09:00:00+00:00' }, { count: 1, oldest: '2026-11-05T08:30:00-02:00' })?.since).toBe('2026-11-05T09:00:00+00:00');
  });
});
