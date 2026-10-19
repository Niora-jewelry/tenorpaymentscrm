import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/security/rate-limit', () => ({ rateLimit: async () => ({ allowed: true }), RATE_LIMITS: {} }));
vi.mock('./drain', () => ({ drainMailbox: async () => ({}) }));
vi.mock('../config', () => ({ mailConfig: () => ({}) }));

const { parseNotifications, messageIdOf, MAX_NOTIFICATION_BYTES } = await import('./notify');
const { isHealthy } = await import('./subscriptions');

describe('parseNotifications', () => {
  it('reads a Graph envelope', () => {
    const items = parseNotifications(
      JSON.stringify({ value: [{ subscriptionId: 's1', clientState: 'c', changeType: 'created', resource: 'Users/u/Messages/m1', resourceData: { id: 'm1', '@odata.etag': 'x' } }] }),
    );
    expect(items).toHaveLength(1);
    expect(items[0].resourceData?.id).toBe('m1');
  });

  it('turns anything malformed or oversized into nothing, never a throw', () => {
    expect(parseNotifications('')).toEqual([]);
    expect(parseNotifications('{not json')).toEqual([]);
    expect(parseNotifications(JSON.stringify({ value: [{ clientState: 'no subscription id' }] }))).toEqual([]);
    expect(parseNotifications(JSON.stringify({ value: 'x' }))).toEqual([]);
    expect(parseNotifications('x'.repeat(MAX_NOTIFICATION_BYTES + 1))).toEqual([]);
  });
});

describe('messageIdOf', () => {
  it('prefers resourceData.id, falls back to the resource path', () => {
    expect(messageIdOf({ subscriptionId: 's', resourceData: { id: 'A1' }, resource: 'Users/u/Messages/B2' })).toBe('A1');
    expect(messageIdOf({ subscriptionId: 's', resource: 'Users/u/Messages/B2' })).toBe('B2');
    expect(messageIdOf({ subscriptionId: 's', resource: "Users('u')/Messages('C3')" })).toBeNull();
    expect(messageIdOf({ subscriptionId: 's' })).toBeNull();
  });
});

describe('isHealthy', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');
  const future = '2026-10-20T10:00:00Z';
  it('needs both subscriptions active and unexpired', () => {
    expect(isHealthy([{ resource: 'messages', status: 'active', expires_at: future }, { resource: 'mailFolders', status: 'active', expires_at: future }], now)).toBe(true);
    expect(isHealthy([{ resource: 'messages', status: 'active', expires_at: future }], now)).toBe(false);
    expect(isHealthy([{ resource: 'messages', status: 'active', expires_at: future }, { resource: 'mailFolders', status: 'removed', expires_at: future }], now)).toBe(false);
    expect(isHealthy([{ resource: 'messages', status: 'active', expires_at: '2026-10-19T09:00:00Z' }, { resource: 'mailFolders', status: 'active', expires_at: future }], now)).toBe(false);
  });
});
