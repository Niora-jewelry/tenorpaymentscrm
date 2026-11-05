'use client';

/**
 * A record's Communication › Teams sub-tab: the conversations linked to it.
 *
 * Asks when it opens, not with the drawer, so Microsoft cannot hold the drawer up.
 * What each person can read is decided on the server (`lib/msteams/recordLinks.ts`):
 * this only draws the answer. The conversation itself is the same one the Chat module
 * shows, with the same polling and the same send path.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Dialog, EmptyState } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { AccountView, ChatList, ChatSummary, RecordChatLink, RecordChats } from '@/lib/msteams/types';
import { Notice, useOnline } from '../../msteams-ui/shared';
import { linkChatToRecordAction, unlinkChatFromRecordAction } from '../actions';
import { Conversation } from './Conversation';
import { NewChatDialog } from './NewDialogs';

const SEARCH = 'w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink-800 outline-none focus:border-ink-500';
const KIND_LABEL: Record<RecordChatLink['kind'], string> = { oneOnOne: 'Direct chat', group: 'Group chat', meeting: 'Meeting chat', channel: 'Channel' };
const noop = () => {};

const sameConversation = (a: ChatSummary, b: ChatSummary) =>
  a.kind === 'channel' ? a.teamId === b.teamId && a.channelId === b.channelId : a.chatId === b.chatId;

const whenLinked = (at: string) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function RecordChatsPanel({ recordId }: { recordId: string }) {
  const online = useOnline();
  const [data, setData] = useState<RecordChats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<RecordChatLink | null>(null);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/msteams/record-chats?record=${encodeURIComponent(recordId)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? 'The chats on this record could not be loaded.');
        return;
      }
      setData((await res.json()) as RecordChats);
      setError(null);
    } catch {
      setError('The chats on this record could not be loaded. Check your connection.');
    }
  }, [recordId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load, when the sub-tab opens
    void load();
  }, [load]);

  const links = useMemo(() => data?.links ?? [], [data]);
  const readable = links.filter((l) => l.chat);
  const open = readable.find((l) => l.id === openId) ?? readable[0] ?? null;

  if (!data) {
    if (error) {
      return (
        <div className="space-y-2">
          <p role="alert" className="text-[13px] font-medium text-[#b02a30]">{error}</p>
          <Button size="sm" variant="secondary" icon="refresh-cw" onClick={() => void load()}>Try again</Button>
        </div>
      );
    }
    return <p className="text-[13px] text-ink-400">Loading chats…</p>;
  }

  const writable = data.accounts.filter((a) => a.approved && a.status === 'ok');
  const canLink = data.canEdit && writable.length > 0 && data.configured && !data.impersonating;

  const unlink = async () => {
    if (!unlinking) return;
    const r = await unlinkChatFromRecordAction({ linkId: unlinking.id });
    if (!r.ok) {
      setUnlinkError(r.message);
      return;
    }
    setUnlinking(null);
    await load();
  };

  return (
    <div className="space-y-3">
      {!data.configured ? <PanelNote>Microsoft is not switched on for this CRM, so chats cannot be read here.</PanelNote> : null}
      {data.impersonating ? <PanelNote>Chats are not shown while signed in as someone else.</PanelNote> : null}
      {data.configured && !data.impersonating && !data.accounts.some((a) => a.approved) ? (
        <PanelNote>
          Connect your Microsoft account in <Link href="/chat" className="font-semibold underline">Chat</Link> to read and link chats here.
        </PanelNote>
      ) : null}
      {data.someUnavailable ? <PanelNote>Microsoft did not answer, so a chat you are in may be missing here. Try again in a moment.</PanelNote> : null}
      {error ? <p role="alert" className="text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}

      {links.length === 0 ? (
        <EmptyState
          icon="message-square"
          title="No chats linked yet"
          body="Link a Teams chat or channel about this merchant to keep it with the record."
          action={canLink ? <Button size="sm" variant="primary" icon="plus" onClick={() => setLinking(true)}>Link a chat</Button> : undefined}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-semibold text-ink-800">
              {links.length} linked {links.length === 1 ? 'chat' : 'chats'}
            </h3>
            {canLink ? <Button size="sm" variant="secondary" icon="plus" onClick={() => setLinking(true)}>Link a chat</Button> : null}
          </div>
          <ul className="space-y-1.5">
            {links.map((l) => (
              <LinkCard
                key={l.id}
                link={l}
                isOpen={open?.id === l.id}
                canEdit={data.canEdit}
                onOpen={() => setOpenId(l.id)}
                onUnlink={() => {
                  setUnlinkError(null);
                  setUnlinking(l);
                }}
              />
            ))}
          </ul>
        </>
      )}

      {open?.chat ? (
        <div className="overflow-hidden rounded-lg border border-line bg-white">
          {open.access === 'look' ? <Notice tone="info">Look only, through {open.lookingThrough}&rsquo;s account.</Notice> : null}
          {open.access === 'member' && !data.canEdit ? <Notice tone="info">You can read this chat here. To reply, open it in Chat.</Notice> : null}
          <div className="h-[560px]">
            <Conversation
              key={open.chat.key}
              chat={open.chat}
              own={open.access === 'member' && data.canEdit}
              online={online}
              onRead={noop}
              onLoaded={noop}
              onListChanged={noop}
              onRecord
            />
          </div>
        </div>
      ) : null}

      {linking ? (
        <LinkChatDialog
          recordId={recordId}
          accounts={writable}
          linked={readable.map((l) => l.chat!)}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            void load();
          }}
        />
      ) : null}

      {unlinking ? (
        <Dialog title="Unlink this chat?" confirmLabel="Unlink" onConfirm={() => void unlink()} onClose={() => setUnlinking(null)}>
          <p className="text-[13px] text-ink-600">
            &ldquo;{unlinking.title}&rdquo; comes off this record. The chat stays in Teams, and nothing in it changes.
          </p>
          {unlinkError ? <p role="alert" className="mt-2 text-[12.5px] font-medium text-[#b02a30]">{unlinkError}</p> : null}
        </Dialog>
      ) : null}
    </div>
  );
}

function PanelNote({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink-600">{children}</p>;
}

function LinkCard({ link, isOpen, canEdit, onOpen, onUnlink }: { link: RecordChatLink; isOpen: boolean; canEdit: boolean; onOpen: () => void; onUnlink: () => void }) {
  const readable = Boolean(link.chat);
  const body = (
    <>
      <Icon name={link.kind === 'channel' ? 'users' : 'message-square'} size={15} className="mt-0.5 shrink-0 text-ink-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink-800">
          {link.teamName ? <span className="font-normal text-ink-500">{link.teamName} › </span> : null}
          {link.title}
        </span>
        <span className="block truncate text-[11.5px] text-ink-500">
          {KIND_LABEL[link.kind]} · Linked by {link.linkedByName} on {whenLinked(link.linkedAt)}
        </span>
        {link.access === 'none' ? <span className="mt-0.5 block text-[11.5px] text-ink-500">Only people in this chat can read it.</span> : null}
        {link.access === 'unavailable' ? <span className="mt-0.5 block text-[11.5px] text-[#8a5a09]">Microsoft did not answer. Try again in a moment.</span> : null}
      </span>
    </>
  );
  return (
    <li className={`flex items-start gap-2 rounded-md border px-2.5 py-2 ${isOpen ? 'border-brand-300 bg-brand-50' : 'border-line bg-white'}`}>
      {readable ? (
        <button type="button" onClick={onOpen} aria-pressed={isOpen} className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left">
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">{body}</div>
      )}
      {canEdit ? (
        <button type="button" onClick={onUnlink} className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[11.5px] font-medium text-ink-500 hover:bg-canvas hover:text-ink-800">
          Unlink
        </button>
      ) : null}
    </li>
  );
}

function LinkChatDialog({ recordId, accounts, linked, onClose, onLinked }: { recordId: string; accounts: AccountView[]; linked: ChatSummary[]; onClose: () => void; onLinked: () => void }) {
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const res = await fetch('/api/msteams/chats', { cache: 'no-store' });
        if (!res.ok) throw new Error('refused');
        const list = (await res.json()) as ChatList;
        if (!gone) setChats(list.chats);
      } catch {
        if (!gone) {
          setChats([]);
          setError('Your chats could not be loaded. Try again.');
        }
      }
    })();
    return () => {
      gone = true;
    };
  }, []);

  const link = async (key: string) => {
    setBusy(true);
    setError(null);
    const r = await linkChatToRecordAction({ recordId, key });
    setBusy(false);
    if (r.ok) onLinked();
    else {
      setCreating(false);
      setError(r.message);
    }
  };

  const term = q.trim().toLowerCase();
  const shown = (chats ?? [])
    .filter((c) => !linked.some((l) => l.kind === c.kind && sameConversation(l, c)))
    .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.teamName ?? '').toLowerCase().includes(term));

  if (creating) {
    return <NewChatDialog accounts={accounts} onClose={() => setCreating(false)} onCreated={(key) => void link(key)} />;
  }

  return (
    <Dialog title="Link a chat" onClose={onClose} width={520}>
      <div className="space-y-2.5">
        <p className="text-[12.5px] text-ink-600">
          People who see all of this record&rsquo;s communication will see this chat&rsquo;s name and who linked it. Only people in the chat can read it.
        </p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your chats" aria-label="Search your chats" className={SEARCH} />
        {error ? <p role="alert" className="text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}
        <ul className="max-h-[300px] divide-y divide-line overflow-y-auto rounded-md border border-line">
          {chats === null ? <li className="px-3 py-6 text-center text-[12.5px] text-ink-400">Loading your chats…</li> : null}
          {chats !== null && shown.length === 0 ? <li className="px-3 py-6 text-center text-[12.5px] text-ink-400">{term ? 'Nothing matches.' : 'No chats to link.'}</li> : null}
          {shown.map((c) => (
            <li key={c.key}>
              <button type="button" disabled={busy} onClick={() => void link(c.key)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left hover:bg-canvas disabled:cursor-wait">
                <Icon name={c.kind === 'channel' ? 'users' : 'message-square'} size={14} className="shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink-800">
                    {c.teamName ? <span className="text-ink-500">{c.teamName} › </span> : null}
                    {c.name}
                  </span>
                  {accounts.length > 1 ? <span className="block truncate text-[11px] text-ink-400">{c.accountEmail}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="secondary" icon="plus" disabled={busy} onClick={() => setCreating(true)}>
          Start a new chat
        </Button>
      </div>
    </Dialog>
  );
}
