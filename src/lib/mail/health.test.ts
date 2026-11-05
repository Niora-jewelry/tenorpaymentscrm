import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const providerRow = vi.hoisted(() => ({ state: 'up' }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { state: providerRow.state } }) }) }) }) }),
}));
vi.mock('@/lib/integrations/resolve', () => ({ integrationValues: async () => ({ MAIL_CLIENT_SECRET_EXPIRES_AT: '2020-01-01' }) }));
vi.mock('@/lib/env.server', () => ({ serverEnv: {} }));

const { moduleNotice, secretDaysLeft } = await import('./health');

describe('moduleNotice', () => {
  it('never talks about the app secret: that belongs to Integrations alone', async () => {
    providerRow.state = 'config_error';
    const refused = await moduleNotice();
    expect(refused?.text).toMatch(/Can't reach Outlook/);
    expect(refused?.text).not.toMatch(/secret|azure|MAIL_CLIENT/i);
  });

  it('says nothing when Outlook is answering, even with a secret past its date', async () => {
    providerRow.state = 'up';
    expect(await moduleNotice()).toBeNull();
  });
});

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
