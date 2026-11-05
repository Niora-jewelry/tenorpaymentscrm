'use client';

/**
 * One open conversation: its messages, the box to write in, and what Teams lets the
 * person do from here. Nothing is queued: a send that fails puts the text back in the
 * box with "Not sent" and a Retry button.
 */
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { ChatMember, ChatMessage, ChatSummary, Mention, MessagesPage } from '@/lib/msteams/types';
import { teamsCallUrl } from '@/lib/msteams/format';
import type { EditorHandle } from '@/app/(app)/email/ui/Editor';
import { Notice } from '../../msteams-ui/shared';
import { markReadAction, membersAction, newChannelAction, sendMessageAction } from '../actions';
import { fileSize } from './format';
import { MessageRow } from './Message';
import { uploadFile, type Uploaded } from './upload';

const Editor = dynamic(() => import('@/app/(app)/email/ui/Editor'), {
  ssr: false,
  loading: () => <div className="h-[92px]" />,
});

const POLL_MS = 20_000;

type Draft = {
  html: string;
  mentions: Mention[];
  files: Uploaded[];
  replyTo: ChatMessage | null;
  threadId: string | null;
};

const byTime = (a: ChatMessage, b: ChatMessage) => a.at.localeCompare(b.at);

function merge(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort(byTime);
}

export function Conversation({
  chat,
  own,
  online,
  onRead,
  onLoaded,
  onListChanged,
  onRecord,
  belowHeader,
}: {
  chat: ChatSummary;
  own: boolean;
  online: boolean;
  onRead: (key: string) => void;
  onLoaded: (key: string, text: string) => void;
  onListChanged: () => void;
  /** Shown inside a merchant record rather than in the Chat module. */
  onRecord?: boolean;
  belowHeader?: ReactNode;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [first, setFirst] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState<MessagesPage['stale']>(null);
  const [channelPeople, setChannelPeople] = useState<ChatMember[] | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [threadOf, setThreadOf] = useState<ChatMessage | null>(null);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [uploading, setUploading] = useState<{
    name: string;
    progress: number;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ draft: Draft; reason: string } | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [callNote, setCallNote] = useState(false);
  const [addingChannel, setAddingChannel] = useState(false);

  const editor = useRef<EditorHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const keepBottom = useRef(true);
  const restoreFrom = useRef<number | null>(null);
  const firstLoad = useRef(true);

  const isChannel = chat.kind === 'channel';
  const canWrite = own && online;
  const mineEmail = chat.accountEmail.toLowerCase();
  const people = useMemo(() => (isChannel ? (channelPeople ?? []) : chat.members).filter((m) => m.email.toLowerCase() !== mineEmail && m.id), [chat.members, channelPeople, isChannel, mineEmail]);
  const participantCount = isChannel ? (channelPeople?.length ?? 0) : chat.memberCount;

  /* ── loading ───────────────────────────────────────────────────────────── */

  const loadLatest = useCallback(async () => {
    try {
      const res = await fetch(`/api/msteams/messages?key=${encodeURIComponent(chat.key)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        setError(body?.message ?? 'This conversation could not be loaded.');
        return;
      }
      const page = (await res.json()) as MessagesPage;
      setStale(page.stale);
      setError(null);
      setMessages((cur) => merge(cur, page.messages));
      // Only the first page decides where "older" starts; later polls only add the newest.
      if (firstLoad.current) {
        firstLoad.current = false;
        setOlderCursor(page.olderCursor);
        setFirst(false);
      }
    } catch {
      if (navigator.onLine) setError('This conversation could not be loaded.');
    }
  }, [chat.key]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first load, then the poll
    void loadLatest();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void loadLatest();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadLatest]);

  // Read, for the owner only. Someone looking on changes nothing in the other person's Teams.
  const lastAt = messages[messages.length - 1]?.at;
  useEffect(() => {
    if (!own || !lastAt) return;
    onRead(chat.key);
    void markReadAction({ key: chat.key });
  }, [chat.key, lastAt, onRead, own]);

  useEffect(() => {
    onLoaded(chat.key, messages.map((m) => m.text).join(' \n'));
  }, [chat.key, messages, onLoaded]);

  useEffect(() => {
    if (!isChannel) return;
    let live = true;
    void membersAction({ key: chat.key }).then((r) => {
      if (live) setChannelPeople(r.ok ? r.data : []);
    });
    return () => {
      live = false;
    };
  }, [chat.key, isChannel]);

  const loadOlder = async () => {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/msteams/messages?key=${encodeURIComponent(chat.key)}&cursor=${encodeURIComponent(olderCursor)}`, { cache: 'no-store' });
      if (res.ok) {
        const page = (await res.json()) as MessagesPage;
        restoreFrom.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
        setMessages((cur) => merge(cur, page.messages));
        setOlderCursor(page.messages.length === 0 && !isChannel ? null : page.olderCursor);
      } else {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        setError(body?.message ?? 'Older messages could not be loaded.');
      }
    } catch {
      if (navigator.onLine) setError('Older messages could not be loaded.');
    } finally {
      setLoadingOlder(false);
    }
  };

  // Stays at the bottom as messages arrive, unless the person has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restoreFrom.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (keepBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, pending]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    keepBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60) void loadOlder();
  };

  /* ── writing ───────────────────────────────────────────────────────────── */

  const resetComposer = () => {
    editor.current?.clear();
    setMentions([]);
    setFiles([]);
    setReplyTo(null);
  };

  const send = async (retry?: Draft) => {
    if (!canWrite) return;
    const draft: Draft = retry ?? {
      html: editor.current?.getHTML() ?? '',
      mentions,
      files,
      replyTo,
      threadId: threadOf?.id ?? null,
    };
    const empty = !retry && (editor.current?.isEmpty() ?? true);
    if (empty && draft.files.length === 0) return;
    setFailed(null);
    resetComposer();
    keepBottom.current = true;

    const temp: ChatMessage = {
      id: `pending-${Date.now()}`,
      authorId: null,
      authorName: 'You',
      mine: true,
      at: new Date().toISOString(),
      html: draft.html,
      text: '',
      edited: false,
      deleted: false,
      system: false,
      thumbs: 0,
      thumbedByMe: false,
      files: draft.files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        url: f.url,
      })),
      quote: draft.replyTo
        ? {
            id: draft.replyTo.id,
            author: draft.replyTo.authorName,
            preview: draft.replyTo.text.slice(0, 200),
          }
        : null,
      replies: [],
      replyCount: 0,
      link: null,
    };
    if (!draft.threadId) setPending((p) => [...p, temp]);

    const r = await sendMessageAction({
      key: chat.key,
      html: draft.html,
      replyToId: draft.threadId ? null : (draft.replyTo?.id ?? null),
      threadId: draft.threadId,
      mentions: draft.mentions,
      files: draft.files.map((f) => ({ id: f.id, name: f.name, url: f.url })),
    });
    setPending((p) => p.filter((m) => m.id !== temp.id));
    if (!r.ok) {
      // Back in the box, exactly as it was.
      editor.current?.setHTML(draft.html);
      setMentions(draft.mentions);
      setFiles(draft.files);
      setReplyTo(draft.replyTo);
      setFailed({ draft, reason: r.message });
      return;
    }
    if (draft.threadId) {
      setMessages((cur) =>
        cur.map((m) =>
          m.id === draft.threadId
            ? {
                ...m,
                replies: [...m.replies, r.data],
                replyCount: m.replyCount + 1,
              }
            : m,
        ),
      );
    } else {
      setMessages((cur) => merge(cur, [r.data]));
    }
    onListChanged();
  };

  const pickFiles = async (list: FileList | null) => {
    if (!list || !canWrite) return;
    setUploadError(null);
    const emails = people.map((p) => p.email).filter(Boolean);
    for (const file of Array.from(list)) {
      setUploading({ name: file.name, progress: 0 });
      try {
        const done = await uploadFile(file, chat.key, isChannel ? [] : emails, (progress) => setUploading({ name: file.name, progress }));
        setFiles((cur) => [...cur, done]);
      } catch (e) {
        setUploadError(`${file.name}: ${e instanceof Error ? e.message : 'The file could not be uploaded.'}`);
      } finally {
        setUploading(null);
      }
    }
  };

  const mention = (m: ChatMember, typedAt: boolean) => {
    setMentionOpen(false);
    editor.current?.insertText(`${typedAt ? '' : '@'}${m.name}\u00a0`);
    setMentions((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, { id: m.id, name: m.name }]));
  };
  const typedAt = useRef(false);

  const call = () => {
    const emails = people.map((p) => p.email).filter(Boolean);
    if (emails.length === 0) return;
    window.open(teamsCallUrl(emails), '_blank', 'noopener,noreferrer');
    setCallNote(true);
  };

  const shown = [...messages, ...pending];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 truncate text-[15px] font-semibold text-ink-900">
            {isChannel && chat.teamName ? <span className="font-normal text-ink-500">{chat.teamName} ›</span> : null}
            <span className="truncate">{chat.name}</span>
            {chat.external ? <span className="shrink-0 rounded border border-[#f7e0af] bg-[#fdf1d8] px-1.5 text-[10.5px] font-semibold text-[#8a5a09]">External</span> : null}
          </h2>
          <p className="text-[12px] text-ink-500">
            {participantCount ? `${participantCount} participant${participantCount === 1 ? '' : 's'}` : isChannel ? 'Channel' : ''}
            {chat.accountEmail ? <span className="text-ink-400"> · {chat.accountEmail}</span> : null}
          </p>
        </div>
        {isChannel && own ? (
          <Button size="sm" variant="secondary" icon="plus" disabled={!online} onClick={() => setAddingChannel(true)}>
            Add channel
          </Button>
        ) : null}
        {!isChannel ? (
          <Button size="sm" variant="secondary" icon="phone" disabled={people.length === 0} onClick={call}>
            Call
          </Button>
        ) : null}
      </header>
      {belowHeader}
      {chat.external ? <Notice tone="warn">People outside your organization are in this chat.</Notice> : null}
      {callNote ? (
        <Notice
          tone="info"
          action={
            <button type="button" aria-label="Dismiss" onClick={() => setCallNote(false)} className="shrink-0">
              <Icon name="x" size={13} />
            </button>
          }
        >
          The call opens in Teams. If Teams did not open, open Teams on your computer and call from there.
        </Notice>
      ) : null}
      {stale === 'down' ? <Notice tone="warn">Microsoft is not responding. These are the last loaded messages.</Notice> : null}
      {stale === 'reconnect' ? <Notice tone="error">Microsoft stopped accepting this account. These messages are out of date until it is reconnected.</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto bg-canvas px-5 py-4">
        {olderCursor ? (
          <div className="mb-3 text-center">
            <button type="button" onClick={() => void loadOlder()} className="cursor-pointer text-[12px] font-semibold text-brand-700 hover:underline">
              {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </button>
          </div>
        ) : null}
        {first ? (
          <p className="py-10 text-center text-[12.5px] text-ink-400">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-[12.5px] text-ink-400">No messages in the last two weeks.</p>
        ) : null}
        <ol className="space-y-3">
          {shown.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              chatKey={chat.key}
              isChannel={isChannel}
              canWrite={canWrite && !m.id.startsWith('pending-')}
              onRecord={onRecord}
              sending={m.id.startsWith('pending-')}
              onQuote={(msg) => {
                setThreadOf(null);
                setReplyTo(msg);
                editor.current?.focus();
              }}
              onThread={(msg) => {
                setReplyTo(null);
                setThreadOf(msg);
                editor.current?.focus();
              }}
              onChanged={() => void loadLatest()}
              onLocal={(next) =>
                setMessages((cur) =>
                  cur.map((x) =>
                    x.id === next.id
                      ? next
                      : {
                          ...x,
                          replies: x.replies.map((r) => (r.id === next.id ? next : r)),
                        },
                  ),
                )
              }
            />
          ))}
        </ol>
      </div>

      {own ? (
        <div className="border-t border-line bg-white px-4 pb-3 pt-2">
          {failed ? (
            <div role="alert" className="mb-2 flex items-center gap-2 rounded-md border border-[#f7cfd1] bg-[#fce9ea] px-3 py-1.5 text-[12.5px] text-[#b02a30]">
              <Icon name="alert-triangle" size={13} />
              <span className="min-w-0 flex-1">
                <strong>Not sent.</strong> {failed.reason}
              </span>
              <button
                type="button"
                disabled={!online}
                onClick={() => {
                  const html = editor.current?.getHTML() ?? failed.draft.html;
                  void send({
                    ...failed.draft,
                    html,
                    mentions,
                    files,
                    replyTo,
                  });
                }}
                className="shrink-0 cursor-pointer rounded border border-current px-2 py-0.5 text-[12px] font-semibold disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          ) : null}
          {replyTo ? (
            <div className="mb-2 flex items-start gap-2 rounded-md border-l-[3px] border-brand-600 bg-canvas px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] font-semibold text-ink-700">Replying to {replyTo.authorName}</p>
                <p className="truncate text-[12px] text-ink-500">{replyTo.text}</p>
              </div>
              <button type="button" aria-label="Cancel reply" onClick={() => setReplyTo(null)} className="cursor-pointer text-ink-400 hover:text-ink-700">
                <Icon name="x" size={13} />
              </button>
            </div>
          ) : null}
          {threadOf ? (
            <div className="mb-2 flex items-start gap-2 rounded-md bg-brand-50 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-[11.5px] font-semibold text-ink-700">Replying in the thread of {threadOf.authorName}</p>
                <p className="truncate text-[12px] text-ink-500">{threadOf.text}</p>
              </div>
              <button type="button" aria-label="Back to a new post" onClick={() => setThreadOf(null)} className="cursor-pointer text-ink-400 hover:text-ink-700">
                <Icon name="x" size={13} />
              </button>
            </div>
          ) : null}
          {files.length || uploading ? (
            <ul className="mb-2 flex flex-wrap gap-2">
              {files.map((f) => (
                <li key={f.id} className="flex items-center gap-2 rounded-md border border-line bg-white px-2 py-1 text-[12px]">
                  <Icon name="file-text" size={13} className="text-ink-400" />
                  <span className="max-w-[200px] truncate font-medium text-ink-800">{f.name}</span>
                  <span className="text-ink-400">{fileSize(f.size)}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))} className="cursor-pointer text-ink-400 hover:text-ink-700">
                    <Icon name="x" size={11} />
                  </button>
                </li>
              ))}
              {uploading ? (
                <li className="flex items-center gap-2 rounded-md border border-line bg-white px-2 py-1 text-[12px] text-ink-500">
                  Uploading {uploading.name} · {Math.round(uploading.progress * 100)}%
                </li>
              ) : null}
            </ul>
          ) : null}
          {uploadError ? (
            <p role="alert" className="mb-2 text-[12px] font-medium text-[#b02a30]">
              {uploadError} Nothing was posted.
            </p>
          ) : null}
          {/* The mention list sits outside the rounded box: its overflow-hidden would clip it. */}
          <div className="relative">
            <div className={`overflow-hidden rounded-lg border ${canWrite ? 'border-line focus-within:border-ink-500' : 'border-line-faint opacity-70'}`}>
              <Editor
                initialHTML=""
                placeholder={online ? (threadOf ? 'Reply in the thread' : isChannel ? 'Start a new post' : 'Type a message') : 'You are offline'}
                minHeight={52}
                handleRef={editor}
                onChange={() => undefined}
                onEnter={() => void send()}
                onAt={() => {
                  if (people.length) {
                    typedAt.current = true;
                    setMentionOpen(true);
                  }
                }}
                toolbarExtra={
                  <span className="flex items-center gap-0.5">
                    <button
                      type="button"
                      title="Mention someone"
                      disabled={!canWrite || people.length === 0}
                      onClick={() => {
                        typedAt.current = false;
                        setMentionOpen((o) => !o);
                      }}
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-ink-500 hover:bg-canvas disabled:opacity-40"
                    >
                      <Icon name="at-sign" size={14} />
                      <span className="sr-only">Mention someone</span>
                    </button>
                    <button
                      type="button"
                      title="Attach a file"
                      disabled={!canWrite || Boolean(uploading)}
                      onClick={() => fileInput.current?.click()}
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-ink-500 hover:bg-canvas disabled:opacity-40"
                    >
                      <Icon name="paperclip" size={14} />
                      <span className="sr-only">Attach a file</span>
                    </button>
                    <button
                      type="button"
                      title="Send (Enter)"
                      disabled={!canWrite || Boolean(uploading)}
                      onClick={() => void send()}
                      className="ml-1 grid size-7 cursor-pointer place-items-center rounded-md bg-brand-900 text-white hover:bg-brand-800 disabled:opacity-40"
                    >
                      <Icon name="send" size={13} />
                      <span className="sr-only">Send</span>
                    </button>
                  </span>
                }
              />
            </div>
            {mentionOpen ? (
              <div className="absolute bottom-full left-3 z-30 mb-1 max-h-[240px] w-[260px] overflow-y-auto rounded-md border border-line bg-white py-1 shadow-lg">
                <p className="px-3 py-1 text-[11px] font-semibold text-ink-500">People in this {isChannel ? 'channel' : 'chat'}</p>
                {people.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => mention(p, typedAt.current)}
                    className="block w-full cursor-pointer truncate px-3 py-1.5 text-left text-[13px] text-ink-800 hover:bg-canvas"
                  >
                    {p.name} <span className="text-ink-400">{p.email}</span>
                  </button>
                ))}
                <button type="button" onClick={() => setMentionOpen(false)} className="block w-full cursor-pointer px-3 py-1 text-left text-[11.5px] text-ink-400 hover:bg-canvas">
                  Close
                </button>
              </div>
            ) : null}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void pickFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {!online ? <p className="mt-1.5 text-[11.5px] text-ink-500">You are offline. Sending is switched off until the connection returns. Nothing is queued.</p> : null}
        </div>
      ) : (
        <p className="border-t border-line bg-white px-5 py-3 text-[12.5px] text-ink-500">Look only. Nothing can be sent from someone else’s chats.</p>
      )}
      {addingChannel ? (
        <AddChannel
          chatKey={chat.key}
          teamName={chat.teamName ?? ''}
          onClose={() => setAddingChannel(false)}
          onDone={() => {
            setAddingChannel(false);
            onListChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function AddChannel({ chatKey, teamName, onClose, onDone }: { chatKey: string; teamName: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await newChannelAction({ key: chatKey, name });
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.message);
  };
  return (
    <Dialog title={`Add a channel to ${teamName || 'this team'}`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-[12px] font-semibold text-ink-600">
          Channel name
          <input
            value={name}
            maxLength={50}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-[13px] text-ink-800 outline-none focus:border-ink-500"
          />
        </label>
        {error ? <p className="text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            Add
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
