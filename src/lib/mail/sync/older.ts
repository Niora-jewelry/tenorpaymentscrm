/**
 * "Load older mail": the 30 days before what a folder already holds.
 *
 * The first sync of a folder brings the last two weeks (delta, SEED_DAYS);
 * older mail is fetched only when someone asks for it, one 30-day window at
 * a time, newest first, then `oldest_loaded_at` moves back by that window.
 * The same ingest as everything else, so a message already here is simply
 * updated in place.
 *
 *   * An empty window doesn't waste a click: Outlook is asked for the newest
 *     message older than it, and the window jumps there.
 *   * When nothing older exists, `oldest_loaded_at` becomes ALL_LOADED and
 *     the button says so instead of offering more.
 *
 * Note for the runbook: Graph's folder delta keeps the receivedDateTime
 * filter it was started with, so later changes made in Outlook to mail older
 * than the first two weeks (read state, moves) are not pushed for those
 * messages; reopening them re-reads them.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { MESSAGE_SELECT, type GraphMessage } from './messageMap';
import { ingestMessages, type FolderInfo, type MailboxCtx } from './ingest';
import { SEED_DAYS } from './delta';

export const OLDER_WINDOW_DAYS = 30;
/** `oldest_loaded_at` meaning "there is nothing older in Outlook". */
export const ALL_LOADED = '1970-01-01T00:00:00.000Z';
const PAGE = 50;
const MAX_PAGES = 20;
const DAY = 86_400_000;

type Page = { value?: GraphMessage[]; '@odata.nextLink'?: string };

export type OlderOutcome = { loaded: number; complete: boolean; since: string | null };

const messagesPath = (mb: MailboxCtx, f: FolderInfo) => `${mb.root}/mailFolders/${encodeURIComponent(f.graph_id)}/messages`;

/** `oldest`: the oldest receivedDateTime fetched — where to resume when the window isn't finished. */
async function loadWindow(
  mb: MailboxCtx,
  f: FolderInfo,
  since: string,
  until: string,
  deadline: number,
): Promise<{ loaded: number; complete: boolean; oldest: string | null }> {
  let req: { path: string; query?: Record<string, string | number> } = {
    path: messagesPath(mb, f),
    query: { $select: MESSAGE_SELECT, $filter: `receivedDateTime lt ${until} and receivedDateTime ge ${since}`, $orderby: 'receivedDateTime desc', $top: PAGE },
  };
  let loaded = 0;
  let oldest: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (Date.now() >= deadline) return { loaded, complete: false, oldest };
    const res = (await mb.graph.request<Page>({ ...req, headers: { Prefer: 'outlook.body-content-type="html"' } })) ?? {};
    const items = (res.value ?? []).filter((m) => !m['@removed']);
    if (items.length) loaded += (await ingestMessages(mb, items, f)).upserted;
    for (const m of items) if (m.receivedDateTime && (!oldest || m.receivedDateTime < oldest)) oldest = m.receivedDateTime;
    const next = res['@odata.nextLink'];
    if (!next) return { loaded, complete: true, oldest };
    req = { path: next };
  }
  // More pages than one run takes: not done — resume below what arrived.
  return { loaded, complete: false, oldest };
}

/** Unfinished window: everything newer than `oldest` is here, so the next run starts there. */
async function saveProgress(folderId: string, oldest: string | null): Promise<void> {
  if (!oldest) return;
  await supabaseAdmin().from('mail_folders').update({ oldest_loaded_at: oldest, updated_at: new Date().toISOString() }).eq('id', folderId);
}

/** The newest message received before `before`, or null when there is none. */
async function newestBefore(mb: MailboxCtx, f: FolderInfo, before: string): Promise<string | null> {
  const res = await mb.graph.request<{ value?: Array<{ receivedDateTime?: string }> }>({
    path: messagesPath(mb, f),
    query: { $select: 'receivedDateTime', $filter: `receivedDateTime lt ${before}`, $orderby: 'receivedDateTime desc', $top: 1 },
  });
  return res?.value?.[0]?.receivedDateTime ?? null;
}

export async function loadOlder(mb: MailboxCtx, folderId: string, deadline: number, now = Date.now()): Promise<OlderOutcome> {
  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from('mail_folders')
    .select('id, graph_id, well_known, oldest_loaded_at, deleted_at')
    .eq('id', folderId)
    .eq('mailbox_id', mb.id)
    .maybeSingle();
  if (!row || row.deleted_at) return { loaded: 0, complete: true, since: null };
  if (row.oldest_loaded_at === ALL_LOADED || Date.parse(row.oldest_loaded_at as string) <= Date.parse(ALL_LOADED)) {
    return { loaded: 0, complete: true, since: ALL_LOADED };
  }
  const f: FolderInfo = { id: row.id as string, graph_id: row.graph_id as string, well_known: (row.well_known as string | null) ?? null };

  let until = (row.oldest_loaded_at as string | null) ?? new Date(now - SEED_DAYS * DAY).toISOString();
  let since = new Date(Date.parse(until) - OLDER_WINDOW_DAYS * DAY).toISOString();
  let out = await loadWindow(mb, f, since, until, deadline);
  if (!out.complete) {
    await saveProgress(f.id, out.oldest);
    return { loaded: out.loaded, complete: false, since: null };
  }

  if (out.loaded === 0) {
    // Nothing in those 30 days: jump to the next older message, if there is one.
    const newest = await newestBefore(mb, f, since);
    if (newest) {
      until = new Date(Date.parse(newest) + 1000).toISOString();
      since = new Date(Date.parse(until) - OLDER_WINDOW_DAYS * DAY).toISOString();
      out = await loadWindow(mb, f, since, until, deadline);
      if (!out.complete) {
        await saveProgress(f.id, out.oldest);
        return { loaded: out.loaded, complete: false, since: null };
      }
    }
  }
  const more = await newestBefore(mb, f, since);
  const mark = more ? since : ALL_LOADED;
  await admin.from('mail_folders').update({ oldest_loaded_at: mark, updated_at: new Date().toISOString() }).eq('id', f.id);
  return { loaded: out.loaded, complete: true, since: mark };
}
