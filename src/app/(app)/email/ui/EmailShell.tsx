'use client';

/**
 * The Email module's three panes and the state between them.
 *
 * ── STAYING CURRENT ──────────────────────────────────────────────────────
 * Every 15 seconds while the tab is visible the shell asks for each
 * mailbox's `change_seq` — one number per mailbox, bumped whenever the sync
 * engine changes its mail. Only a mailbox whose number moved is re-read, so
 * an idle inbox costs one tiny query. Failures back off (15 → 30 → 60 s);
 * after two in a row the list says so instead of silently going stale.
 *
 * ── URL ──────────────────────────────────────────────────────────────────
 * `?f=<folder id | all>&c=<mailbox id>~<conversation>` is kept in the
 * address bar with history.pushState — shareable and Back-able, without a
 * server round trip per click.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import type { ConversationRow, ListPage, MailboxView } from '@/lib/mail/viewTypes';
import {
  conversationAction,
  listConversationsAction,
  mailboxesAction,
  openFolderAction,
  searchAction,
  syncStateAction,
} from '../actions';
import { FolderPane } from './FolderPane';
import { folderIdsFor, parseOpen, type Open, type Selection } from './selection';
import { ConversationList, type ListFilter } from './ConversationList';
import { ReadingPane, type Thread } from './ReadingPane';

type ListState = ListPage & { status: 'loading' | 'ready' | 'error'; loadingMore: boolean };
type SearchState = { q: string; scope: 'here' | 'everywhere'; status: 'idle' | 'loading' | 'ready' | 'error'; rows: ConversationRow[] };

const POLL_MS = [15_000, 30_000, 60_000];

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}
const EMPTY_LIST: ListState = { pinned: [], rows: [], next: null, status: 'loading', loadingMore: false };

function writeUrl(sel: Selection, open: Open | null, mode: 'push' | 'replace') {
  const u = new URL(window.location.href);
  u.searchParams.set('f', sel.kind === 'all' ? 'all' : sel.folderId);
  if (open) u.searchParams.set('c', `${open.mailboxId}~${open.key}`);
  else u.searchParams.delete('c');
  if (u.toString() === window.location.href) return;
  if (mode === 'push') window.history.pushState(null, '', u);
  else window.history.replaceState(null, '', u);
}

export function EmailShell({
  initialMailboxes,
  initialSelection,
  initialPage,
  initialOpen,
}: {
  initialMailboxes: MailboxView[];
  initialSelection: Selection;
  /** null = the server could not load it; the list shows its retry state. */
  initialPage: ListPage | null;
  initialOpen: Open | null;
}) {
  const [boxes, setBoxes] = useState(initialMailboxes);
  const [sel, setSel] = useState<Selection>(initialSelection);
  const [filter, setFilter] = useState<ListFilter>('all');
  const [list, setList] = useState<ListState>(
    initialPage ? { ...initialPage, status: 'ready', loadingMore: false } : { ...EMPTY_LIST, status: 'error' },
  );
  const [search, setSearch] = useState<SearchState>({ q: '', scope: 'here', status: 'idle', rows: [] });
  const [open, setOpen] = useState<Open | null>(initialOpen);
  const [thread, setThread] = useState<Thread>({ status: initialOpen ? 'loading' : 'idle', messages: [] });
  const [failures, setFailures] = useState(0);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const listReq = useRef(0);
  const threadReq = useRef(0);
  const seqs = useRef<Map<string, number> | null>(null);
  const failuresRef = useRef(0);

  // Refs mirror state for callbacks that outlive a render (poll, popstate).
  const live = useRef({ sel, filter, open, boxes, list, search });
  useEffect(() => {
    live.current = { sel, filter, open, boxes, list, search };
  }, [sel, filter, open, boxes, list, search]);

  const folderIds = useMemo(() => folderIdsFor(sel, boxes), [sel, boxes]);
  const folderById = useMemo(() => new Map(boxes.flatMap((b) => b.folders.map((f) => [f.id, { ...f, box: b }] as const))), [boxes]);
  const current = sel.kind === 'folder' ? folderById.get(sel.folderId) : undefined;
  const ownBoxes = boxes.filter((b) => b.own);
  const scopeBoxes = sel.kind === 'all' ? ownBoxes : current ? [current.box] : [];
  const troubled = scopeBoxes.filter((b) => b.health === 'needs_reconnect' || b.health === 'needs_permission' || b.health === 'stalled');
  const addressOf = useCallback((id: string) => boxes.find((b) => b.id === id)?.address ?? '', [boxes]);

  // ── list ────────────────────────────────────────────────────────────────
  const loadList = useCallback(async (s: Selection, f: ListFilter, opts: { silent?: boolean } = {}) => {
    const ids = folderIdsFor(s, live.current.boxes);
    const req = ++listReq.current;
    if (!opts.silent) setList(EMPTY_LIST);
    if (ids.length === 0) {
      setList({ pinned: [], rows: [], next: null, status: 'ready', loadingMore: false });
      return;
    }
    const res = await listConversationsAction({
      folderIds: ids,
      cursor: null,
      unreadOnly: f === 'unread',
      withAttachments: f === 'attachments',
    });
    if (req !== listReq.current) return;
    if (!res.ok) {
      if (!opts.silent) setList({ ...EMPTY_LIST, status: 'error' });
      return;
    }
    setList((prev) => {
      if (!opts.silent || prev.rows.length <= res.data.rows.length) return { ...res.data, status: 'ready', loadingMore: false };
      // Keep pages already scrolled into, below the refreshed first page.
      const fresh = new Set(res.data.rows.map((r) => `${r.mailboxId}~${r.key}`));
      const lastAt = res.data.rows[res.data.rows.length - 1]?.lastAt ?? '';
      const older = prev.rows.filter((r) => !fresh.has(`${r.mailboxId}~${r.key}`) && r.lastAt <= lastAt);
      return { pinned: res.data.pinned, rows: [...res.data.rows, ...older], next: prev.next, status: 'ready', loadingMore: false };
    });
  }, []);

  const loadMore = useCallback(async () => {
    const { list: l, sel: s, filter: f, boxes: b } = live.current;
    if (!l.next || l.loadingMore) return;
    setList((p) => ({ ...p, loadingMore: true }));
    const req = listReq.current;
    const res = await listConversationsAction({
      folderIds: folderIdsFor(s, b),
      cursor: l.next,
      unreadOnly: f === 'unread',
      withAttachments: f === 'attachments',
    });
    if (req !== listReq.current) return;
    setList((p) =>
      res.ok
        ? { ...p, rows: [...p.rows, ...res.data.rows], next: res.data.next, loadingMore: false }
        : { ...p, loadingMore: false },
    );
  }, []);

  // ── conversation ────────────────────────────────────────────────────────
  /**
   * reset: show the loading state first (a different conversation).
   * background: a refresh of what is already on screen — a failure keeps it.
   */
  const loadThread = useCallback(async (o: Open, opts: { reset?: boolean; background?: boolean } = {}) => {
    const req = ++threadReq.current;
    if (opts.reset) setThread({ status: 'loading', messages: [] });
    const res = await conversationAction({ mailboxId: o.mailboxId, key: o.key });
    if (req !== threadReq.current) return;
    if (res.ok) setThread({ status: 'ready', messages: res.data });
    else if (!opts.background) setThread({ status: 'error', messages: [] });
  }, []);

  const openRow = useCallback(
    (row: ConversationRow) => {
      const o = { mailboxId: row.mailboxId, key: row.key };
      setOpen(o);
      writeUrl(live.current.sel, o, 'replace');
      void loadThread(o, { reset: true });
    },
    [loadThread],
  );

  // ── staying current ─────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    const { boxes: b, sel: s, filter: f, open: o, search: q } = live.current;
    if (b.length === 0) return;
    const res = await syncStateAction({ mailboxIds: b.map((x) => x.id) });
    if (!res.ok) {
      failuresRef.current += 1;
      setFailures(failuresRef.current);
      return;
    }
    failuresRef.current = 0;
    setFailures(0);
    setNow(new Date());
    window.dispatchEvent(new CustomEvent('tapdash:email-unread', { detail: res.data.unreadTotal }));

    const before = seqs.current;
    const after = new Map(res.data.mailboxes.map((m) => [m.id, m.seq]));
    seqs.current = after;
    const health = new Map(res.data.mailboxes.map((m) => [m.id, m.health]));
    if (b.some((x) => health.get(x.id) && health.get(x.id) !== x.health)) {
      setBoxes((prev) => prev.map((x) => (health.has(x.id) ? { ...x, health: health.get(x.id)! } : x)));
    }
    if (!before) return; // first poll only records where we are
    const changed = new Set([...after].filter(([id, n]) => before.get(id) !== n).map(([id]) => id));
    if (changed.size === 0) return;

    const fresh = await mailboxesAction();
    if (fresh.ok) setBoxes(fresh.data);
    const viewing = s.kind === 'all'
      ? b.filter((x) => x.own).map((x) => x.id)
      : b.filter((x) => x.folders.some((fd) => fd.id === s.folderId)).map((x) => x.id);
    if (q.status === 'idle' && viewing.some((id) => changed.has(id))) void loadList(s, f, { silent: true });
    if (o && changed.has(o.mailboxId)) void loadThread(o, { background: true });
  }, [loadList, loadThread]);

  // One loop for the life of the page, armed once. It reads the latest poll
  // through a ref and the failure count through another, so neither a failure
  // nor a refreshed folder tree ever restarts it (which would poll in a tight
  // loop exactly when the server is struggling).
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  // `kick(delay)` re-arms the loop sooner (after opening a stale folder, on
  // coming back online or to the tab).
  const kick = useRef<(delay?: number) => void>(() => {});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const arm = (delay?: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delay ?? POLL_MS[Math.min(failuresRef.current, POLL_MS.length - 1)]);
    };
    const run = async () => {
      if (document.visibilityState === 'visible') await pollRef.current();
      if (!stopped) arm();
    };
    kick.current = arm;
    arm(0);
    const soon = () => {
      if (document.visibilityState === 'visible') arm(250);
    };
    document.addEventListener('visibilitychange', soon);
    window.addEventListener('online', soon);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', soon);
      window.removeEventListener('online', soon);
    };
  }, []);

  // ── selection ───────────────────────────────────────────────────────────
  const touchFolder = useCallback(
    async (s: Selection) => {
      if (s.kind !== 'folder') return;
      const res = await openFolderAction({ folderId: s.folderId });
      // A stale folder is being fetched right now: look again shortly.
      if (res.ok && res.data.syncing) kick.current(3_000);
    },
    [],
  );

  const select = useCallback(
    (s: Selection) => {
      setSel(s);
      setSearch({ q: '', scope: 'here', status: 'idle', rows: [] });
      setOpen(null);
      setThread({ status: 'idle', messages: [] });
      writeUrl(s, null, 'push');
      void loadList(s, live.current.filter);
      void touchFolder(s);
    },
    [loadList, touchFolder],
  );

  // First paint: the server rendered the list. Open the conversation from the
  // URL, and mark the folder as being looked at.
  useEffect(() => {
    if (initialOpen) {
      // The thread starts in its loading state; only the answer updates it.
      const req = ++threadReq.current;
      void conversationAction({ mailboxId: initialOpen.mailboxId, key: initialOpen.key }).then((res) => {
        if (req !== threadReq.current) return;
        setThread(res.ok ? { status: 'ready', messages: res.data } : { status: 'error', messages: [] });
      });
    }
    void touchFolder(initialSelection);
    writeUrl(initialSelection, initialOpen, 'replace');
    const onPop = () => {
      const p = new URLSearchParams(window.location.search);
      const f = p.get('f');
      const s: Selection = !f || f === 'all' ? { kind: 'all' } : { kind: 'folder', folderId: f };
      const o = parseOpen(p.get('c'));
      setSel(s);
      setOpen(o);
      void loadList(s, live.current.filter);
      if (o) void loadThread(o, { reset: true });
      else setThread({ status: 'idle', messages: [] });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [initialOpen, initialSelection, loadList, loadThread, touchFolder]);

  const setListFilter = (f: ListFilter) => {
    setFilter(f);
    void loadList(live.current.sel, f);
  };

  const refresh = async () => {
    setRefreshing(true);
    await touchFolder(live.current.sel);
    await pollRef.current();
    await loadList(live.current.sel, live.current.filter, { silent: true });
    setRefreshing(false);
  };

  // ── search ──────────────────────────────────────────────────────────────
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runSearch = useCallback((q: string, scope: SearchState['scope']) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) {
      setSearch({ q, scope, status: 'idle', rows: [] });
      return;
    }
    setSearch((p) => ({ ...p, q, scope, status: 'loading' }));
    searchTimer.current = setTimeout(async () => {
      const { sel: s, boxes: b } = live.current;
      const here = scope === 'here';
      const mailboxIds = here
        ? s.kind === 'all'
          ? b.filter((x) => x.own).map((x) => x.id)
          : b.filter((x) => x.folders.some((f) => f.id === s.folderId)).map((x) => x.id)
        : b.map((x) => x.id);
      const res = await searchAction({ q, mailboxIds, folderIds: here && s.kind === 'folder' ? [s.folderId] : null });
      setSearch((p) => (p.q !== q || p.scope !== scope ? p : { q, scope, status: res.ok ? 'ready' : 'error', rows: res.ok ? res.data : [] }));
    }, 280);
  }, []);

  // ── render ──────────────────────────────────────────────────────────────
  const title = sel.kind === 'all' ? 'All inboxes' : (current?.name ?? 'Folder');
  const subtitle = sel.kind === 'all' ? `${ownBoxes.length} mailboxes` : (current?.box.address ?? '');
  const unread = sel.kind === 'all' ? ownBoxes.reduce((n, b) => n + (b.folders.find((f) => f.wellKnown === 'inbox')?.unread ?? 0), 0) : (current?.unread ?? 0);
  const searching = search.status !== 'idle';
  const rows = searching ? search.rows : list.rows;
  const selectedKey = open ? `${open.mailboxId}~${open.key}` : null;
  const showMailbox = boxes.length > 1 && (sel.kind === 'all' || (searching && search.scope === 'everywhere'));
  const currentFolderIds = useMemo(() => new Set(folderIds), [folderIds]);
  const openAddress = open && boxes.length > 1 ? addressOf(open.mailboxId) : null;
  const settingUp = scopeBoxes.some((b) => b.health === 'setting_up') || (current ? !current.seeded : false);

  return (
    <div className="grid h-full min-h-0 grid-cols-[248px_minmax(330px,400px)_minmax(0,1fr)] bg-white">
      <FolderPane mailboxes={boxes} selection={sel} onSelect={select} />

      <section aria-label={title} className="flex min-h-0 flex-col border-r border-line bg-white">
        <div className="border-b border-line px-4 pb-3 pt-4">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[16px] font-semibold tracking-[-.01em] text-ink-900">{title}</h2>
              <p className="truncate text-[11.5px] text-ink-400">
                {subtitle}
                {unread > 0 ? <span className="font-semibold text-brand-700"> · {unread} unread</span> : null}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              title="Check for new mail"
              aria-label="Check for new mail"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900 disabled:opacity-60"
            >
              <Icon name="refresh-cw" size={15} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>

          <label className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-1.5 transition-colors focus-within:border-brand-600 focus-within:bg-white focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-brand-600)_14%,transparent)]">
            <Icon name="search" size={14} className="shrink-0 text-ink-400" />
            <input
              type="search"
              value={search.q}
              onChange={(e) => runSearch(e.target.value, search.scope)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') runSearch('', 'here');
              }}
              placeholder={sel.kind === 'all' ? 'Search all inboxes' : `Search ${title}`}
              aria-label="Search mail"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-900 outline-none placeholder:text-ink-400"
            />
            {search.status === 'loading' ? <Spinner /> : null}
          </label>

          <div className="mt-2.5 flex items-center gap-1">
            {searching ? (
              <>
                <Segment active={search.scope === 'here'} onClick={() => runSearch(search.q, 'here')}>
                  {sel.kind === 'all' ? 'All inboxes' : 'This folder'}
                </Segment>
                <Segment active={search.scope === 'everywhere'} onClick={() => runSearch(search.q, 'everywhere')}>
                  Every mailbox
                </Segment>
                <span className="ml-auto text-[11.5px] text-ink-400">
                  {search.status === 'ready' ? `${search.rows.length === 50 ? 'Top 50' : search.rows.length} result${search.rows.length === 1 ? '' : 's'}` : ''}
                </span>
              </>
            ) : (
              <>
                <Segment active={filter === 'all'} onClick={() => setListFilter('all')}>All</Segment>
                <Segment active={filter === 'unread'} onClick={() => setListFilter('unread')}>Unread</Segment>
                <Segment active={filter === 'attachments'} onClick={() => setListFilter('attachments')}>
                  <Icon name="paperclip" size={11} /> Files
                </Segment>
              </>
            )}
          </div>
        </div>

        {troubled.length ? (
          <Link
            href="/email/settings"
            className="flex items-start gap-2 border-b border-[#f7e0af] bg-[#fdf1d8] px-4 py-2 text-[12px] text-[#8a5a09] hover:bg-[#fbe9c4]"
          >
            <Icon name="alert-triangle" size={13} className="mt-px shrink-0" />
            <span>
              {troubled.length === 1 ? (
                <>
                  <b className="font-semibold">{troubled[0].address}</b> stopped syncing.
                </>
              ) : (
                <>{troubled.length} mailboxes stopped syncing.</>
              )}{' '}
              <span className="font-semibold underline underline-offset-2">Reconnect</span>
            </span>
          </Link>
        ) : null}
        {!online || failures >= 2 ? (
          <p role="status" className="flex items-center gap-2 border-b border-line bg-canvas px-4 py-2 text-[12px] text-ink-500">
            <Icon name="alert-triangle" size={13} className="shrink-0 text-ink-400" />
            {!online ? 'You’re offline. Showing what was last loaded.' : 'Can’t reach TapDash right now — retrying.'}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {(!searching && list.status === 'loading') || (searching && search.status === 'loading' && search.rows.length === 0) ? (
            <ListSkeleton />
          ) : !searching && list.status === 'error' ? (
            <Empty icon="alert-triangle" title="This folder could not be loaded." body="Check your connection and try again.">
              <button type="button" onClick={() => void loadList(sel, filter)} className="text-[12.5px] font-semibold text-brand-700 hover:text-brand-900">
                Try again
              </button>
            </Empty>
          ) : rows.length === 0 && (searching || list.pinned.length === 0) ? (
            searching ? (
              <Empty icon="search" title={search.status === 'error' ? 'Search didn’t work this time.' : `Nothing matches “${search.q.trim()}”.`} body={search.scope === 'here' ? 'Try every mailbox, or fewer words.' : 'Try fewer or different words.'} />
            ) : settingUp ? (
              <Empty icon="refresh-cw" title="Fetching your mail from Outlook…" body="The last two weeks arrive first; this usually takes under a minute." spinning />
            ) : (
              <Empty
                icon={filter === 'unread' ? 'check' : 'inbox'}
                title={filter === 'unread' ? 'You’re all caught up.' : filter === 'attachments' ? 'No conversations with files here.' : `Nothing in ${title}.`}
              />
            )
          ) : (
            <ConversationList
              pinned={searching ? [] : list.pinned}
              rows={rows}
              selectedKey={selectedKey}
              onOpen={openRow}
              hasMore={!searching && Boolean(list.next)}
              loadingMore={list.loadingMore}
              onLoadMore={() => void loadMore()}
              showMailbox={showMailbox}
              mailboxLabel={addressOf}
              now={now}
            />
          )}
        </div>
      </section>

      <ReadingPane
        thread={thread}
        currentFolderIds={currentFolderIds}
        mailbox={openAddress}
        onRetry={() => open && void loadThread(open, { reset: true })}
        now={now}
      />
    </div>
  );
}

function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[12px] font-semibold transition-colors ${
        active ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-canvas hover:text-ink-900'
      }`}
    >
      {children}
    </button>
  );
}

function Empty({
  icon,
  title,
  body,
  spinning = false,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  body?: string;
  spinning?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-8 pt-20 text-center">
      <span className="mb-3 grid size-10 place-items-center rounded-full bg-canvas text-ink-300">
        <Icon name={icon} size={18} className={spinning ? 'animate-spin [animation-duration:2.4s]' : ''} />
      </span>
      <p className="text-[13.5px] font-semibold text-ink-700">{title}</p>
      {body ? <p className="mt-1 max-w-[34ch] text-[12.5px] leading-relaxed text-ink-400">{body}</p> : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading conversations">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="border-b border-line-faint px-4 py-3">
          <div className="flex justify-between">
            <div className="skeleton h-3 w-32" />
            <div className="skeleton h-3 w-10" />
          </div>
          <div className="skeleton mt-2 h-3 w-56" />
          <div className="skeleton mt-2 h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

