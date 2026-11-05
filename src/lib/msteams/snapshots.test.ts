import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/env.server', () => ({ serverEnv: {} }));

const { GraphError } = await import('@/lib/mail/graph/transport');
const { classifyGraphError } = await import('@/lib/mail/errors');
const { firstStale, stalenessOf } = await import('./snapshots');

const failure = (status: number, code?: string) => new GraphError(status, classifyGraphError({ status, code: code ?? null, message: null, retryAfter: null }), code ?? null);

describe('what a failure from Microsoft is called', () => {
  it('a request Microsoft answered and refused is not "not responding"', () => {
    expect(stalenessOf(failure(400, 'BadRequest'))).toBe('refused');
  });

  it('an outage, a timeout or being told to slow down is', () => {
    expect(stalenessOf(failure(503))).toBe('down');
    expect(stalenessOf(failure(0))).toBe('down');
    expect(stalenessOf(failure(429))).toBe('down');
  });

  it('the most serious reason wins across several accounts', () => {
    expect(firstStale([null, 'refused', 'down'])).toBe('down');
    expect(firstStale([null, 'refused'])).toBe('refused');
    expect(firstStale([null, null])).toBeNull();
  });
});
