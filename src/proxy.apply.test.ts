import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'k', NEXT_PUBLIC_APP_URL: 'http://localhost' } }));
const { isMerchantApplicationPath, isMerchantProposalPath, isMerchantSignPath } = await import('./proxy');

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

describe('merchant proposal link is the only public /proposal path', () => {
  it('a token-shaped single segment is public', () => {
    expect(isMerchantProposalPath(`/proposal/${token}`)).toBe(true);
  });
  it('anything else under /proposal and the CRM proposals pages is not', () => {
    for (const p of ['/proposal', '/proposal/', `/proposal/${token}/x`, `/proposal/${token}x`, '/proposal/short', `/proposals/${token}`, `/proposals/preview/${token}`, `/x/proposal/${token}`]) {
      expect(isMerchantProposalPath(p), p).toBe(false);
    }
  });
  it('an application token path is not a proposal path, and the other way round', () => {
    expect(isMerchantProposalPath(`/apply/${token}`)).toBe(false);
    expect(isMerchantApplicationPath(`/proposal/${token}`)).toBe(false);
  });
});

describe('agreement signer links are the only public /sign paths', () => {
  it('a token page, its copy download and the three fixed pages are public', () => {
    for (const p of [`/sign/${token}`, `/sign/${token}/copy`, '/sign/complete', '/sign/declined', '/sign/invalid']) {
      expect(isMerchantSignPath(p), p).toBe(true);
    }
  });
  it('anything else under /sign is not', () => {
    for (const p of ['/sign', '/sign/', `/sign/${token}/x`, `/sign/${token}/copy/x`, `/sign/${token}x`, '/sign/short', '/sign/completed', `/x/sign/${token}`, `/signs/${token}`]) {
      expect(isMerchantSignPath(p), p).toBe(false);
    }
  });
  it('a sign path is neither an application nor a proposal path', () => {
    expect(isMerchantApplicationPath(`/sign/${token}`)).toBe(false);
    expect(isMerchantProposalPath(`/sign/${token}`)).toBe(false);
  });
});
