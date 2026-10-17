/**
 * The one way the Email module calls Microsoft Graph.
 *
 * A thin `fetch` wrapper, not the Graph SDK. What it adds, and why each
 * matters:
 *
 *   * Immutable ids on every call (`Prefer: IdType="ImmutableId"`). A
 *     message's default id CHANGES when it moves folder; ours never may, or a
 *     move in Outlook would look like a delete plus a brand-new message.
 *   * 401 → mint a fresh access token once and retry once. A second 401 is a
 *     real answer and surfaces as an error.
 *   * Absolute URLs (Graph's `@odata.nextLink` / `deltaLink`) are accepted
 *     only under our own Graph base. The bearer token is never sent to any
 *     other host, whatever a response body says.
 *   * `$batch` in chunks of 20, Graph's limit, answers returned in request
 *     order.
 *   * Every failure becomes a `GraphError` carrying the shared classification
 *     (`errors.ts`), so callers branch on `code`, never on raw statuses.
 *
 * Throttling (429/503 + Retry-After) is NOT slept on here: the caller owns
 * the mailbox's `throttled_until` and stops work for it. Pure apart from the
 * injected `fetchImpl` and token provider, so it is unit-tested.
 */
import { classifyGraphError, type Classified } from '../errors';

export type GraphMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type GraphRequest = {
  method?: GraphMethod;
  /** `/users/…` relative to the Graph root, or an absolute link Graph returned. */
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
};

export type BatchItem = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly classified: Classified,
    public readonly graphCode: string | null,
  ) {
    super(`Graph request failed (${status} ${graphCode ?? classified.code})`);
    this.name = 'GraphError';
  }
}

export type TokenProvider = (opts: { forceRefresh: boolean }) => Promise<string>;

export type GraphTransportOptions = {
  /** e.g. `https://graph.microsoft.com/v1.0` — no trailing slash. */
  baseUrl: string;
  token: TokenProvider;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export const BATCH_LIMIT = 20;
const IMMUTABLE = 'IdType="ImmutableId"';

/** `/users/{id-or-address}` — the only mailbox root the module uses (never `/me`). */
export function mailboxRoot(idOrAddress: string): string {
  return `/users/${encodeURIComponent(idOrAddress)}`;
}

function queryString(query: GraphRequest['query']): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    // Keys are ours ($select, $filter …) and stay readable; values are encoded.
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function createGraphTransport(opts: GraphTransportOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  /** Relative path (for $batch) — validated the same way as a full URL. */
  function relative(req: GraphRequest): string {
    if (/^https?:\/\//i.test(req.path)) {
      // A link Graph handed back already carries its whole query.
      if (!req.path.startsWith(`${base}/`) || req.query) {
        throw new GraphError(0, { code: 'unknown', reaction: 'none', detail: 'foreign_link' }, null);
      }
      return req.path.slice(base.length);
    }
    if (!req.path.startsWith('/') || req.path.startsWith('//')) {
      throw new GraphError(0, { code: 'unknown', reaction: 'none', detail: 'bad_path' }, null);
    }
    return req.path + queryString(req.query);
  }

  function headersFor(req: GraphRequest, token: string): Record<string, string> {
    const extraPrefer = req.headers?.Prefer ?? req.headers?.prefer;
    const h: Record<string, string> = { Accept: 'application/json' };
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (k.toLowerCase() !== 'prefer') h[k] = v;
    }
    h.Prefer = extraPrefer ? `${IMMUTABLE}, ${extraPrefer}` : IMMUTABLE;
    h.Authorization = `Bearer ${token}`;
    if (req.body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    return h;
  }

  async function errorFrom(res: Response): Promise<GraphError> {
    let code: string | null = null;
    let message: string | null = null;
    try {
      const b = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof b?.error?.code === 'string') code = b.error.code;
      if (typeof b?.error?.message === 'string') message = b.error.message;
    } catch {
      // Not JSON — the status alone classifies it.
    }
    return new GraphError(
      res.status,
      classifyGraphError({ status: res.status, code, message, retryAfter: res.headers.get('retry-after') }),
      code,
    );
  }

  async function send(req: GraphRequest, forceRefresh: boolean): Promise<Response> {
    const token = await opts.token({ forceRefresh });
    const url = base + relative(req);
    try {
      return await fetchImpl(url, {
        method: req.method ?? 'GET',
        headers: headersFor(req, token),
        body: req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
        redirect: 'manual',
      });
    } catch {
      throw new GraphError(0, classifyGraphError({ status: 0 }), null);
    }
  }

  /** One call; JSON body back (undefined for 202/204). */
  async function request<T = unknown>(req: GraphRequest): Promise<T> {
    let res = await send(req, false);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      res = await send(req, true);
    }
    if (!res.ok) throw await errorFrom(res);
    if (res.status === 202 || res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Many calls through `$batch`, 20 at a time; answers in request order. */
  async function batch(reqs: GraphRequest[]): Promise<BatchItem[]> {
    const out: BatchItem[] = new Array(reqs.length);
    for (let start = 0; start < reqs.length; start += BATCH_LIMIT) {
      const chunk = reqs.slice(start, start + BATCH_LIMIT);
      const body = {
        requests: chunk.map((r, i) => {
          const h: Record<string, string> = { Prefer: IMMUTABLE };
          for (const [k, v] of Object.entries(r.headers ?? {})) h[k] = k.toLowerCase() === 'prefer' ? `${IMMUTABLE}, ${v}` : v;
          if (r.body !== undefined) h['Content-Type'] = 'application/json';
          return {
            id: String(i),
            method: r.method ?? 'GET',
            url: relative(r),
            headers: h,
            ...(r.body !== undefined ? { body: r.body } : {}),
          };
        }),
      };
      const res = await request<{ responses?: Array<{ id: string; status: number; headers?: Record<string, string>; body?: unknown }> }>({
        method: 'POST',
        path: '/$batch',
        body,
      });
      const byId = new Map((res?.responses ?? []).map((r) => [r.id, r]));
      chunk.forEach((_, i) => {
        const r = byId.get(String(i));
        out[start + i] = r
          ? { status: r.status, headers: r.headers ?? {}, body: r.body }
          : { status: 0, headers: {}, body: undefined };
      });
    }
    return out;
  }

  return { request, batch, baseUrl: base };
}

export type GraphTransport = ReturnType<typeof createGraphTransport>;

/** The classification for one `$batch` answer, so callers handle it like a direct call. */
export function batchItemError(item: BatchItem): GraphError | null {
  if (item.status >= 200 && item.status < 300) return null;
  const b = item.body as { error?: { code?: unknown; message?: unknown } } | undefined;
  const code = typeof b?.error?.code === 'string' ? b.error.code : null;
  const message = typeof b?.error?.message === 'string' ? b.error.message : null;
  const retryAfter = Object.entries(item.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1] ?? null;
  return new GraphError(item.status, classifyGraphError({ status: item.status, code, message, retryAfter }), code);
}
