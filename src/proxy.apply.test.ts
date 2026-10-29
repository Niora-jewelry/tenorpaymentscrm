import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', NEXT_PUBLIC_APP_URL: 'http://localhost' } }));
const { isMerchantApplicationPath } = await import('./proxy');

const token = 'A'.repeat(20) + 'b-_'.repeat(5) + '0123456789'.slice(0, 8);

describe('merchant application link is the only public /apply path', () => {
  it('a token-shaped single segment is public', () => {
    expect(token).toHaveLength(43);
    expect(isMerchantApplicationPath(`/apply/${token}`)).toBe(true);
  });
  it('anything else under /apply is not', () => {
    for (const p of ['/apply', '/apply/', `/apply/${token}/x`, `/apply/${token}x`, '/apply/short', `/apply/${token.slice(0, 42)}!`, `/x/apply/${token}`]) {
      expect(isMerchantApplicationPath(p), p).toBe(false);
    }
  });
});
