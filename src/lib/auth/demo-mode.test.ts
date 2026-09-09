import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isDemoAuthEnabled,
  demoCredentialsMatch,
  createDemoSessionToken,
  verifyDemoSessionToken,
} from './demo-mode';

/**
 * Demo login is a temporary development stand-in. These tests exist to prove
 * the two properties that make it safe to have in the codebase at all:
 *
 *   1. it cannot run in production
 *   2. it is not an auth bypass — an unknown password never succeeds
 */

const original = { ...process.env };

/**
 * `process.env.NODE_ENV` is typed read-only, but the whole point of these tests
 * is to prove the production guard fires. Assigning through the record type is
 * the standard escape hatch.
 */
function setNodeEnv(value: 'development' | 'production' | 'test'): void {
  (process.env as Record<string, string>).NODE_ENV = value;
}

beforeEach(() => {
  process.env.DEMO_AUTH_ENABLED = 'true';
  process.env.DEMO_AUTH_EMAIL = 'demo@tapdash.co';
  process.env.DEMO_AUTH_PASSWORD = 'demo-password-123';
  process.env.DEMO_AUTH_SECRET = 'test-secret-for-signing';
  setNodeEnv('development');
});

afterEach(() => {
  process.env = { ...original };
});

describe('production guard', () => {
  it('refuses to run in production rather than silently disabling', () => {
    setNodeEnv('production');
    // Throwing is the point: a misconfigured deploy must fail loudly, not look
    // fine while the operator believes demo login works.
    expect(() => isDemoAuthEnabled()).toThrow(/production/i);
  });

  it('is off unless explicitly switched on', () => {
    delete process.env.DEMO_AUTH_ENABLED;
    expect(isDemoAuthEnabled()).toBe(false);

    process.env.DEMO_AUTH_ENABLED = 'false';
    expect(isDemoAuthEnabled()).toBe(false);

    process.env.DEMO_AUTH_ENABLED = 'yes';
    expect(isDemoAuthEnabled()).toBe(false);
  });

  it('is on for an explicit true or 1', () => {
    expect(isDemoAuthEnabled()).toBe(true);
    process.env.DEMO_AUTH_ENABLED = '1';
    expect(isDemoAuthEnabled()).toBe(true);
  });
});

describe('credential check — this is NOT an auth bypass', () => {
  it('accepts only the exact configured pair', () => {
    expect(demoCredentialsMatch('demo@tapdash.co', 'demo-password-123')).toBe(true);
  });

  it('rejects a wrong password for the right email', () => {
    expect(demoCredentialsMatch('demo@tapdash.co', 'anything-else')).toBe(false);
    expect(demoCredentialsMatch('demo@tapdash.co', '')).toBe(false);
    expect(demoCredentialsMatch('demo@tapdash.co', 'demo-password-124')).toBe(false);
  });

  it('rejects an unknown email even with the right password', () => {
    expect(demoCredentialsMatch('someone@else.com', 'demo-password-123')).toBe(false);
  });

  it('rejects everything when demo mode is off', () => {
    process.env.DEMO_AUTH_ENABLED = 'false';
    expect(demoCredentialsMatch('demo@tapdash.co', 'demo-password-123')).toBe(false);
  });

  it('rejects when no credentials are configured', () => {
    delete process.env.DEMO_AUTH_PASSWORD;
    expect(demoCredentialsMatch('demo@tapdash.co', 'demo-password-123')).toBe(false);
  });

  it('normalises email case and surrounding space, like the real flow', () => {
    expect(demoCredentialsMatch('  DEMO@TapDash.co  ', 'demo-password-123')).toBe(true);
  });

  it('does not treat the password case-insensitively', () => {
    expect(demoCredentialsMatch('demo@tapdash.co', 'DEMO-PASSWORD-123')).toBe(false);
  });
});

describe('session token', () => {
  it('round-trips a valid session', async () => {
    const token = await createDemoSessionToken('demo@tapdash.co', 'Demo');
    const session = await verifyDemoSessionToken(token);
    expect(session?.email).toBe('demo@tapdash.co');
    expect(session?.name).toBe('Demo');
  });

  it('rejects a tampered payload', async () => {
    const token = await createDemoSessionToken('demo@tapdash.co', 'Demo');
    const [, signature] = token.split('.');

    // Re-sign nothing: swap in a payload claiming a different identity.
    const forgedPayload = Buffer.from(
      JSON.stringify({ email: 'admin@tapdash.co', name: 'Admin', exp: 9_999_999_999 }),
    )
      .toString('base64url');

    expect(await verifyDemoSessionToken(`${forgedPayload}.${signature}`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await createDemoSessionToken('demo@tapdash.co', 'Demo');
    process.env.DEMO_AUTH_SECRET = 'a-completely-different-secret';
    expect(await verifyDemoSessionToken(token)).toBeNull();
  });

  it('rejects an expired session', async () => {
    const expired = { email: 'demo@tapdash.co', name: 'Demo', exp: 1 };
    const payload = Buffer.from(JSON.stringify(expired)).toString('base64url');
    expect(await verifyDemoSessionToken(`${payload}.whatever`)).toBeNull();
  });

  it('rejects malformed input', async () => {
    expect(await verifyDemoSessionToken(undefined)).toBeNull();
    expect(await verifyDemoSessionToken('')).toBeNull();
    expect(await verifyDemoSessionToken('no-dot')).toBeNull();
    expect(await verifyDemoSessionToken('...')).toBeNull();
  });
});
