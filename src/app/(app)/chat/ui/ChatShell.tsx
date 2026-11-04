'use client';

/**
 * The Chat screen: Teams' layout, Microsoft's conversations. The list is read again
 * every minute, and the open conversation more often, so what happens in Teams shows
 * here within the minute and Microsoft's version always wins.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover, Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { ChatList, ChatSummary } from '@/lib/msteams/types';
import { connectHref, goToMicrosoft, Notice, PersonPicker, StatusNotices, useOnline } from '../../msteams-ui/shared';
import type { ModulePage } from '../../msteams-ui/page-data';
import { favoriteAction } from '../actions';
import { colorFor, initials, listTime } from './format';
import { Conversation } from './Conversation';
import { NewChatDialog, NewTeamDialog } from './NewDialogs';

const POLL_MS = 60_000;

type Filter = 'unread' | 'channels' | 'chats' | 'meetings';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'unread', label: 'Unread' },
  { key: 'channels', label: 'Channels' },
  { key: 'chats', label: 'Chats' },
  { key: 'meetings', label: 'Meeting chats' },
];

const matches = (c: ChatSummary, f: Filter | null) =>
  f === null || (f === 'unread' ? c.unread : f === 'channels' ? c.kind === 'channel' : f === 'chats' ? c.kind === 'oneOnOne' || c.kind === 'group' : c.kind === 'meeting');

export function ChatShell({ page }: { page: ModulePage }) {
  const online = useOnline();
  const lookOnly = !page.own;
  const [data, setData] = useState<ChatList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(page.refused);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [q, setQ] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'chat' | 'team' | null>(null);
  /** Read here since the last load, so the dot does not come back before Microsoft catches up. */
  const [readHere, setReadHere] = useState<Record<string, number>>({});
  /** Text of messages loaded in each conversation, for the search box. */
  const [loadedText, setLoadedText] = useState<Record<string, string>>({});

  const stamp = useRef(0);
  const load = useCallback(async () => {
    if (page.refused) return;
    const mine = Date.now();
    stamp.current = mine;
    try {
      const res = await fetch(`/api/msteams/chats${page.own ? '' : `?as=${page.ownerId}`}`, { cache: 'no-store' });
      if (stamp.current !== mine) {
        // A newer load replaced this one: close its response instead of leaving it open.
        void res.body?.cancel().catch(() => undefined);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setLoadError(body?.message ?? 'Your chats could not be loaded.');
        return;
      }
      setData((await res.json()) as ChatList);
      setLoadError(null);
    } catch {
      if (stamp.current === mine && navigator.onLine) setLoadError('Your chats could not be loaded.');
    } finally {
      if (stamp.current === mine) setLoading(false);
    }
  }, [page.own, page.ownerId, page.refused]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first load, then the poll
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void load();
    }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const chats = useMemo(
    () =>
      (data?.chats ?? []).map((c) => {
        const readAt = readHere[c.key];
        return readAt && (!c.lastAt || Date.parse(c.lastAt) <= readAt) ? { ...c, unread: false } : c;
      }),
    [data?.chats, readHere],
  );

  // The sidebar's Chat number, straight away rather than at its next poll. Own chats only.
  const unreadTotal = chats.filter((c) => c.unread).length;
  useEffect(() => {
    if (page.own && data) window.dispatchEvent(new CustomEvent('tapdash:chat-unread', { detail: unreadTotal }));
  }, [data, page.own, unreadTotal]);

  const term = q.trim().toLowerCase();
  const shown = chats.filter((c) => {
    if (!matches(c, filter)) return false;
    if (!term) return true;
    return [c.name, c.teamName ?? '', c.preview, ...c.members.map((m) => m.name), loadedText[c.key] ?? ''].some((s) => s.toLowerCase().includes(term));
  });
  const favorites = shown.filter((c) => c.favorite);
  const rest = shown.filter((c) => !c.favorite);
  const open = chats.find((c) => c.key === openKey) ?? null;

  const onLoaded = useCallback((key: string, text: string) => setLoadedText((cur) => (cur[key] === text ? cur : { ...cur, [key]: text })), []);
  const onRead = useCallback((key: string) => setReadHere((r) => ({ ...r, [key]: Date.now() })), []);

  const toggleFavorite = async (c: ChatSummary) => {
    setData((d) => (d ? { ...d, chats: d.chats.map((x) => (x.key === c.key ? { ...x, favorite: !c.favorite } : x)) } : d));
    const r = await favoriteAction({ key: c.key, on: !c.favorite });
    if (!r.ok) void load();
  };

  const writable = page.accounts.filter((a) => a.approved && a.status === 'ok');
  const ownerName = page.people.find((p) => p.userId === page.ownerId)?.name ?? 'someone else';

  return (
    <div className="flex h-full flex-col bg-white">
      <StatusNotices
        kind="chat"
        online={online}
        stale={data?.stale ?? null}
        accounts={page.own ? page.accounts : page.shownAccounts}
        lookingAt={lookOnly ? ownerName : null}
        waiting={page.waiting}
        onApprove={page.own ? (email) => goToMicrosoft(connectHref('chat', email)) : undefined}
      />
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-line">
          <div className="flex items-center gap-2 px-4 pb-2 pt-3">
            <h1 className="flex-1 text-[17px] font-semibold tracking-[-.01em] text-ink-900">Chat</h1>
            {loading ? <Spinner className="size-3.5 text-ink-400" /> : null}
            {!lookOnly ? (
              <Popover
                align="right"
                width={190}
                trigger={() => (
                  <span title="New" className={`grid size-8 place-items-center rounded-md ${online && writable.length ? 'cursor-pointer text-ink-700 hover:bg-canvas' : 'pointer-events-none text-ink-300'}`}>
                    <Icon name="pencil" size={16} />
                    <span className="sr-only">New</span>
                  </span>
                )}
              >
                {(close) => (
                  <div className="p-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        setDialog('chat');
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-ink-800 hover:bg-canvas"
                    >
                      <Icon name="message-square" size={14} /> New chat
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        setDialog('team');
                      }}
                      className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-ink-800 hover:bg-canvas"
                    >
                      <Icon name="users" size={14} /> New team
                    </button>
                  </div>
                )}
              </Popover>
            ) : null}
          </div>
          <div className="px-4">
            <PersonPicker people={page.people} value={page.ownerId} label="Whose chats" />
          </div>
          <div className="px-3 pt-2">
            <label className="flex items-center gap-2 rounded-md border border-line bg-canvas px-2.5 py-1.5 focus-within:border-ink-500 focus-within:bg-white">
              <Icon name="search" size={14} className="text-ink-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search loaded chats" aria-label="Search loaded chats" className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-800 outline-none placeholder:text-ink-400" />
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5 px-3 py-2" role="group" aria-label="Filter">
            {FILTERS.map((f) => {
              const on = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(on ? null : f.key)}
                  className={`cursor-pointer rounded-full border px-2.5 py-[3px] text-[12px] font-semibold ${on ? 'border-brand-900 bg-brand-900 text-white' : 'border-line bg-white text-ink-600 hover:border-ink-400'}`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-4">
            {favorites.length ? <Group label="Favorites" chats={favorites} openKey={openKey} onOpen={setOpenKey} onFavorite={lookOnly ? undefined : toggleFavorite} /> : null}
            <Group label={favorites.length ? 'Chats' : null} chats={rest} openKey={openKey} onOpen={setOpenKey} onFavorite={lookOnly ? undefined : toggleFavorite} />
            {data && shown.length === 0 ? <p className="px-4 py-8 text-center text-[12.5px] text-ink-400">{term || filter ? 'Nothing matches.' : 'No chats yet.'}</p> : null}
          </div>
        </aside>
        <main className="min-w-0 flex-1">
          {open ? (
            <Conversation
              key={open.key}
              chat={open}
              own={page.own}
              online={online}
              onRead={onRead}
              onLoaded={onLoaded}
              onListChanged={() => void load()}
            />
          ) : (
            <div className="grid h-full place-items-center bg-canvas text-center">
              <div>
                <Icon name="message-square" size={28} className="mx-auto text-ink-300" />
                <p className="mt-2 text-[13px] text-ink-500">Pick a chat to open it.</p>
              </div>
            </div>
          )}
        </main>
      </div>
      {dialog === 'chat' ? (
        <NewChatDialog
          accounts={writable}
          onClose={() => setDialog(null)}
          onCreated={(key) => {
            setDialog(null);
            void load().then(() => setOpenKey(key));
          }}
        />
      ) : null}
      {dialog === 'team' ? (
        <NewTeamDialog
          accounts={writable}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function Group({ label, chats, openKey, onOpen, onFavorite }: { label: string | null; chats: ChatSummary[]; openKey: string | null; onOpen: (key: string) => void; onFavorite?: (c: ChatSummary) => void }) {
  if (chats.length === 0) return null;
  return (
    <section>
      {label ? <h2 className="px-4 pb-1 pt-3 text-[11.5px] font-semibold tracking-[.02em] text-ink-500">{label}</h2> : null}
      <ul>
        {chats.map((c) => (
          <li key={c.key} className="group relative">
            <button
              type="button"
              data-chat={c.name}
              onClick={() => onOpen(c.key)}
              className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left ${openKey === c.key ? 'bg-brand-50' : 'hover:bg-canvas'}`}
            >
              <span aria-hidden className={`grid size-8 shrink-0 place-items-center text-[11.5px] font-semibold text-white ${c.kind === 'channel' ? 'rounded-md' : 'rounded-full'}`} style={{ background: colorFor(c.teamName ?? c.name) }}>
                {c.kind === 'channel' ? initials(c.teamName ?? c.name) : c.kind === 'meeting' ? <Icon name="calendar" size={14} /> : initials(c.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${c.unread ? 'font-bold text-ink-900' : 'font-medium text-ink-800'}`}>
                    {c.kind === 'channel' && c.teamName ? <span className="font-normal text-ink-500">{c.teamName} › </span> : null}
                    {c.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-400">{listTime(c.lastAt)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className={`min-w-0 flex-1 truncate text-[12px] ${c.unread ? 'font-semibold text-ink-700' : 'text-ink-500'}`}>{c.preview || ' '}</span>
                  {c.external ? <span className="shrink-0 rounded border border-[#f7e0af] bg-[#fdf1d8] px-1 text-[10px] font-semibold text-[#8a5a09]">External</span> : null}
                  {c.unread ? <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-brand-600" /> : null}
                </span>
              </span>
            </button>
            {onFavorite ? (
              <button
                type="button"
                aria-label={c.favorite ? `Remove ${c.name} from Favorites` : `Add ${c.name} to Favorites`}
                title={c.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
                onClick={() => onFavorite(c)}
                className={`absolute right-2 top-1.5 cursor-pointer rounded p-0.5 ${c.favorite ? 'text-brand-700' : 'hidden text-ink-400 hover:text-ink-700 group-hover:block'}`}
              >
                <Icon name="pin" size={12} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
