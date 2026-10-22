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
 * ── ACTING ───────────────────────────────────────────────────────────────
 * Every action is optimistic: the rows leave (or flip to read) at once and
 * the server applies the same change locally in one transaction, then the
 * engine carries it to Outlook within seconds. If the server refuses, the
 * list and thread are re-read and the reason is shown — never a silent
 * revert. Opening an unread conversation marks it read after 1.5 s, so
 * arrowing past mail does not read it all.
 *
 * ── URL ──────────────────────────────────────────────────────────────────
 * `?f=<folder id | all>&c=<mailbox id>~<conversation>` is kept in the
 * address bar with history.pushState — shareable and Back-able, without a
 * server round trip per click.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '@/proto/ui/icons';
import { BarAction, BarCount, Dialog, FloatingBar, Spinner } from '@/proto/ui/kit';
import type { ConversationRow, ListPage, MailboxView, ModuleNotice, Notice } from '@/lib/mail/viewTypes';
import {
  conversationAction,
  conversationOpAction,
  dismissNoticeAction,
  folderAction,
  listConversationsAction,
  loadOlderAction,
  mailboxesAction,
  openFolderAction,
  pinAction,
  searchAction,
  syncStateAction,
} from '../actions';
import { FolderPane, type FolderOp } from './FolderPane';
import { ConversationToolbar, MoveTo, deleteOp, type Op, type ReplyKind } from './Actions';
import { Composer, type SentResult } from './Composer';
import { ScheduledList } from './ScheduledList';
import { composeStartAction, releaseOutboxAction, undoSendAction } from '../composeActions';
import { fullStamp } from '@/lib/mail/dates';
import type { ComposeInit, ComposeKind } from '@/lib/mail/viewTypes';
import { folderIdsFor, parseOpen, type Open, type Selection } from './selection';
import { ConversationList, LoadOlder, type ListFilter } from './ConversationList';
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
const rowId = (r: { mailboxId: string; key: string }) => `${r.mailboxId}~${r.key}`;
const sameSelection = (a: Selection, b: Selection) =>
  a.kind === b.kind && (a.kind !== 'folder' || (b.kind === 'folder' && a.folderId === b.folderId));
const parseSelection = (f: string | null): Selection =>
  !f || f === 'all' ? { kind: 'all' } : f === 'scheduled' ? { kind: 'scheduled' } : { kind: 'folder', folderId: f };
const MOVE_LIKE = new Set<Op>(['archive', 'delete', 'purge', 'junk', 'not_junk', 'move']);
const DONE: Partial<Record<Op, string>> = {
  archive: 'Archived',
  delete: 'Moved to Deleted Items',
  purge: 'Deleted for good',
  junk: 'Moved to Junk Email',
  not_junk: 'Moved to Inbox',
  move: 'Moved',
};
const READ_DWELL_MS = 1_500;

function writeUrl(sel: Selection, open: Open | null, mode: 'push' | 'replace') {
  const u = new URL(window.location.href);
  u.searchParams.set('f', sel.kind === 'folder' ? sel.folderId : sel.kind);
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
  canEdit,
}: {
  /** The Edit grant: actions, folder menus, multi-select. Without it the page is read-only. */
  canEdit: boolean;
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
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [moduleNotice, setModuleNotice] = useState<ModuleNotice>(null);
  const [confirmPurge, setConfirmPurge] = useState<ConversationRow[] | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [compose, setCompose] = useState<{ init: ComposeInit; key: string } | null>(null);
  const [pending, setPending] = useState<{ outboxId: string; releaseAt: string; subject: string } | null>(null);
  const [scheduledCount, setScheduledCount] = useState(0);
  const [scheduledKey, setScheduledKey] = useState(0);

  const listReq = useRef(0);
  const threadReq = useRef(0);
  const seqs = useRef<Map<string, number> | null>(null);
  const failuresRef = useRef(0);

  // Refs mirror state for callbacks that outlive a render (poll, popstate).
  const live = useRef({ sel, filter, open, boxes, list, search, checkedIds: new Set<string>() as ReadonlySet<string> });
  useEffect(() => {
    live.current = { sel, filter, open, boxes, list, search, checkedIds: checked };
  }, [sel, filter, open, boxes, list, search, checked]);

  /*
   * Selection, open conversation and filter change through these, which
   * update the ref AT ONCE as well as the state. Callbacks that run before
   * the next paint (a poll landing right after a folder switch, an action's
   * auto-advance) must never see the previous folder or conversation — that
   * once let a poll reload the old folder over the new one.
   */
  const changeSel = useCallback((s: Selection) => {
    live.current = { ...live.current, sel: s };
    setSel(s);
  }, []);
  const changeOpen = useCallback((o: Open | null) => {
    live.current = { ...live.current, open: o };
    setOpen(o);
  }, []);

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
    // The person moved on while this was in flight: its rows belong to another view.
    if (!sameSelection(s, live.current.sel) || f !== live.current.filter) return;
    if (!res.ok) {
      if (!opts.silent) setList({ ...EMPTY_LIST, status: 'error' });
      return;
    }
    setList((prev) => {
      if (!opts.silent || prev.rows.length <= res.data.rows.length) return { ...res.data, status: 'ready', loadingMore: false };
      // Keep pages already scrolled into, below the refreshed first page.
      // Everything the server now lists — pinned included, or a just-pinned
      // conversation would also linger below in its old place.
      const fresh = new Set([...res.data.rows, ...res.data.pinned].map((r) => `${r.mailboxId}~${r.key}`));
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

  const runOpRef = useRef<(op: Op, targets: ConversationRow[], opts?: { dest?: string; quiet?: boolean }) => Promise<void>>(async () => {});
  /**
   * autoRead: a deliberate open marks unread mail read after the dwell. The
   * conversation that slides into place after an archive/delete is NOT a
   * deliberate open, so it stays unread until the person actually reads it.
   */
  const openRow = useCallback(
    (row: ConversationRow, opts: { autoRead?: boolean } = {}) => {
      const o = { mailboxId: row.mailboxId, key: row.key };
      changeOpen(o);
      writeUrl(live.current.sel, o, 'replace');
      void loadThread(o, { reset: true });
      if (dwell.current) clearTimeout(dwell.current);
      // Only in the person's OWN mailboxes: an admin looking at a member's mail
      // must not mark it read in that member's Outlook just by opening it.
      const own = live.current.boxes.find((b) => b.id === row.mailboxId)?.own === true;
      if (canEdit && own && row.unread > 0 && opts.autoRead !== false) {
        dwell.current = setTimeout(() => {
          const cur = live.current.open;
          if (cur && cur.mailboxId === o.mailboxId && cur.key === o.key) void runOpRef.current('read', [row], { quiet: true });
        }, READ_DWELL_MS);
      }
    },
    [loadThread, canEdit, changeOpen],
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
    setNotices(res.data.notices);
    setScheduledCount(res.data.scheduled);
    setModuleNotice(res.data.moduleNotice);

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
    const viewing =
      s.kind === 'all'
        ? b.filter((x) => x.own).map((x) => x.id)
        : s.kind === 'folder'
          ? b.filter((x) => x.folders.some((fd) => fd.id === s.folderId)).map((x) => x.id)
          : [];
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
      changeSel(s);
      setSearch({ q: '', scope: 'here', status: 'idle', rows: [] });
      setChecked(new Set());
      changeOpen(null);
      setThread({ status: 'idle', messages: [] });
      writeUrl(s, null, 'push');
      void loadList(s, live.current.filter);
      void touchFolder(s);
    },
    [loadList, touchFolder, changeSel, changeOpen],
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
      const s = parseSelection(p.get('f'));
      const o = parseOpen(p.get('c'));
      changeSel(s);
      changeOpen(o);
      void loadList(s, live.current.filter);
      if (o) void loadThread(o, { reset: true });
      else setThread({ status: 'idle', messages: [] });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [initialOpen, initialSelection, loadList, loadThread, touchFolder, changeSel, changeOpen]);

  const setListFilter = (f: ListFilter) => {
    live.current = { ...live.current, filter: f };
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

  // ── acting ──────────────────────────────────────────────────────────────
  const visibleRows = useCallback((): ConversationRow[] => {
    const { list: l, search: q } = live.current;
    return q.status !== 'idle' ? q.rows : [...l.pinned, ...l.rows];
  }, []);

  const runOp = useCallback(
    async (op: Op, targets: ConversationRow[], opts: { dest?: string; quiet?: boolean } = {}) => {
      if (!canEdit || targets.length === 0) return;
      const ids = new Set(targets.map(rowId));
      const { sel: s, boxes: b, search: q, open: o } = live.current;
      const scopeFolderIds =
        q.status !== 'idle'
          ? [...new Set(targets.map((t) => t.folderId).filter((x): x is string => Boolean(x)))]
          : folderIdsFor(s, b);

      // Optimistic: what the person asked for, on screen now.
      if (MOVE_LIKE.has(op)) {
        const flat = visibleRows();
        const openIdx = o ? flat.findIndex((r) => rowId(r) === rowId(o)) : -1;
        const remaining = flat.filter((r) => !ids.has(rowId(r)));
        setList((l) => ({ ...l, pinned: l.pinned.filter((r) => !ids.has(rowId(r))), rows: l.rows.filter((r) => !ids.has(rowId(r))) }));
        setSearch((x) => ({ ...x, rows: x.rows.filter((r) => !ids.has(rowId(r))) }));
        if (o && ids.has(rowId(o))) {
          // Like Outlook: the next conversation takes its place.
          const next = remaining[Math.min(Math.max(openIdx, 0), remaining.length - 1)];
          if (next) openRow(next, { autoRead: false });
          else {
            changeOpen(null);
            setThread({ status: 'idle', messages: [] });
            writeUrl(s, null, 'replace');
          }
        }
      } else if (op === 'read' || op === 'unread') {
        const flip = (r: ConversationRow) => (ids.has(rowId(r)) ? { ...r, unread: op === 'read' ? 0 : r.count } : r);
        setList((l) => ({ ...l, pinned: l.pinned.map(flip), rows: l.rows.map(flip) }));
        setSearch((x) => ({ ...x, rows: x.rows.map(flip) }));
        if (o && ids.has(rowId(o))) setThread((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, isRead: op === 'read' })) }));
      }
      setChecked((c) => (c.size ? new Set() : c));

      const res = await conversationOpAction({
        items: targets.map((t) => ({ mailboxId: t.mailboxId, key: t.key })),
        scopeFolderIds,
        op,
        destFolderId: opts.dest,
        requestId: crypto.randomUUID(),
      });
      if (!res.ok) {
        setBanner({ tone: 'error', text: res.message });
        void loadList(live.current.sel, live.current.filter, { silent: true });
        if (live.current.open) void loadThread(live.current.open, { background: true });
        return;
      }
      if (!opts.quiet && DONE[op]) {
        setBanner({ tone: 'ok', text: `${DONE[op]}: ${targets.length === 1 ? (targets[0].subject || 'conversation') : `${targets.length} conversations`}.` });
      }
      kick.current(1_500); // folder counts and Outlook's answer, shortly
    },
    [canEdit, loadList, loadThread, openRow, visibleRows, changeOpen],
  );
  useEffect(() => {
    runOpRef.current = runOp;
  }, [runOp]);

  /** Delete, or — in Deleted Items / Junk — delete for good after asking. */
  const requestDelete = useCallback(
    (targets: ConversationRow[], wellKnown: string | null) => {
      if (deleteOp(wellKnown) === 'purge') setConfirmPurge(targets);
      else void runOp('delete', targets);
    },
    [runOp],
  );

  const togglePin = useCallback(
    async (row: ConversationRow, pinned: boolean) => {
      if (!row.folderId) return;
      const res = await pinAction({ mailboxId: row.mailboxId, folderId: row.folderId, key: row.key, pinned });
      if (!res.ok) setBanner({ tone: 'error', text: res.message });
      void loadList(live.current.sel, live.current.filter, { silent: true });
    },
    [loadList],
  );

  const onFolderOp = useCallback(async (f: FolderOp) => {
    const res = await folderAction(f);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.message });
      return;
    }
    const fresh = await mailboxesAction();
    if (fresh.ok) setBoxes(fresh.data);
    setBanner({ tone: 'ok', text: f.op === 'create' ? `Created “${f.name}”.` : f.op === 'rename' ? `Renamed to “${f.name}”.` : 'Folder moved to Deleted Items.' });
    if (f.op === 'delete' && live.current.sel.kind === 'folder' && live.current.sel.folderId === f.folderId) {
      const inbox = live.current.boxes.find((x) => x.id === f.mailboxId)?.folders.find((x) => x.wellKnown === 'inbox');
      if (inbox) select({ kind: 'folder', folderId: inbox.id });
    }
  }, [select]);

  const onCheck = useCallback(
    (row: ConversationRow, range: boolean) => {
      const id = rowId(row);
      setChecked((prev) => {
        const next = new Set(prev);
        if (range && anchor.current) {
          const flat = visibleRows().map(rowId);
          const a = flat.indexOf(anchor.current);
          const z = flat.indexOf(id);
          if (a !== -1 && z !== -1) {
            for (const k of flat.slice(Math.min(a, z), Math.max(a, z) + 1)) next.add(k);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        anchor.current = id;
        return next;
      });
    },
    [visibleRows],
  );

  // Delete key acts on the selection, else the open conversation; Esc clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape') setChecked((c) => (c.size ? new Set() : c));
      if (e.key !== 'Delete' || !canEdit) return;
      const flat = visibleRows();
      const { open: o, sel: s, boxes: b } = live.current;
      const picked = live.current.checkedIds.size
        ? flat.filter((r) => live.current.checkedIds.has(rowId(r)))
        : o
          ? flat.filter((r) => rowId(r) === rowId(o))
          : [];
      if (!picked.length) return;
      e.preventDefault();
      const wk = s.kind === 'folder' ? (b.flatMap((x) => x.folders).find((f) => f.id === s.folderId)?.wellKnown ?? null) : 'inbox';
      requestDelete(picked, wk);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canEdit, requestDelete, visibleRows]);

  // ── writing ─────────────────────────────────────────────────────────────
  const openCompose = useCallback(async (kind: ComposeKind | 'draft', opts: { sourceMessageId?: string; draftMessageId?: string; mailboxId?: string } = {}) => {
    const res = await composeStartAction({ kind: kind === 'draft' ? 'new' : kind, ...opts });
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.message });
      return;
    }
    setCompose({ init: res.data, key: crypto.randomUUID() });
  }, []);

  const onSent = useCallback((r: SentResult) => {
    setCompose(null);
    if (r.status === 'held') setPending({ outboxId: r.outboxId, releaseAt: r.releaseAt, subject: r.subject });
    else {
      setBanner({ tone: 'ok', text: `Scheduled “${r.subject}” for ${fullStamp(r.releaseAt)}.` });
      setScheduledKey((k) => k + 1);
      kick.current(500);
    }
  }, []);

  const undoSend = useCallback(async (outboxId: string) => {
    const res = await undoSendAction({ outboxId });
    setPending(null);
    if (!res.ok) {
      setBanner({ tone: 'error', text: res.message });
      return;
    }
    if (res.data) setCompose({ init: res.data, key: crypto.randomUUID() });
  }, []);

  // ── older mail ──────────────────────────────────────────────────────────
  // Busy until Outlook's answer moves the folder's "loaded since" (the poll
  // brings it), or 90 s at most.
  const [older, setOlder] = useState<{ folderId: string; from: string | null } | null>(null);
  useEffect(() => {
    if (!older) return;
    const t = setTimeout(() => setOlder(null), 90_000);
    return () => clearTimeout(t);
  }, [older]);
  const olderBusy = Boolean(older && current && older.folderId === current.id && current.oldestLoadedAt === older.from);
  const requestOlder = async () => {
    if (!current) return;
    const res = await loadOlderAction({ folderId: current.id });
    if (!res.ok) return setBanner({ tone: 'error', text: res.message });
    if (!res.data.queued) {
      const mins = Math.max(1, Math.ceil((res.data.retryAfterSeconds ?? 0) / 60));
      return setBanner({
        tone: 'error',
        text: res.data.retryAfterSeconds ? `Older mail can be fetched six times an hour per mailbox. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` : 'That folder is no longer here.',
      });
    }
    setOlder({ folderId: current.id, from: current.oldestLoadedAt });
    kick.current(2_500);
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
        ? s.kind === 'folder'
          ? b.filter((x) => x.folders.some((f) => f.id === s.folderId)).map((x) => x.id)
          : b.filter((x) => x.own).map((x) => x.id)
        : b.map((x) => x.id);
      const res = await searchAction({ q, mailboxIds, folderIds: here && s.kind === 'folder' ? [s.folderId] : null });
      setSearch((p) => (p.q !== q || p.scope !== scope ? p : { q, scope, status: res.ok ? 'ready' : 'error', rows: res.ok ? res.data : [] }));
    }, 280);
  }, []);

  // ── render ──────────────────────────────────────────────────────────────
  const title = sel.kind === 'all' ? 'All inboxes' : sel.kind === 'scheduled' ? 'Scheduled' : (current?.name ?? 'Folder');
  const subtitle = sel.kind === 'all' ? `${ownBoxes.length} mailboxes` : sel.kind === 'scheduled' ? 'Waiting to be sent' : (current?.box.address ?? '');
  const unread = sel.kind === 'all' ? ownBoxes.reduce((n, b) => n + (b.folders.find((f) => f.wellKnown === 'inbox')?.unread ?? 0), 0) : (current?.unread ?? 0);
  const searching = search.status !== 'idle';
  const olderFooter =
    sel.kind === 'folder' && !searching && current ? <LoadOlder folder={current} busy={olderBusy} onLoad={() => void requestOlder()} /> : null;
  const rows = searching ? search.rows : list.rows;
  const selectedKey = open ? `${open.mailboxId}~${open.key}` : null;
  const showMailbox = boxes.length > 1 && (sel.kind === 'all' || (searching && search.scope === 'everywhere'));
  const currentFolderIds = useMemo(() => new Set(folderIds), [folderIds]);
  const openAddress = open && boxes.length > 1 ? addressOf(open.mailboxId) : null;
  const settingUp = scopeBoxes.some((b) => b.health === 'setting_up') || (current ? !current.seeded : false);

  const allVisible = searching ? rows : [...list.pinned, ...rows];
  const wellKnownOf = (folderId: string | null) => (folderId ? (folderById.get(folderId)?.wellKnown ?? null) : null);
  const viewWellKnown = sel.kind === 'all' ? 'inbox' : (current?.wellKnown ?? null);
  const openRowData: ConversationRow | null = open
    ? (allVisible.find((r) => rowId(r) === rowId(open)) ??
      (thread.messages.length
        ? {
            key: open.key,
            mailboxId: open.mailboxId,
            folderId: thread.messages.find((m) => m.folderId && currentFolderIds.has(m.folderId))?.folderId ?? thread.messages[0].folderId,
            latestMessageId: thread.messages[0].id,
            subject: thread.messages[0].subject,
            who: '',
            whoAddress: '',
            outbound: false,
            preview: '',
            lastAt: thread.messages[0].at,
            count: thread.messages.length,
            unread: thread.messages.filter((m) => !m.isRead).length,
            hasAttachments: false,
            firstAttachment: null,
            attachmentCount: 0,
            important: false,
            hasDraft: false,
            pinned: false,
          }
        : null))
    : null;
  const openBox = open ? boxes.find((b) => b.id === open.mailboxId) : undefined;
  const openWellKnown = searching ? wellKnownOf(openRowData?.folderId ?? null) : viewWellKnown;
  // A conversation spans folders: answer the newest message someone sent us (not our own
  // sent copy or a draft), and continue the draft itself when there is one.
  const draftMsg = thread?.messages.find((m) => m.isDraft);
  const replyTarget = thread?.messages.find((m) => !m.outbound && !m.isDraft) ?? thread?.messages.find((m) => !m.isDraft);
  const picked = allVisible.filter((r) => checked.has(rowId(r)));
  const pickedBoxes = new Set(picked.map((r) => r.mailboxId));
  const pickedBox = pickedBoxes.size === 1 ? boxes.find((b) => b.id === [...pickedBoxes][0]) : undefined;
  const pickedWellKnown = searching ? (new Set(picked.map((r) => wellKnownOf(r.folderId))).size === 1 ? wellKnownOf(picked[0]?.folderId ?? null) : null) : viewWellKnown;

  return (
    <div className="grid h-full min-h-0 grid-cols-[248px_minmax(330px,400px)_minmax(0,1fr)] bg-white">
      <FolderPane
        mailboxes={boxes}
        selection={sel}
        onSelect={select}
        canEdit={canEdit}
        onFolderOp={(f) => void onFolderOp(f)}
        onNewMail={canEdit && ownBoxes.length ? () => void openCompose('new', sel.kind === 'folder' && current?.box.own ? { mailboxId: current.box.id } : {}) : undefined}
        scheduledCount={scheduledCount}
      />

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

          {sel.kind === 'scheduled' ? null : (
          <>
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
          </>
          )}
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
        {moduleNotice ? (
          <div
            role={moduleNotice.tone === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2 border-b px-4 py-2 text-[12px] ${
              moduleNotice.tone === 'error' ? 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]' : 'border-[#f5e2b8] bg-[#fdf6e7] text-[#8a5a00]'
            }`}
          >
            <Icon name="alert-triangle" size={13} className="mt-px shrink-0" />
            <span className="min-w-0 flex-1">{moduleNotice.text}</span>
          </div>
        ) : null}
        {notices[0] ? (
          <div role="alert" className="flex items-start gap-2 border-b border-[#f7cfd1] bg-[#fce9ea] px-4 py-2 text-[12px] text-[#b02a30]">
            <Icon name="alert-triangle" size={13} className="mt-px shrink-0" />
            <span className="min-w-0 flex-1">{notices[0].body}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => {
                const id = notices[0].id;
                setNotices((n) => n.filter((x) => x.id !== id));
                void dismissNoticeAction({ id });
              }}
              className="shrink-0 font-semibold opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </div>
        ) : null}
        {banner ? (
          <div
            role={banner.tone === 'error' ? 'alert' : 'status'}
            className={`flex items-start gap-2 border-b px-4 py-2 text-[12px] ${
              banner.tone === 'error' ? 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]' : 'border-line bg-canvas text-ink-600'
            }`}
          >
            <Icon name={banner.tone === 'error' ? 'alert-triangle' : 'check'} size={13} className="mt-px shrink-0" />
            <span className="min-w-0 flex-1">{banner.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setBanner(null)} className="shrink-0 font-semibold opacity-70 hover:opacity-100">
              ×
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {sel.kind === 'scheduled' ? (
            <ScheduledList
              refreshKey={scheduledKey}
              addressOf={addressOf}
              onError={(m) => setBanner({ tone: 'error', text: m })}
              onEdit={(init) => {
                setCompose({ init, key: crypto.randomUUID() });
                kick.current(500);
              }}
            />
          ) : (!searching && list.status === 'loading') || (searching && search.status === 'loading' && search.rows.length === 0) ? (
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
              >
                {olderFooter}
              </Empty>
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
              checked={canEdit ? checked : null}
              onCheck={onCheck}
              footer={olderFooter}
            />
          )}
        </div>
      </section>

      {compose ? (
        <Composer
          key={compose.key}
          init={compose.init}
          onSent={onSent}
          onClose={(saved) => {
            setCompose(null);
            if (saved) {
              setBanner({ tone: 'ok', text: 'Saved to Drafts.' });
              kick.current(2_500);
            }
          }}
          onDiscarded={() => {
            setCompose(null);
            setBanner({ tone: 'ok', text: 'Draft discarded.' });
            kick.current(2_500);
          }}
        />
      ) : sel.kind === 'scheduled' ? (
        <div className="grid h-full place-items-center bg-canvas px-8">
          <div className="max-w-[36ch] text-center">
            <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-white text-ink-300 shadow-[0_1px_2px_rgba(8,32,47,.06)]">
              <Icon name="clock" size={20} />
            </span>
            <p className="text-[14px] font-semibold text-ink-700">Scheduled mail waits here</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">Nothing reaches Outlook until its time. “Edit or cancel” brings a message back to change it.</p>
          </div>
        </div>
      ) : (
      <ReadingPane
        thread={thread}
        currentFolderIds={currentFolderIds}
        mailbox={openAddress}
        onRetry={() => open && void loadThread(open, { reset: true })}
        now={now}
        toolbar={
          canEdit && openRowData && openBox && thread.status === 'ready' ? (
            <ConversationToolbar
              ctx={{
                wellKnown: openWellKnown,
                hasArchive: openBox.folders.some((f) => f.wellKnown === 'archive'),
                anyUnread: thread.messages.some((m) => !m.isRead),
                pinned: allVisible.some((r) => rowId(r) === rowId(openRowData)) ? openRowData.pinned : null,
                canPin: Boolean(openRowData.folderId) && !searching,
              }}
              folders={openBox.folders.filter((f) => !currentFolderIds.has(f.id))}
              onOp={(op, dest) => (op === 'delete' || op === 'purge' ? requestDelete([openRowData], openWellKnown) : void runOp(op, [openRowData], { dest }))}
              onPin={(p) => void togglePin(openRowData, p)}
              isDraft={Boolean(draftMsg) && (openWellKnown === 'drafts' || !replyTarget)}
              onReply={
                openBox.own
                  ? (kind: ReplyKind) =>
                      void (kind === 'draft'
                        ? draftMsg && openCompose('draft', { draftMessageId: draftMsg.id })
                        : replyTarget && openCompose(kind, { sourceMessageId: replyTarget.id }))
                  : undefined
              }
            />
          ) : null
        }
      />
      )}

      {pending ? <UndoSendBar pending={pending} onUndo={() => void undoSend(pending.outboxId)} onDone={() => {
        setPending(null);
        setBanner({ tone: 'ok', text: `Sent “${pending.subject}”.` });
        kick.current(4_000);
      }} /> : null}

      <FloatingBar
        open={canEdit && picked.length > 0}
        lead={<BarCount n={picked.length} label="selected" />}
        onClose={() => setChecked(new Set())}
      >
        <BarAction icon="mail" label="Read" onClick={() => void runOp('read', picked)} />
        <BarAction icon="mail" label="Unread" onClick={() => void runOp('unread', picked)} />
        <BarAction icon="archive" label="Archive" onClick={() => void runOp('archive', picked)} disabled={pickedWellKnown === 'archive'} />
        {pickedBox ? (
          <MoveTo folders={pickedBox.folders.filter((f) => !currentFolderIds.has(f.id))} exclude={null} onPick={(id) => void runOp('move', picked, { dest: id })}>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 py-1.5 text-[13px] font-semibold text-ink-700 transition-colors hover:bg-canvas hover:text-ink-900">
              <Icon name="folder" size={14} />
              Move
              <Icon name="chevron-up" size={12} className="opacity-60" />
            </span>
          </MoveTo>
        ) : null}
        {pickedWellKnown === 'junkemail' ? (
          <BarAction icon="inbox" label="Not junk" onClick={() => void runOp('not_junk', picked)} />
        ) : (
          <BarAction icon="ban" label="Junk" onClick={() => void runOp('junk', picked)} />
        )}
        <BarAction
          icon="trash"
          label={deleteOp(pickedWellKnown) === 'purge' ? 'Delete forever' : 'Delete'}
          tone="danger"
          onClick={() => requestDelete(picked, pickedWellKnown)}
        />
      </FloatingBar>

      {confirmPurge ? (
        <Dialog
          title={confirmPurge.length === 1 ? 'Delete this conversation for good?' : `Delete ${confirmPurge.length} conversations for good?`}
          tone="danger"
          confirmLabel="Delete for good"
          onConfirm={() => void runOp('purge', confirmPurge)}
          onClose={() => setConfirmPurge(null)}
        >
          <p>They are removed from Outlook too, and can’t be recovered from Deleted Items.</p>
        </Dialog>
      ) : null}
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

/**
 * The undo window. Counts down from the server's release time (not a local
 * guess), then asks the server to send at once; the cron is the fallback if
 * this tab closes first.
 */
function UndoSendBar({
  pending,
  onUndo,
  onDone,
}: {
  pending: { outboxId: string; releaseAt: string; subject: string };
  onUndo: () => void;
  onDone: () => void;
}) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((Date.parse(pending.releaseAt) - Date.now()) / 1000)));
  const fired = useRef(false);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  useEffect(() => {
    const tick = setInterval(() => {
      const ms = Date.parse(pending.releaseAt) - Date.now();
      setLeft(Math.max(0, Math.ceil(ms / 1000)));
      if (ms <= 0 && !fired.current) {
        fired.current = true;
        clearInterval(tick);
        void releaseOutboxAction({ outboxId: pending.outboxId }).finally(() => done.current());
      }
    }, 200);
    return () => clearInterval(tick);
  }, [pending]);
  return (
    <FloatingBar
      open
      align="stack"
      lead={
        <span role="status" className="inline-flex items-center gap-2 pr-1 text-[13px] text-ink-700">
          <Spinner />
          Sending “{pending.subject.slice(0, 40)}” in {left}s
        </span>
      }
    >
      <BarAction icon="rotate-ccw" label="Undo" onClick={onUndo} />
    </FloatingBar>
  );
}
