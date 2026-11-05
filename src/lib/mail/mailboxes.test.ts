import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env.server', () => ({ serverEnv: {} }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock('@/lib/integrations/resolve', () => ({ integrationValues: async () => ({}) }));

const { healthOf } = await import('./mailboxes');

const fine = { sync_status: 'ok', seeded_at: '2026-11-01T00:00:00Z' };

describe('the state a mailbox shows', () => {
  it('says Syncing only when Outlook can be reached', () => {
    expect(healthOf({ status: 'ok', mb: fine, providerUp: true })).toBe('ok');
    expect(healthOf({ status: 'ok', mb: fine, providerUp: false })).toBe('paused');
  });

  it('a mailbox that needs someone still says so while Outlook is unreachable', () => {
    expect(healthOf({ status: 'broken', mb: fine, providerUp: false })).toBe('needs_reconnect');
    expect(healthOf({ status: 'ok', mb: { ...fine, sync_status: 'stalled' }, providerUp: false })).toBe('stalled');
  });
});
