import { describe, expect, it } from 'vitest';
import { appOrigin, publicOrigin, usableOverride } from './appOrigin';

const vercel = { NODE_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'crm.example.com', VERCEL_URL: 'crm-abc123.vercel.app' };

describe('appOrigin', () => {
  it('uses the configured address on a deployed site, without a trailing slash', () => {
    expect(appOrigin({ ...vercel, NEXT_PUBLIC_APP_URL: 'https://real.example.com/' })).toBe('https://real.example.com');
  });

  it.each(['http://localhost:3000', 'http://localhost:3221/', 'http://127.0.0.1:3000', 'HTTP://LOCALHOST', ' http://localhost:3000 '])(
    'refuses %s on a deployed site',
    (value) => {
      expect(appOrigin({ ...vercel, NEXT_PUBLIC_APP_URL: value })).toBe('https://crm.example.com');
    },
  );

  it('uses the platform address when nothing is configured', () => {
    expect(appOrigin(vercel)).toBe('https://crm.example.com');
  });

  it('falls back to the deployment address when the production one is missing', () => {
    expect(appOrigin({ NODE_ENV: 'production', VERCEL_URL: 'crm-abc123.vercel.app', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' })).toBe('https://crm-abc123.vercel.app');
  });

  it('keeps localhost for a local production build, which has no platform address', () => {
    expect(appOrigin({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://localhost:3221' })).toBe('http://localhost:3221');
  });

  it('keeps localhost in development even when a platform address is present', () => {
    expect(appOrigin({ ...vercel, NODE_ENV: 'development', NEXT_PUBLIC_APP_URL: 'http://localhost:3000' })).toBe('http://localhost:3000');
  });

  it('does not mistake a real host that merely starts with localhost', () => {
    expect(appOrigin({ ...vercel, NEXT_PUBLIC_APP_URL: 'https://localhost.example.com' })).toBe('https://localhost.example.com');
  });

  it('reports no address when nothing says what it is', () => {
    expect(publicOrigin({ NODE_ENV: 'development' })).toBeNull();
    expect(appOrigin({ NODE_ENV: 'development' })).toBe('http://localhost:3000');
  });
});

describe('usableOverride', () => {
  it('ignores a localhost override on a deployed site', () => {
    expect(usableOverride('http://localhost:3221/api/mail/oauth/callback', vercel)).toBeUndefined();
  });

  it('keeps a real override on a deployed site', () => {
    expect(usableOverride('https://crm.example.com/api/mail/oauth/callback', vercel)).toBe('https://crm.example.com/api/mail/oauth/callback');
  });

  it('keeps a localhost override when running locally', () => {
    expect(usableOverride('http://localhost:3221/api/mail/oauth/callback', { NODE_ENV: 'production' })).toBe('http://localhost:3221/api/mail/oauth/callback');
  });

  it('treats a blank override as none', () => {
    expect(usableOverride('  ', vercel)).toBeUndefined();
    expect(usableOverride(undefined, vercel)).toBeUndefined();
  });
});
