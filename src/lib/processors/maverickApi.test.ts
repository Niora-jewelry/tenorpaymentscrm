import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { lastFour, maverickApi } = await import('./maverickApi');
const { ProcessorError, ProcessorNotReady } = await import('./vendorTypes');

type Answer = { status?: number; headers?: Record<string, string>; body?: unknown };

function fake(routes: (path: string) => Answer) {
  const paths: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const path = String(url).replace('https://dashboard.maverickpayments.com/api/', '');
    paths.push(path);
    const a = routes(path);
    const body = typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {});
    return new Response(body, { status: a.status ?? 200, headers: a.headers });
  }) as unknown as typeof fetch;
  return { api: maverickApi({ apiKey: 'k', fetchImpl }), paths, fetchImpl };
}

const merchant = { externalId: '9', mid: '123', name: 'Demo' };
const from = new Date('2026-10-01T00:00:00Z');

describe('maverickApi', () => {
  it('sends the token and says who is calling', async () => {
    const { api, fetchImpl } = fake(() => ({ body: { items: [] } }));
    await api.merchants();
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k', 'User-Agent': 'TenorPaymentsCRM/1.0' });
  });

  it('reads merchants from the DBA list, using the documented sample', async () => {
    const { api } = fake(() => ({
      body: { items: [{ id: '1', name: 'Demo Merchant DBA', processing: { id: '590', mid: 201143806445, bank: { accountNumber: '123456789' } } }], _meta: { pageCount: 1 } },
    }));
    expect(await api.merchants()).toEqual([{ externalId: '1', mid: '201143806445', name: 'Demo Merchant DBA' }]);
  });

  it('walks every page', async () => {
    const { api, paths } = fake((p) => ({ body: { items: [{ id: p.includes('page=1') ? '1' : '2' }], _meta: { pageCount: 2 } } }));
    expect((await api.merchants()).map((m) => m.externalId)).toEqual(['1', '2']);
    expect(paths).toEqual(['dba?page=1&per-page=50', 'dba?page=2&per-page=50']);
  });

  it('never lets more than the last four card digits out', async () => {
    const { api, paths } = fake(() => ({
      body: {
        items: [{
          id: '22376031',
          card: { number: '473702XXXXXX6363', bin: { bin: '473702', brand: 'Visa', type: 'Debit' } },
          amount: '0.01',
          type: 'Credit',
          terminal: { id: '14', number: 7000 },
          date: '2020-03-24 00:10:26',
          status: 'Successful approval/completion',
        }],
      },
    }));
    const [t] = await api.transactions(merchant, from);
    expect(paths[0]).toContain('reporting/authorizations/9?filter[date][gte]=2026-10-01');
    expect(t).toMatchObject({ externalId: '22376031', cardBrand: 'Visa', cardType: 'Debit', cardLast4: '6363', amount: 0.01, terminalId: '7000', status: 'Successful approval/completion' });
    expect(JSON.stringify(t)).not.toContain('473702');
  });

  it('turns batch lines into one summary per date', async () => {
    const { api, paths } = fake((p) =>
      p.startsWith('reporting/batch-summary')
        ? { body: { debit: '148.16', credit: '-48.00', date: '2020-03-22', amount: 100.16, id: 'r8nV0N' } }
        : { body: { items: [{ id: 1, batch: { date: '2020-03-22' } }, { id: 2, batch: { date: '2020-03-22' } }] } },
    );
    expect(await api.batches(merchant, from)).toEqual([
      { externalId: 'r8nV0N', batchDate: '2020-03-22', amount: 100.16, sales: 148.16, credits: -48, batchCount: 2 },
    ]);
    expect(paths.filter((p) => p.startsWith('reporting/batch-summary'))).toEqual(['reporting/batch-summary/9/2020-03-22']);
  });

  it('reads payouts, using the documented sample', async () => {
    const { api } = fake(() => ({
      body: { items: [{ processingDate: '2023-04-12', deposit: 9731.14, feeTotalAmount: 0, chargeback: { totalCount: 1, totalAmount: -39.95 }, reservedAmount: 83.86, releasedAmount: 0 }] },
    }));
    expect((await api.payouts(merchant, from))[0]).toMatchObject({
      externalId: '9:2023-04-12', payoutDate: '2023-04-12', depositAmount: 9731.14, chargebackCount: 1, chargebackAmount: -39.95, feeAmount: 0, reserveAmount: 83.86,
    });
  });

  it('downloads only statements from the period asked for', async () => {
    const { api, paths } = fake((p) =>
      p.startsWith('reporting/statement/') ? { body: 'PDF' } : { body: { items: [{ id: '122', date: '2026-10-31' }, { id: '142', date: '2026-01-31' }] } },
    );
    const out = await api.statements(merchant, from);
    expect(out.map((s) => s.externalId)).toEqual(['122']);
    expect(out[0]!.month).toBe('2026-10');
    expect(new TextDecoder().decode(out[0]!.bytes)).toBe('PDF');
    expect(paths).not.toContain('reporting/statement/142');
  });

  it('reads an application’s status', async () => {
    const { api } = fake(() => ({ body: { id: 606, status: 'Cancelled' } }));
    expect(await api.applicationStatus('606')).toEqual({ externalId: '606', status: 'Cancelled', label: 'Cancelled' });
  });

  it('says plainly when the firewall answers, without Maverick’s text', async () => {
    const { api } = fake(() => ({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<html>secret page</html>' }));
    const e = await api.merchants().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProcessorError);
    expect((e as InstanceType<typeof ProcessorError>).kind).toBe('unreachable');
    expect((e as Error).message).toMatch(/firewall/);
    expect((e as Error).message).not.toMatch(/secret/);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'rejected'],
    [429, 'unreachable'],
    [503, 'unreachable'],
  ])('sorts a %i as %s', async (status, kind) => {
    const { api } = fake(() => ({ status, body: { message: 'raw text' } }));
    const e = await api.merchants().catch((x: unknown) => x);
    expect((e as InstanceType<typeof ProcessorError>).kind).toBe(kind);
    expect((e as Error).message).not.toMatch(/raw text/);
  });

  it('reports a network failure as unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    const e = await maverickApi({ apiKey: 'k', fetchImpl }).merchants().catch((x: unknown) => x);
    expect((e as InstanceType<typeof ProcessorError>).kind).toBe('unreachable');
  });

  it('never sends an application from here', async () => {
    const { api, fetchImpl } = fake(() => ({ body: {} }));
    await expect(api.sendApplication({ externalId: null, fields: {}, documents: [] })).rejects.toBeInstanceOf(ProcessorNotReady);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a saved address without doubling the slash', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"items":[]}')) as unknown as typeof fetch;
    await maverickApi({ apiKey: 'k', baseUrl: 'https://sandbox-dashboard.maverickpayments.com/', fetchImpl }).merchants();
    expect((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toMatch(/^https:\/\/sandbox-dashboard\.maverickpayments\.com\/api\/dba/);
  });
});

describe('lastFour', () => {
  it('takes digits only', () => {
    expect(lastFour('531269******0736')).toBe('0736');
    expect(lastFour('473702XXXXXX6363')).toBe('6363');
    expect(lastFour(null)).toBeNull();
    expect(lastFour('12')).toBeNull();
  });
});
