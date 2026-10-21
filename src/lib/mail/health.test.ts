import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/env.server', () => ({ serverEnv: {} }));

const { secretDaysLeft } = await import('./health');

describe('secretDaysLeft', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  it('counts whole days, negative once past, null when unknown or unreadable', () => {
    expect(secretDaysLeft('2026-11-20', now)).toBe(29);
    expect(secretDaysLeft('2026-10-21T18:00:00Z', now)).toBe(0);
    expect(secretDaysLeft('2026-10-01', now)).toBe(-21);
    expect(secretDaysLeft(undefined, now)).toBeNull();
    expect(secretDaysLeft('soon', now)).toBeNull();
  });
});
