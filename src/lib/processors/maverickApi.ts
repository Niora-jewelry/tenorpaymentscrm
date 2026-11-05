/**
 * Reading from Maverick's Platforms API, written from their published documentation
 * and its sample responses. No real response has been seen yet: their firewall
 * stopped every request we tried. So `vendor.ts` keeps this switched off until the
 * first real answer has been compared against these mappings.
 *
 * Sending an application is deliberately not here. It writes to a live processor, so
 * it waits until reads are proven.
 *
 * Only the last four card digits ever leave this file, and a message from here never
 * carries Maverick's own response text.
 */
import 'server-only';
import {
  ProcessorError,
  ProcessorNotReady,
  type ProcessorVendor,
  type VendorApplicationStatus,
  type VendorBatch,
  type VendorMerchant,
  type VendorPayout,
  type VendorStatement,
  type VendorTicket,
  type VendorTransaction,
} from './vendorTypes';

export const MAVERICK_ADDRESS = 'https://dashboard.maverickpayments.com';
/** Says plainly who is calling. Never made to look like a browser. */
export const MAVERICK_CLIENT = 'TenorPaymentsCRM/1.0';

const PER_PAGE = 50;
const MAX_PAGES = 200;
const TIMEOUT_MS = 30_000;

type Json = Record<string, unknown>;
type Options = { apiKey: string; baseUrl?: string | null; fetchImpl?: typeof fetch };

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const day = (d: Date) => d.toISOString().slice(0, 10);
export const lastFour = (card: unknown): string | null => {
  const digits = String(card ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

export function maverickApi({ apiKey, baseUrl, fetchImpl = fetch }: Options): ProcessorVendor {
  const base = (baseUrl || MAVERICK_ADDRESS).replace(/\/+$/, '');

  async function request(path: string, accept: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/${path}`, {
        headers: { Accept: accept, Authorization: `Bearer ${apiKey}`, 'User-Agent': MAVERICK_CLIENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProcessorError('Could not reach Maverick.', 'unreachable');
    }
    if (res.ok) return res;
    if (res.headers.get('cf-mitigated')) throw new ProcessorError('Maverick’s firewall stopped this request.', 'unreachable');
    if (res.status === 401) throw new ProcessorError('Maverick refused the API key.', 'auth');
    if (res.status === 403) throw new ProcessorError('This API key has no access to that Maverick data.', 'auth');
    if (res.status === 429 || res.status >= 500) throw new ProcessorError(`Maverick is having trouble (${res.status}).`, 'unreachable');
    throw new ProcessorError(`Maverick refused the request (${res.status}).`, 'rejected');
  }

  async function one(path: string): Promise<Json> {
    const res = await request(path, 'application/json');
    try {
      return obj(await res.json());
    } catch {
      throw new ProcessorError('Maverick sent an answer the CRM could not read.', 'rejected');
    }
  }

  /** Every page of a list. Their paging is `page` and `per-page`, reported back in `_meta`. */
  async function all(path: string): Promise<Json[]> {
    const out: Json[] = [];
    const joiner = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await one(`${path}${joiner}page=${page}&per-page=${PER_PAGE}`);
      const items = Array.isArray(body.items) ? (body.items as unknown[]) : [];
      out.push(...items.map(obj));
      const pageCount = num(obj(body._meta).pageCount) ?? 1;
      if (page >= pageCount || items.length === 0) return out;
    }
    throw new ProcessorError('Maverick returned more pages than the CRM will read at once.', 'rejected');
  }

  const dba = (m: VendorMerchant) => encodeURIComponent(m.externalId);
  const since = (field: string, from: Date) => `filter[${field}][gte]=${day(from)}`;

  return {
    async merchants(): Promise<VendorMerchant[]> {
      return (await all('dba')).flatMap((d) => {
        const id = str(d.id);
        return id ? [{ externalId: id, mid: str(obj(d.processing).mid), name: str(d.name) }] : [];
      });
    },

    async transactions(m, from): Promise<VendorTransaction[]> {
      return (await all(`reporting/authorizations/${dba(m)}?${since('date', from)}`)).flatMap((t) => {
        const id = str(t.id);
        if (!id) return [];
        const card = obj(t.card);
        const bin = obj(card.bin);
        return [{
          externalId: id,
          cardType: str(bin.type),
          cardBrand: str(bin.brand),
          cardLast4: lastFour(card.number),
          amount: num(t.amount),
          terminalId: str(obj(t.terminal).number),
          transactionType: str(t.type),
          messageType: null,
          paymentType: null,
          authorizedAt: str(t.date),
          responseCode: null,
          status: str(t.status),
        }];
      });
    },

    /** The batch list is line by line. Its dates say which summaries to ask for. */
    async batches(m, from): Promise<VendorBatch[]> {
      const lines = await all(`reporting/batches/${dba(m)}?${since('date', from)}`);
      const counts = new Map<string, number>();
      for (const line of lines) {
        const date = str(obj(line.batch).date) ?? str(line.date);
        if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
      }
      const out: VendorBatch[] = [];
      for (const [date, count] of counts) {
        const s = await one(`reporting/batch-summary/${dba(m)}/${encodeURIComponent(date)}`);
        out.push({
          externalId: str(s.id) ?? `${m.externalId}:${date}`,
          batchDate: str(s.date) ?? date,
          amount: num(s.amount),
          sales: num(s.debit),
          credits: num(s.credit),
          batchCount: count,
        });
      }
      return out;
    },

    async payouts(m, from): Promise<VendorPayout[]> {
      return (await all(`reporting/payouts/acq/${dba(m)}?${since('processingDate', from)}`)).flatMap((p) => {
        const date = str(p.processingDate);
        if (!date) return [];
        const chargeback = obj(p.chargeback);
        return [{
          externalId: `${m.externalId}:${date}`,
          payoutDate: date,
          depositAmount: num(p.deposit),
          chargebackCount: num(chargeback.totalCount),
          chargebackAmount: num(chargeback.totalAmount),
          nonSettledAmount: null,
          feeAmount: num(p.feeTotalAmount),
          reserveAmount: num(p.reservedAmount),
          releasedAmount: num(p.releasedAmount),
        }];
      });
    },

    /** The ACH reports need access Maverick has not confirmed for a platform key. */
    async ach() {
      throw new ProcessorNotReady('Maverick has not confirmed ACH reporting for this account yet.');
    },

    async statements(m, from): Promise<VendorStatement[]> {
      const out: VendorStatement[] = [];
      for (const s of await all(`reporting/statements/${dba(m)}`)) {
        const id = str(s.id);
        const date = str(s.date);
        if (!id || !date || date < day(from)) continue;
        const res = await request(`reporting/statement/${encodeURIComponent(id)}`, 'application/pdf');
        out.push({
          externalId: id,
          month: date.slice(0, 7),
          name: `Statement ${date.slice(0, 7)}.pdf`,
          bytes: new Uint8Array(await res.arrayBuffer()),
        });
      }
      return out;
    },

    /** Their ticket list has no sample response. These are the fields their Ticket object documents. */
    async tickets(m, from): Promise<VendorTicket[]> {
      const list = await all(`tickets?filter[dba.id]=${dba(m)}`);
      return list.flatMap((t) => {
        const id = str(t.id);
        const changed = str(t.updatedOn) ?? str(t.createdOn);
        if (!id || (changed && changed.slice(0, 10) < day(from))) return [];
        const text = str(t.text);
        return [{
          externalId: id,
          mid: m.mid,
          title: str(t.title),
          status: str(t.status),
          details: text ? [{ label: 'Details', value: text }] : [],
          openedAt: str(t.createdOn),
          changedAt: changed,
        }];
      });
    },

    async applicationStatus(externalId): Promise<VendorApplicationStatus> {
      const status = str((await one(`boarding-application/${encodeURIComponent(externalId)}`)).status);
      if (!status) throw new ProcessorError('Maverick did not say what state this application is in.', 'rejected');
      return { externalId, status, label: status };
    },

    async sendApplication() {
      throw new ProcessorNotReady('Sending applications to Maverick isn’t switched on yet. Nothing was sent.');
    },
  };
}
