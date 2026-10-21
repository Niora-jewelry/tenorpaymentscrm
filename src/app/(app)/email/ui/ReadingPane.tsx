'use client';

/**
 * Right pane: one conversation, newest message first. The newest and any
 * unread messages open expanded; the rest fold to a single line, the way
 * Outlook shows a long thread.
 *
 * Bodies load lazily per message and render ONLY inside `BodyFrame`, a
 * sandboxed iframe with no script permission and its own CSP (frame.ts).
 * Remote images stay blocked until the reader asks for them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { fileSize, fullStamp, rowStamp } from '@/lib/mail/dates';
import { frameDocument, rewriteForFrame } from '@/lib/mail/content/frame';
import type { Addr, AttachmentView, MessageBody, MessageView } from '@/lib/mail/viewTypes';
import { messageBodyAction } from '../actions';
import { SWATCHES } from '@/proto/ui/tokens';
import { displayName, initials, swatchFor } from './people';
import { InviteCard } from './InviteCard';

export type Thread = { status: 'idle' | 'loading' | 'ready' | 'error'; messages: MessageView[] };

type BodyState = { status: 'loading' } | { status: 'ready'; body: MessageBody } | { status: 'error' };

export function ReadingPane({
  thread,
  currentFolderIds,
  mailbox,
  onRetry,
  now,
  toolbar,
}: {
  thread: Thread;
  /** The folder(s) being viewed; a message living elsewhere gets a folder chip. */
  currentFolderIds: ReadonlySet<string>;
  mailbox: string | null;
  onRetry: () => void;
  now: Date;
  /** Actions for this conversation; omitted for people who can only read. */
  toolbar?: React.ReactNode;
}) {
  // Expanded = the newest + every unread message, until the reader toggles
  // one; the override belongs to this thread only (keyed by its newest id).
  const threadKey = thread.messages[0]?.id ?? '';
  const [override, setOverride] = useState<{ key: string; ids: Set<string> } | null>(null);
  const expanded = useMemo(
    () =>
      override && override.key === threadKey
        ? override.ids
        : new Set(thread.messages.filter((m, i) => i === 0 || !m.isRead).map((m) => m.id)),
    [override, threadKey, thread.messages],
  );

  // Bodies load on demand; a missing entry renders as loading.
  const [bodies, setBodies] = useState<Record<string, BodyState>>({});
  const inflight = useRef(new Set<string>());
  const loadBody = useCallback(async (id: string) => {
    if (inflight.current.has(id)) return;
    inflight.current.add(id);
    const res = await messageBodyAction({ messageId: id });
    inflight.current.delete(id);
    setBodies((b) => ({ ...b, [id]: res.ok && res.data ? { status: 'ready', body: res.data } : { status: 'error' } }));
  }, []);

  useEffect(() => {
    if (thread.status !== 'ready') return;
    for (const id of expanded) if (!bodies[id]) void loadBody(id);
  }, [expanded, bodies, loadBody, thread.status]);

  const retryBody = (id: string) => {
    setBodies((b) => {
      const next = { ...b };
      delete next[id];
      return next;
    });
  };

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOverride({ key: threadKey, ids: next });
  };

  if (thread.status === 'idle') {
    return (
      <div className="grid h-full place-items-center bg-canvas px-8">
        <div className="text-center">
          <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-white text-ink-300 shadow-[0_1px_2px_rgba(8,32,47,.06)]">
            <Icon name="mail" size={20} />
          </span>
          <p className="text-[14px] font-semibold text-ink-700">Select a conversation</p>
          <p className="mt-1 text-[12.5px] text-ink-400">It opens here, newest message first.</p>
        </div>
      </div>
    );
  }

  if (thread.status === 'loading' && thread.messages.length === 0) {
    return (
      <div className="h-full overflow-y-auto bg-canvas px-6 py-6" aria-busy="true">
        <div className="skeleton h-5 w-2/3" />
        <div className="skeleton mt-2 h-3 w-40" />
        {[0, 1].map((i) => (
          <div key={i} className="mt-5 rounded-xl border border-line bg-white p-5">
            <div className="flex items-center gap-3">
              <div className="skeleton size-9 rounded-full" />
              <div className="flex-1">
                <div className="skeleton h-3 w-40" />
                <div className="skeleton mt-2 h-3 w-64" />
              </div>
            </div>
            <div className="skeleton mt-5 h-3 w-full" />
            <div className="skeleton mt-2 h-3 w-5/6" />
          </div>
        ))}
      </div>
    );
  }

  if (thread.status === 'error' || thread.messages.length === 0) {
    return (
      <div className="grid h-full place-items-center bg-canvas px-8">
        <div className="text-center">
          <p className="text-[14px] font-semibold text-ink-700">
            {thread.status === 'error' ? 'This conversation could not be loaded.' : 'This conversation is no longer here.'}
          </p>
          <p className="mt-1 text-[12.5px] text-ink-400">
            {thread.status === 'error' ? 'Check your connection and try again.' : 'It may have been moved or deleted in Outlook.'}
          </p>
          {thread.status === 'error' ? (
            <button type="button" onClick={onRetry} className="mt-3 text-[12.5px] font-semibold text-brand-700 hover:text-brand-900">
              Try again
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const newest = thread.messages[0];
  return (
    <article className="h-full overflow-y-auto bg-canvas" aria-label={newest.subject}>
      <header className="sticky top-0 z-[2] border-b border-line bg-canvas/95 px-6 pb-3 pt-5 backdrop-blur-sm">
        <h2 className="text-[19px] font-semibold leading-snug tracking-[-.01em] text-ink-900">{newest.subject}</h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-400">
          <span>
            {thread.messages.length} message{thread.messages.length === 1 ? '' : 's'}
          </span>
          {mailbox ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-[6px] rounded-full" style={{ background: swatchFor(mailbox).dot }} />
                {mailbox}
              </span>
            </>
          ) : null}
          {thread.status === 'loading' ? <Spinner /> : null}
        </p>
        {toolbar}
      </header>

      <ol className="space-y-3 px-6 py-5">
        {thread.messages.map((m) => (
          <li key={m.id}>
            <MessageCard
              message={m}
              expanded={expanded.has(m.id)}
              onToggle={() => toggle(m.id)}
              body={bodies[m.id]}
              onRetryBody={() => retryBody(m.id)}
              otherFolder={m.folderId && !currentFolderIds.has(m.folderId) ? m.folderName : null}
              now={now}
            />
          </li>
        ))}
      </ol>
    </article>
  );
}

function Avatar({ name, address, size }: { name: string; address: string; size: number }) {
  const s = swatchFor(address || name);
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-semibold"
      style={{ width: size, height: size, background: s.bg, color: s.text, fontSize: size * 0.36, boxShadow: `inset 0 0 0 1px ${s.border}` }}
    >
      {initials(name, address)}
    </span>
  );
}

function who(list: Addr[]): string {
  return list.map((a) => a.name || a.address).join(', ');
}

function MessageCard({
  message: m,
  expanded,
  onToggle,
  body,
  onRetryBody,
  otherFolder,
  now,
}: {
  message: MessageView;
  expanded: boolean;
  onToggle: () => void;
  body: BodyState | undefined;
  onRetryBody: () => void;
  otherFolder: string | null;
  now: Date;
}) {
  const [details, setDetails] = useState(false);
  const name = displayName(m.fromName, m.fromAddress);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 rounded-xl border border-line bg-white px-4 py-2.5 text-left shadow-[0_1px_2px_rgba(8,32,47,.03)] transition-colors hover:border-ink-300/70"
      >
        <Avatar name={m.fromName} address={m.fromAddress} size={28} />
        <span className={`w-40 shrink-0 truncate text-[13px] ${m.isRead ? 'text-ink-700' : 'font-semibold text-ink-900'}`}>{name}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-400">{m.preview}</span>
        {otherFolder ? <FolderChip name={otherFolder} /> : null}
        <span className="shrink-0 text-[11.5px] tabular text-ink-400">{m.at ? rowStamp(m.at, now) : ''}</span>
      </button>
    );
  }

  const toLine = [...m.to, ...m.cc];
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_3px_rgba(8,32,47,.05)]">
      <div className="flex items-start gap-3 px-5 pt-4">
        <Avatar name={m.fromName} address={m.fromAddress} size={36} />
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onToggle} className="flex w-full items-baseline gap-2 text-left" title="Collapse">
            <span className="truncate text-[14px] font-semibold text-ink-900">{name}</span>
            {m.fromName && m.fromAddress ? <span className="truncate text-[12px] text-ink-400">{m.fromAddress}</span> : null}
          </button>
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-500">
            <span className="min-w-0 truncate">
              <span className="text-ink-400">To </span>
              {toLine.length ? who(toLine.slice(0, 3)) : '—'}
              {toLine.length > 3 ? <span className="text-ink-400"> +{toLine.length - 3}</span> : null}
            </span>
            <button
              type="button"
              onClick={() => setDetails((d) => !d)}
              aria-expanded={details}
              className="shrink-0 rounded px-1 text-[11px] font-semibold text-ink-400 hover:bg-canvas hover:text-ink-700"
            >
              {details ? 'Hide' : 'Details'}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <time dateTime={m.at} className="text-[11.5px] tabular text-ink-400">
            {m.at ? fullStamp(m.at) : ''}
          </time>
          <span className="flex items-center gap-1.5">
            {m.isDraft ? <span className="text-[11px] font-semibold text-[#b02a30]">Draft</span> : null}
            {m.important ? <span className="text-[11px] font-semibold text-[#b02a30]">High importance</span> : null}
            {otherFolder ? <FolderChip name={otherFolder} /> : null}
          </span>
        </div>
      </div>

      {details ? (
        <dl className="mx-5 mt-3 grid grid-cols-[44px_1fr] gap-x-2 gap-y-1 rounded-lg bg-canvas px-3 py-2 text-[12px]">
          <dt className="text-ink-400">From</dt>
          <dd className="break-all text-ink-700">{m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}</dd>
          {(['to', 'cc', 'bcc'] as const).map((k) =>
            m[k].length ? (
              <FragmentRow key={k} label={k === 'to' ? 'To' : k === 'cc' ? 'Cc' : 'Bcc'} list={m[k]} />
            ) : null,
          )}
        </dl>
      ) : null}

      <div className="px-5 pb-5 pt-4">
        {m.meetingType && m.meetingType !== 'meetingResponse' ? <InviteCard messageId={m.id} kind={m.meetingType} /> : null}
        <Body body={body} message={m} onRetry={onRetryBody} />
      </div>
    </div>
  );
}

function FragmentRow({ label, list }: { label: string; list: Addr[] }) {
  return (
    <>
      <dt className="text-ink-400">{label}</dt>
      <dd className="break-all text-ink-700">{list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')}</dd>
    </>
  );
}

function FolderChip({ name }: { name: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-px text-[10.5px] font-medium text-ink-500">
      <Icon name="folder" size={10} />
      {name}
    </span>
  );
}

function Body({ body, message, onRetry }: { body: BodyState | undefined; message: MessageView; onRetry: () => void }) {
  const [images, setImages] = useState(false);
  const [quoted, setQuoted] = useState(false);

  if (!body || body.status === 'loading') {
    return (
      <div aria-busy="true">
        <div className="skeleton h-3 w-full" />
        <div className="skeleton mt-2 h-3 w-11/12" />
        <div className="skeleton mt-2 h-3 w-3/5" />
      </div>
    );
  }
  if (body.status === 'error') {
    return (
      <p className="text-[13px] text-ink-500">
        The message body could not be loaded.{' '}
        <button type="button" onClick={onRetry} className="font-semibold text-brand-700 hover:text-brand-900">
          Try again
        </button>
      </p>
    );
  }

  const b = body.body;
  if (b.state === 'protected') {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[13px] text-ink-600">
        <Icon name="lock" size={14} className="text-ink-400" />
        This message is protected by its sender’s organisation. Open it in Outlook to read it.
      </p>
    );
  }
  if (b.state === 'unavailable') {
    return (
      <p className="text-[13px] text-ink-500">
        Outlook didn’t return this message’s body.{' '}
        <button type="button" onClick={onRetry} className="font-semibold text-brand-700 hover:text-brand-900">
          Try again
        </button>
      </p>
    );
  }

  return (
    <>
      {b.externalImages > 0 && !images ? (
        <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink-600">
          <Icon name="image-off" size={14} className="shrink-0 text-ink-400" />
          <span className="min-w-0 flex-1">
            {b.externalImages === 1 ? 'One remote image is' : `${b.externalImages} remote images are`} hidden so the sender can’t tell you opened this.
          </span>
          <button
            type="button"
            onClick={() => setImages(true)}
            className="shrink-0 rounded-md border border-line bg-white px-2 py-1 text-[12px] font-semibold text-ink-700 transition-colors hover:border-ink-400"
          >
            Show images
          </button>
        </div>
      ) : null}

      <BodyFrame html={quoted && b.quoted ? b.html + b.quoted : b.html} messageId={message.id} loadImages={images} title={message.subject} />

      {b.quoted ? (
        <button
          type="button"
          onClick={() => setQuoted((q) => !q)}
          aria-expanded={quoted}
          title={quoted ? 'Hide quoted text' : 'Show quoted text'}
          className="mt-2 inline-flex h-5 items-center rounded-full border border-line bg-canvas px-2 text-ink-400 transition-colors hover:border-ink-300 hover:text-ink-700"
        >
          <Icon name="more-horizontal" size={14} />
          <span className="sr-only">{quoted ? 'Hide quoted text' : 'Show quoted text'}</span>
        </button>
      ) : null}

      {b.attachments.length ? <Attachments list={b.attachments} messageId={message.id} /> : null}
    </>
  );
}

/**
 * The ONLY place mail HTML is rendered. Sandboxed with NO script permission
 * (allow-same-origin lets us measure its height; with no script permission
 * the document itself can do nothing), links open in a new tab via the
 * base target, and the document's own CSP blocks every remote load.
 */
export function BodyFrame({ html, messageId, loadImages, title }: { html: string; messageId: string; loadImages: boolean; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(48);
  const doc = frameDocument(rewriteForFrame(html, messageId, loadImages));

  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const d = frame.contentDocument;
      if (!d?.documentElement) return;
      setHeight(Math.max(32, Math.ceil(d.documentElement.scrollHeight)));
    };
    const onLoad = () => {
      measure();
      const d = frame.contentDocument;
      if (d?.body) {
        ro?.disconnect();
        ro = new ResizeObserver(measure);
        ro.observe(d.body);
        d.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure, { once: true }));
      }
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [doc]);

  return (
    <iframe
      ref={ref}
      title={`Message: ${title}`}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      referrerPolicy="no-referrer"
      className="block w-full border-0"
      style={{ height }}
    />
  );
}

const EXT_TONE: Record<string, keyof typeof SWATCHES> = { pdf: 'red', doc: 'blue', docx: 'blue', xls: 'green', xlsx: 'green', csv: 'green', ppt: 'orange', pptx: 'orange', zip: 'brown' };

function Attachments({ list, messageId }: { list: AttachmentView[]; messageId: string }) {
  const files = list.filter((a) => a.kind !== 'reference').length;
  return (
    <div className="mt-4 border-t border-line-faint pt-3">
      <p className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-ink-500">
        <Icon name="paperclip" size={12} />
        {list.length} attachment{list.length === 1 ? '' : 's'}
        {files > 1 ? (
          <a
            href={`/api/mail/messages/${messageId}/attachments.zip`}
            download
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-ink-500 transition-colors hover:bg-canvas hover:text-ink-900"
          >
            <Icon name="download" size={12} /> Download all
          </a>
        ) : null}
      </p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
        {list.map((a) => {
          const ext = (a.name.split('.').pop() ?? '').toLowerCase().slice(0, 4);
          const tone = EXT_TONE[ext] ? SWATCHES[EXT_TONE[ext]] : swatchFor(ext);
          const isLink = a.kind === 'reference';
          return (
            <li key={a.id}>
              <a
                href={isLink ? undefined : `/api/mail/attachments/${a.id}`}
                download={isLink ? undefined : a.name}
                aria-disabled={isLink || undefined}
                aria-label={isLink ? `${a.name} — a cloud link, open it from Outlook` : `Download ${a.name}${a.size ? `, ${fileSize(a.size)}` : ''}`}
                title={isLink ? 'A link to a file in OneDrive or SharePoint — open it from Outlook' : `Download ${a.name}`}
                className={`group flex items-center gap-2.5 rounded-lg border border-line bg-white px-2.5 py-2 transition-colors ${
                  isLink ? 'cursor-default opacity-70' : 'hover:border-ink-300 hover:bg-canvas'
                }`}
              >
                <span
                  className="grid h-9 w-8 shrink-0 place-items-center rounded-md text-[9px] font-bold uppercase tracking-[.04em]"
                  style={{ background: tone.bg, color: tone.text }}
                >
                  {ext || 'file'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-ink-800">{a.name}</span>
                  <span className="block text-[11px] text-ink-400">{isLink ? 'Cloud link' : fileSize(a.size)}</span>
                </span>
                {isLink ? null : (
                  <Icon name="download" size={14} className="shrink-0 text-ink-300 transition-colors group-hover:text-ink-700" />
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
