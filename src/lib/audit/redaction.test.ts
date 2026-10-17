import { describe, it, expect } from 'vitest';
import { redactMetadata, REDACTED } from './redact';

/**
 * The spec requires an audit trail of OTP requests, verifications and password
 * changes. Those are exactly the events whose payloads must never contain the
 * secret involved. These tests assert the guarantee rather than trusting that
 * every future caller remembers it.
 */
describe('redactMetadata', () => {
  it('redacts a one-time code', () => {
    const out = redactMetadata({ otpCode: '481920', purpose: 'signup' }) as Record<string, unknown>;
    expect(out.otpCode).toBe(REDACTED);
    expect(out.purpose).toBe('signup');
  });

  it('redacts passwords under any casing or naming', () => {
    const out = redactMetadata({
      password: 'hunter2',
      newPassword: 'hunter3',
      confirm_password: 'hunter3',
      PASSWORD: 'hunter4',
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) expect(value).toBe(REDACTED);
  });

  it('redacts tokens, tickets, session identifiers and keys', () => {
    const out = redactMetadata({
      access_token: 'ey...',
      ticket: 'abc',
      sessionId: 'sess_1',
      serviceRoleKey: 'sk_live',
      OTP_PEPPER: 'pepper',
      codeHash: 'deadbeef',
    }) as Record<string, unknown>;

    for (const value of Object.values(out)) expect(value).toBe(REDACTED);
  });

  it('redacts secrets nested inside innocuous containers', () => {
    const out = redactMetadata({
      request: { headers: { cookie: 'sb-access-token=...', accept: 'text/html' }, path: '/login' },
    }) as { request: { headers: Record<string, unknown>; path: string } };

    // The secret is removed without discarding the surrounding context that
    // makes an audit entry useful during an investigation.
    expect(out.request.headers.cookie).toBe(REDACTED);
    expect(out.request.headers.accept).toBe('text/html');
    expect(out.request.path).toBe('/login');
  });

  it('keeps the non-sensitive fields an investigation actually needs', () => {
    const out = redactMetadata({
      purpose: 'reset',
      reason: 'INVALID_CODE',
      attemptsRemaining: 3,
      wasRateLimited: false,
    }) as Record<string, unknown>;

    expect(out).toEqual({
      purpose: 'reset',
      reason: 'INVALID_CODE',
      attemptsRemaining: 3,
      wasRateLimited: false,
    });
  });

  it('truncates long strings so one entry cannot flood the log', () => {
    const out = redactMetadata({ note: 'x'.repeat(5000) }) as { note: string };
    expect(out.note.length).toBe(500);
  });

  it('caps deep nesting instead of recursing without bound', () => {
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    expect(() => redactMetadata(deep)).not.toThrow();
  });

  it('redacts the Email module secrets: refresh tokens, PKCE verifiers, clientState, nonces', () => {
    const out = redactMetadata({
      refresh: 'M.R3_BAY...',
      code_verifier: 'abc',
      clientState: 'xyz',
      client_state: 'xyz',
      nonce: 'n',
      graph: { headers: { Bearer: 'ey..' }, mailbox: 'ok-to-keep-id' },
    }) as Record<string, unknown> & { graph: { headers: Record<string, unknown>; mailbox: string } };

    expect(out.refresh).toBe(REDACTED);
    expect(out.code_verifier).toBe(REDACTED);
    expect(out.clientState).toBe(REDACTED);
    expect(out.client_state).toBe(REDACTED);
    expect(out.nonce).toBe(REDACTED);
    expect(out.graph.headers.Bearer).toBe(REDACTED);
    expect(out.graph.mailbox).toBe('ok-to-keep-id');
  });

  it('handles arrays, null and undefined', () => {
    expect(redactMetadata(null)).toBeNull();
    expect(redactMetadata(undefined)).toBeUndefined();
    expect(redactMetadata([{ password: 'x' }])).toEqual([{ password: REDACTED }]);
  });
});
