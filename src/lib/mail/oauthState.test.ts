import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { challengeFor, safeEmailReturnPath, signState, verifyState, STATE_MAX_AGE_MS } from './oauthState';

const SECRET = 'x'.repeat(40);
const USER = '11111111-1111-1111-1111-111111111111';

describe('mail OAuth state', () => {
  it('round-trips for the same user, nonce and secret', () => {
    const s = signState({ userId: USER, kind: 'personal', returnPath: '/email' }, SECRET);
    const r = verifyState(s.cookie, s.nonce, USER, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.verifier).toBe(s.verifier);
      expect(r.payload.kind).toBe('personal');
    }
  });

  it('refuses a different signed-in user (login CSRF)', () => {
    const s = signState({ userId: USER, kind: 'personal', returnPath: '/email' }, SECRET);
    const r = verifyState(s.cookie, s.nonce, '22222222-2222-2222-2222-222222222222', SECRET);
    expect(r).toEqual({ ok: false, reason: 'wrong_user' });
  });

  it('refuses a nonce that is not the one in the cookie', () => {
    const s = signState({ userId: USER, kind: 'personal', returnPath: '/email' }, SECRET);
    expect(verifyState(s.cookie, 'other', USER, SECRET)).toEqual({ ok: false, reason: 'nonce_mismatch' });
  });

  it('refuses a tampered payload', () => {
    const s = signState({ userId: USER, kind: 'personal', returnPath: '/email' }, SECRET);
    const [payload, sig] = s.cookie.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    forged.kind = 'shared';
    forged.target = 'ceo@tapdash.co';
    const forgedCookie = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
    expect(verifyState(forgedCookie, s.nonce, USER, SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a cookie signed with another secret', () => {
    const s = signState({ userId: USER, kind: 'personal', returnPath: '/email' }, SECRET);
    expect(verifyState(s.cookie, s.nonce, USER, 'y'.repeat(40))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('expires after ten minutes', () => {
    const t0 = 1_800_000_000_000;
    const s = signState({ userId: USER, kind: 'personal', returnPath: '/email' }, SECRET, t0);
    expect(verifyState(s.cookie, s.nonce, USER, SECRET, t0 + STATE_MAX_AGE_MS - 1).ok).toBe(true);
    expect(verifyState(s.cookie, s.nonce, USER, SECRET, t0 + STATE_MAX_AGE_MS + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('requires a target for a shared connect', () => {
    const s = signState({ userId: USER, kind: 'shared', target: 'sales@tapdash.co', returnPath: '/email' }, SECRET);
    const r = verifyState(s.cookie, s.nonce, USER, SECRET);
    expect(r.ok && r.payload.target).toBe('sales@tapdash.co');
  });

  it('refuses a missing cookie or state', () => {
    expect(verifyState(undefined, 'x', USER, SECRET)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyState('a.b', null, USER, SECRET)).toEqual({ ok: false, reason: 'missing' });
  });

  it('derives the S256 PKCE challenge exactly as RFC 7636 specifies', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(challengeFor(verifier)).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('safeEmailReturnPath', () => {
  it('keeps paths under /email', () => {
    expect(safeEmailReturnPath('/email?mailbox=x')).toBe('/email?mailbox=x');
    expect(safeEmailReturnPath('/email/settings')).toBe('/email/settings');
  });
  it('sends everything else to /email', () => {
    for (const bad of ['https://evil.com', '//evil.com', '/emailx', '/dashboard', '/email//evil', '/email\\x', null, '']) {
      expect(safeEmailReturnPath(bad as string)).toBe('/email');
    }
  });
});
