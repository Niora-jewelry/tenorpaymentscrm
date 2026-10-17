import { describe, it, expect } from 'vitest';
import { createGraphTransport, batchItemError, mailboxRoot, GraphError, BATCH_LIMIT } from './transport';

/** The error a promise rejects with; fails the test if it resolves instead. */
async function rejection<E>(p: Promise<unknown>): Promise<E> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: E) => e,
  );
}

const BASE = 'https://graph.microsoft.com/v1.0';

type Call = { url: string; init: RequestInit };

function scripted(responses: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function tokens() {
  const asked: boolean[] = [];
  return {
    asked,
    token: async ({ forceRefresh }: { forceRefresh: boolean }) => {
      asked.push(forceRefresh);
      return forceRefresh ? 'fresh' : 'stale';
    },
  };
}

describe('Graph transport', () => {
  it('asks for immutable ids and merges an extra Prefer', async () => {
    const { calls, fetchImpl } = scripted([json(200, { ok: 1 })]);
    const t = createGraphTransport({ baseUrl: BASE, token: tokens().token, fetchImpl });
    await t.request({ path: '/users/x/messages', query: { $select: 'id,subject', $top: 5 }, headers: { Prefer: 'odata.maxpagesize=50' } });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Prefer).toBe('IdType="ImmutableId", odata.maxpagesize=50');
    expect(h.Authorization).toBe('Bearer stale');
    expect(calls[0].url).toBe(`${BASE}/users/x/messages?$select=id%2Csubject&$top=5`);
  });

  it('on 401 mints a fresh token once and retries once', async () => {
    const tk = tokens();
    const { calls, fetchImpl } = scripted([json(401, { error: { code: 'InvalidAuthenticationToken' } }), json(200, { v: 1 })]);
    const t = createGraphTransport({ baseUrl: BASE, token: tk.token, fetchImpl });
    expect(await t.request({ path: '/me' })).toEqual({ v: 1 });
    expect(tk.asked).toEqual([false, true]);
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
  });

  it('a second 401 is a real answer', async () => {
    const { fetchImpl } = scripted([json(401, {}), json(401, {})]);
    const t = createGraphTransport({ baseUrl: BASE, token: tokens().token, fetchImpl });
    const err = await rejection<GraphError>(t.request({ path: '/me' }));
    expect(err).toBeInstanceOf(GraphError);
    expect(err.classified.code).toBe('token_expired');
  });

  it('classifies throttling with Retry-After and does not retry it', async () => {
    const { calls, fetchImpl } = scripted([json(429, { error: { code: 'TooManyRequests' } }, { 'Retry-After': '17' })]);
    const t = createGraphTransport({ baseUrl: BASE, token: tokens().token, fetchImpl });
    const err = await rejection<GraphError>(t.request({ path: '/users/x/messages' }));
    expect(err.classified).toMatchObject({ code: 'throttled', retryAfterSeconds: 17 });
    expect(calls).toHaveLength(1);
  });

  it('never sends the token to a host other than Graph', async () => {
    const { calls, fetchImpl } = scripted([]);
    const t = createGraphTransport({ baseUrl: BASE, token: tokens().token, fetchImpl });
    for (const path of [
      'https://evil.example/v1.0/users',
      'https://graph.microsoft.com.evil.example/v1.0/x',
      'https://graph.microsoft.com/v1.0@evil.example/x',
      '//evil.example/x',
      'users/x',
    ]) {
      const err = await rejection<GraphError>(t.request({ path }));
      expect(err, path).toBeInstanceOf(GraphError);
    }
    expect(calls).toHaveLength(0);
  });

  it('follows a Graph nextLink as-is', async () => {
    const { calls, fetchImpl } = scripted([json(200, { value: [] })]);
    const t = createGraphTransport({ baseUrl: BASE, token: tokens().token, fetchImpl });
    await t.request({ path: `${BASE}/users/x/mailFolders/delta?$skiptoken=abc` });
    expect(calls[0].url).toBe(`${BASE}/users/x/mailFolders/delta?$skiptoken=abc`);
  });

  it('returns undefined for 204 and maps network failure to provider_down', async () => {
    const { fetchImpl } = scripted([
      () => new Response(null, { status: 204 }),
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    const t = createGraphTransport({ baseUrl: BASE, token: tokens().token, fetchImpl });
    expect(await t.request({ method: 'DELETE', path: '/users/x/messages/1' })).toBeUndefined();
    const err = await rejection<GraphError>(t.request({ path: '/me' }));
    expect(err.classified.code).toBe('provider_down');
  });

  it('batches in chunks of 20 and returns answers in request order', async () => {
    const reqs = Array.from({ length: BATCH_LIMIT + 3 }, (_, i) => ({ path: `/users/x/messages/${i}` }));
    const answer = (call: Call) => {
      const body = JSON.parse(String(call.init.body)) as { requests: Array<{ id: string; url: string }> };
      // Answer out of order, the way Graph may.
      const responses = [...body.requests].reverse().map((r) => ({ id: r.id, status: 200, body: { url: r.url } }));
      return new Response(JSON.stringify({ responses }), { status: 200 });
    };
    const { calls, fetchImpl } = scripted([answer, answer]);
    const t = createGraphTransport({ baseUrl: BASE, token: tokens().token, fetchImpl });
    const out = await t.batch(reqs);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${BASE}/$batch`);
    expect(out.map((o) => (o.body as { url: string }).url)).toEqual(reqs.map((r) => r.path));
    const first = JSON.parse(String(calls[0].init.body)).requests[0];
    expect(first.headers.Prefer).toBe('IdType="ImmutableId"');
  });

  it('classifies a failed batch item like a direct call', () => {
    expect(batchItemError({ status: 200, headers: {}, body: {} })).toBeNull();
    const e = batchItemError({ status: 429, headers: { 'retry-after': '9' }, body: { error: { code: 'TooManyRequests' } } });
    expect(e?.classified).toMatchObject({ code: 'throttled', retryAfterSeconds: 9 });
    expect(batchItemError({ status: 404, headers: {}, body: { error: { code: 'ErrorItemNotFound' } } })?.classified.code).toBe('not_found');
  });

  it('encodes the mailbox segment', () => {
    expect(mailboxRoot('sales@x.com')).toBe('/users/sales%40x.com');
    expect(mailboxRoot('a/../b')).toBe('/users/a%2F..%2Fb');
  });
});
