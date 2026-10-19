/**
 * GET /api/mail/image?m=<messageId>&n=<index> — the "Load images" proxy.
 *
 * The browser NEVER supplies a URL: it names a message it can see (RLS read)
 * and an index into that message's stored list of blocked images. The URL
 * comes from our own row, written by the sanitiser at ingest.
 *
 * Then the SSRF guard (`ssrf.ts`): http(s) only, ports 80/443, no
 * credentials, EVERY DNS answer public — and the connection is pinned to the
 * vetted address, so DNS cannot answer differently a second time
 * (rebinding). Redirects are re-checked hop by hop, at most three. Five
 * seconds, five megabytes, and only bytes that sniff as a raster image are
 * passed on. The sender's server sees our IP, not the reader's.
 */
import { type NextRequest } from 'next/server';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { RATE_LIMITS } from '@/lib/security/rate-limit';
import { routeGate, notFound, untrustedHeaders, UUID } from '@/lib/mail/routeGate';
import { checkUrl, sniffImage } from '@/lib/mail/ssrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5_000;

const lookupAll = (host: string) => dnsLookup(host, { all: true, verbatim: true });

type LookupCb = (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/** An Agent whose every connection goes to the address already vetted. */
function pinnedAgent(address: string, family: number): Agent {
  return new Agent({
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
    connect: {
      timeout: TIMEOUT_MS,
      lookup: ((_host: string, opts: { all?: boolean } | undefined, cb: LookupCb) => {
        if (opts?.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
      }) as never,
    },
  });
}

async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const gate = await routeGate('mail_image', RATE_LIMITS.mailImagePerUser);
  if ('response' in gate) return gate.response;
  const m = req.nextUrl.searchParams.get('m') ?? '';
  const n = Number(req.nextUrl.searchParams.get('n'));
  if (!UUID.test(m) || !Number.isInteger(n) || n < 0 || n > 199) return notFound();

  const supabase = await createSupabaseServerClient();
  const { data: msg } = await supabase.from('mail_messages').select('external_images').eq('id', m).maybeSingle();
  const list = Array.isArray(msg?.external_images) ? (msg.external_images as unknown[]) : [];
  let url = typeof list[n] === 'string' ? (list[n] as string) : null;
  if (!url) return notFound();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = await checkUrl(url, lookupAll);
    if (!check.ok) return new Response('Blocked.', { status: 403 });
    const agent = pinnedAgent(check.address, check.family);
    try {
      const res = await undiciFetch(check.url, {
        dispatcher: agent,
        redirect: 'manual',
        headers: {
          Accept: 'image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
          'User-Agent': 'TapDash-Mail-Image-Proxy/1.0',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!loc) return new Response('Bad redirect.', { status: 502 });
        url = new URL(loc, check.url).toString();
        continue;
      }
      if (!res.ok) return new Response('Image unavailable.', { status: 502 });
      const bytes = await readCapped(res.body as ReadableStream<Uint8Array> | null);
      if (!bytes) return new Response('Image too large.', { status: 502 });
      const type = sniffImage(bytes);
      if (!type) return new Response('Unsupported image.', { status: 415 });
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: untrustedHeaders({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' }),
      });
    } catch {
      return new Response('Image unavailable.', { status: 502 });
    } finally {
      void agent.close().catch(() => {});
    }
  }
  return new Response('Too many redirects.', { status: 502 });
}
