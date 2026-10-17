import { describe, it, expect } from 'vitest';
import { REDACTED } from '@/lib/audit/redact';
import { sanitizeLogMeta } from './log';

describe('mail log sanitising', () => {
  it('redacts secrets by key and JWT-shaped values anywhere', () => {
    const out = sanitizeLogMeta({
      refresh_token: 'M.R3_x',
      response: { headers: { 'x-trace': 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig' } },
      opaque: 'A'.repeat(300),
    }) as { refresh_token: string; response: { headers: Record<string, string> }; opaque: string };
    expect(out.refresh_token).toBe(REDACTED);
    expect(out.response.headers['x-trace']).toBe(REDACTED);
    expect(out.opaque).toBe(REDACTED);
  });

  it('drops mail content keys entirely', () => {
    const out = sanitizeLogMeta({ subject: 'Salary', body: 'private', to: ['a@b.c'], mailboxId: 'mb-1', status: 429 });
    expect(out).toEqual({ mailboxId: 'mb-1', status: 429 });
  });
});
