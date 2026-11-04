/**
 * Live from Microsoft, with the last answer kept for when Microsoft cannot give one.
 *
 * Nothing is deleted when a connection breaks: the last loaded data stays on screen,
 * marked out of date, until the person reconnects. It only leaves when they disconnect
 * (a trigger on mail_identities).
 */
import 'server-only';
import { GraphError } from '@/lib/mail/graph/transport';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { Staleness } from './types';

const KEEP_DAYS = 30;

const RECONNECT = new Set(['reconnect_required', 'consent_required', 'app_secret_invalid']);

/** What an error from Microsoft means for the person looking at the screen. */
export function stalenessOf(e: unknown): Exclude<Staleness, null> {
  if (e instanceof GraphError && RECONNECT.has(e.classified.code)) return 'reconnect';
  return 'down';
}

export const firstStale = (list: Staleness[]): Staleness => (list.includes('reconnect') ? 'reconnect' : list.includes('down') ? 'down' : null);

async function readSnapshot<T>(identityId: string, kind: string, key: string): Promise<{ data: T; at: number } | null> {
  const { data } = await supabaseAdmin().from('teams_snapshots').select('data, fetched_at').eq('identity_id', identityId).eq('kind', kind).eq('key', key).maybeSingle();
  return data ? { data: data.data as T, at: Date.parse(data.fetched_at as string) } : null;
}

async function writeSnapshot(identityId: string, kind: string, key: string, data: unknown): Promise<void> {
  const admin = supabaseAdmin();
  const { error } = await admin.from('teams_snapshots').upsert({ identity_id: identityId, kind, key, data, fetched_at: new Date().toISOString() }, { onConflict: 'identity_id,kind,key' });
  if (error) console.error('[teams] could not keep the last loaded data', { kind, code: error.code });
  // Now and then, so ranges nobody returns to do not pile up.
  if (Math.random() < 0.02) {
    await admin.from('teams_snapshots').delete().eq('identity_id', identityId).lt('fetched_at', new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString());
  }
}

/**
 * @param maxAgeMs  Reuse a snapshot this fresh rather than asking Microsoft again.
 *                  For the sidebar's poll, so counting does not double the calls.
 * @returns         `data` null only when Microsoft failed and nothing was ever kept.
 */
export async function readThrough<T>(
  identityId: string,
  kind: string,
  key: string,
  load: () => Promise<T>,
  opts: { maxAgeMs?: number; keep?: boolean } = {},
): Promise<{ data: T | null; stale: Staleness }> {
  if (opts.maxAgeMs) {
    const hit = await readSnapshot<T>(identityId, kind, key);
    if (hit && Date.now() - hit.at < opts.maxAgeMs) return { data: hit.data, stale: null };
  }
  try {
    const data = await load();
    if (opts.keep !== false) await writeSnapshot(identityId, kind, key, data);
    return { data, stale: null };
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    console.error('[teams] Microsoft refused or failed', { kind, status: e.status, code: e.classified.code });
    const kept = await readSnapshot<T>(identityId, kind, key);
    return { data: kept?.data ?? null, stale: stalenessOf(e) };
  }
}

/** Microsoft's words for why it refused, for the person who asked. */
export function reasonFrom(e: unknown, fallback: string): string {
  if (e instanceof GraphError) {
    if (e.classified.code === 'provider_down' || e.classified.code === 'throttled') return 'Microsoft is not responding. Try again in a moment.';
    if (RECONNECT.has(e.classified.code)) return 'This account needs reconnecting first.';
    if (e.graphMessage) return e.graphMessage.slice(0, 300);
  }
  return fallback;
}

/** All pages of a list, up to a limit so one huge calendar cannot stall the screen. */
export async function allPages<T>(graph: { request: <R>(req: { path: string; query?: Record<string, string | number | undefined>; headers?: Record<string, string> }) => Promise<R> }, req: { path: string; query?: Record<string, string | number | undefined>; headers?: Record<string, string> }, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let next: { path: string; query?: Record<string, string | number | undefined>; headers?: Record<string, string> } | null = req;
  for (let page = 0; next && page < maxPages; page += 1) {
    const body: { value?: T[]; '@odata.nextLink'?: string } | undefined = await graph.request<{ value?: T[]; '@odata.nextLink'?: string }>(next);
    out.push(...(body?.value ?? []));
    const link: string | undefined = body?.['@odata.nextLink'];
    next = link ? { path: link, headers: req.headers } : null;
  }
  return out;
}
