/**
 * The preview card under a message with a link. The server fetches the page, because a
 * browser could not (other sites' pages refuse it), and that makes every link someone
 * sends a request from inside this server. So: the SSRF guard from Email's image proxy,
 * hop by hop, on a connection pinned to the vetted address. No images are fetched; the
 * card is text.
 */
import 'server-only';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { checkUrl } from '@/lib/mail/ssrf';
import type { LinkPreview } from './types';

const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5_000;

const lookupAll = (host: string) => dnsLookup(host, { all: true, verbatim: true });

type LookupCb = (err: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

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

async function readHead(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    html += decoder.decode(value, { stream: true });
    // The tags that matter are in the head; there is no need for the whole page.
    if (total > MAX_BYTES || /<\/head>/i.test(html)) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return html;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? '').replace(/\s+/g, ' ').trim();

function metaOf(html: string, names: string[]): string {
  for (const name of names) {
    const a = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i').exec(html);
    const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, 'i').exec(html);
    const value = a?.[1] ?? b?.[1];
    if (value?.trim()) return decode(value);
  }
  return '';
}

/** What the card says. Exported so the parsing can be tested without a network. */
export function previewFromHtml(html: string, url: string): LinkPreview | null {
  const title = metaOf(html, ['og:title', 'twitter:title']) || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '');
  if (!title) return null;
  return {
    url,
    title: title.slice(0, 160),
    description: metaOf(html, ['og:description', 'twitter:description', 'description']).slice(0, 300),
    site: metaOf(html, ['og:site_name']).slice(0, 80) || new URL(url).hostname.replace(/^www\./, ''),
  };
}

export async function linkPreview(raw: string): Promise<LinkPreview | null> {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = await checkUrl(url, lookupAll);
    if (!check.ok) return null;
    const agent = pinnedAgent(check.address, check.family);
    try {
      const res = await undiciFetch(check.url, {
        dispatcher: agent,
        redirect: 'manual',
        headers: { Accept: 'text/html', 'User-Agent': 'Tenor-Link-Preview/1.0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => undefined);
        if (!loc) return null;
        url = new URL(loc, check.url).toString();
        continue;
      }
      if (!res.ok || !(res.headers.get('content-type') ?? '').toLowerCase().includes('html')) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      return previewFromHtml(await readHead(res.body as ReadableStream<Uint8Array> | null), raw);
    } catch {
      return null;
    } finally {
      void agent.close().catch(() => undefined);
    }
  }
  return null;
}
