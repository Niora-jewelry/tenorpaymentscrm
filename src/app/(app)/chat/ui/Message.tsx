'use client';

/** One message, as Teams draws it: the words, a quoted message, files, a link card and the thumbs-up. */
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { ChatMessage, LinkPreview } from '@/lib/msteams/types';
import type { EditorHandle } from '@/app/(app)/email/ui/Editor';
import { deleteMessageAction, editMessageAction, linkPreviewAction, thumbAction } from '../actions';
import { colorFor, fileSize, initials, messageTime } from './format';

const Editor = dynamic(() => import('@/app/(app)/email/ui/Editor'), { ssr: false, loading: () => <div className="h-[120px]" /> });

/** One look per link per visit, however many messages carry it. */
const previews = new Map<string, Promise<LinkPreview | null>>();
function previewOf(url: string): Promise<LinkPreview | null> {
  let p = previews.get(url);
  if (!p) {
    p = linkPreviewAction({ url }).then((r) => (r.ok ? r.data : null));
    previews.set(url, p);
  }
  return p;
}

function LinkCard({ url }: { url: string }) {
  const [card, setCard] = useState<LinkPreview | null>(null);
  useEffect(() => {
    let live = true;
    void previewOf(url).then((c) => {
      if (live) setCard(c);
    });
    return () => {
      live = false;
    };
  }, [url]);
  if (!card) return null;
  return (
    <a href={card.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 block max-w-[440px] rounded-md border border-line border-l-[3px] border-l-brand-600 bg-white px-3 py-2 hover:bg-canvas">
      <span className="block text-[11px] font-medium text-ink-400">{card.site}</span>
      <span className="block text-[13px] font-semibold text-ink-900">{card.title}</span>
      {card.description ? <span className="mt-0.5 line-clamp-2 block text-[12px] text-ink-500">{card.description}</span> : null}
    </a>
  );
}

export function MessageRow({
  message: m,
  chatKey,
  isChannel,
  canWrite,
  sending,
  threadId,
  onRecord,
  onQuote,
  onThread,
  onChanged,
  onLocal,
}: {
  message: ChatMessage;
  chatKey: string;
  isChannel: boolean;
  canWrite: boolean;
  sending?: boolean;
  /** Set on a reply inside a channel thread. */
  threadId?: string;
  /**
   * Inside a merchant record, where "delete" is a reserved word (CLAUDE.md): that
   * screen offers no way to remove a message, and removing one is left to Chat.
   */
  onRecord?: boolean;
  onQuote: (m: ChatMessage) => void;
  onThread: (m: ChatMessage) => void;
  onChanged: () => void;
  onLocal: (m: ChatMessage) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (m.system) {
    return (
      <li className="text-center text-[11.5px] text-ink-400">
        <span dangerouslySetInnerHTML={{ __html: m.html }} />
      </li>
    );
  }

  const thumb = async () => {
    const on = !m.thumbedByMe;
    onLocal({ ...m, thumbedByMe: on, thumbs: Math.max(0, m.thumbs + (on ? 1 : -1)) });
    const r = await thumbAction({ key: chatKey, messageId: m.id, threadId: threadId ?? null, on });
    if (!r.ok) {
      setError(r.message);
      onLocal(m);
    }
  };

  const remove = async () => {
    setDeleting(false);
    const r = await deleteMessageAction({ key: chatKey, messageId: m.id, threadId: threadId ?? null });
    if (!r.ok) {
      setError(r.message);
      return;
    }
    onLocal({ ...m, deleted: true, html: '', text: '', files: [], quote: null, link: null });
    onChanged();
  };

  return (
    <li data-message={m.id} className={`group flex gap-2.5 ${m.mine ? 'flex-row-reverse' : ''}`}>
      {!m.mine ? (
        <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: colorFor(m.authorName || '?') }}>
          {initials(m.authorName)}
        </span>
      ) : null}
      <div className={`flex min-w-0 max-w-[78%] flex-col ${m.mine ? 'items-end' : 'items-start'}`}>
        <div className={`mb-0.5 flex items-center gap-2 text-[11.5px] text-ink-500 ${m.mine ? 'flex-row-reverse' : ''}`}>
          {!m.mine ? <span className="font-semibold text-ink-700">{m.authorName}</span> : null}
          <span>{sending ? 'Sending…' : messageTime(m.at)}</span>
          {m.edited ? <span className="italic">Edited</span> : null}
        </div>
        <div className={`relative rounded-lg px-3 py-2 text-[13px] leading-relaxed text-ink-800 ${m.deleted ? 'border border-dashed border-line bg-transparent' : m.mine ? 'bg-brand-100' : 'bg-white shadow-[0_1px_1px_rgba(14,28,52,.06)]'} ${sending ? 'opacity-60' : ''}`}>
          {m.deleted ? (
            <span className="italic text-ink-400">{onRecord ? 'Message removed' : 'Message deleted'}</span>
          ) : (
            <>
              {m.quote ? (
                <div className="mb-1.5 rounded border-l-[3px] border-ink-300 bg-black/[.04] px-2 py-1">
                  <p className="text-[11.5px] font-semibold text-ink-600">{m.quote.author}</p>
                  <p className="line-clamp-2 text-[12px] text-ink-500">{m.quote.preview}</p>
                </div>
              ) : null}
              {/* Sanitized on the server to a short allowlist: no styles, no scripts; pictures only from this server. */}
              <MessageBody html={m.html} />
              {m.files.length ? (
                <ul className="mt-1.5 space-y-1">
                  {m.files.map((f) => (
                    <li key={f.id}>
                      <a href={`/api/msteams/file?key=${encodeURIComponent(chatKey)}&url=${encodeURIComponent(f.url)}`} target="_blank" rel="noopener noreferrer" className="flex w-[260px] items-center gap-2.5 rounded-md border border-line bg-white px-2.5 py-2 hover:bg-canvas" title={`Download ${f.name}`}>
                        <span className="grid size-8 shrink-0 place-items-center rounded bg-canvas text-ink-500">
                          <Icon name="file-text" size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-semibold text-ink-800">{f.name}</span>
                          <span className="block text-[11px] text-ink-400">{fileSize(f.size) || 'File'}</span>
                        </span>
                        <Icon name="download" size={14} className="text-ink-400" />
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
              {m.link ? <LinkCard url={m.link} /> : null}
            </>
          )}
          {!m.deleted && !sending ? (
            <div className={`absolute -top-3.5 hidden items-center gap-0.5 rounded-md border border-line bg-white px-0.5 py-0.5 shadow-sm group-hover:flex ${m.mine ? 'left-1' : 'right-1'}`}>
              <ToolButton label={m.thumbedByMe ? 'Remove thumbs-up' : 'Thumbs-up'} disabled={!canWrite} onClick={() => void thumb()}>
                <span aria-hidden className="text-[13px]">👍</span>
              </ToolButton>
              {isChannel && !threadId ? (
                <ToolButton label="Reply in thread" disabled={!canWrite} onClick={() => onThread(m)}>
                  <Icon name="message-square" size={13} />
                </ToolButton>
              ) : !isChannel ? (
                <ToolButton label="Reply with quote" disabled={!canWrite} onClick={() => onQuote(m)}>
                  <Icon name="reply" size={13} />
                </ToolButton>
              ) : null}
              {m.mine ? (
                <>
                  <ToolButton label="Edit" disabled={!canWrite} onClick={() => setEditing(true)}>
                    <Icon name="pencil" size={13} />
                  </ToolButton>
                  {onRecord ? null : (
                    <ToolButton label="Delete" disabled={!canWrite} onClick={() => setDeleting(true)}>
                      <Icon name="trash" size={13} />
                    </ToolButton>
                  )}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        {m.thumbs > 0 && !m.deleted ? (
          <button type="button" onClick={() => void thumb()} disabled={!canWrite} aria-label={`${m.thumbs} thumbs-up`} className={`mt-1 inline-flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-px text-[11.5px] ${m.thumbedByMe ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-line bg-white text-ink-600'}`}>
            <span aria-hidden>👍</span> {m.thumbs}
          </button>
        ) : null}
        {m.mine && !sending && !m.deleted && !isChannel ? <span className="mt-0.5 text-[10.5px] text-ink-400">Sent</span> : null}
        {error ? <p className="mt-1 text-[11.5px] font-medium text-[#b02a30]">{error}</p> : null}
        {isChannel && !threadId && m.replies.length ? (
          <ol className="mt-2 w-full space-y-2 border-l-2 border-line pl-3">
            {m.replies.map((r) => (
              <MessageRow key={r.id} message={r} chatKey={chatKey} onRecord={onRecord} isChannel threadId={m.id} canWrite={canWrite} onQuote={onQuote} onThread={onThread} onChanged={onChanged} onLocal={onLocal} />
            ))}
          </ol>
        ) : null}
        {isChannel && !threadId && canWrite ? (
          <button type="button" onClick={() => onThread(m)} className="mt-1 cursor-pointer text-[11.5px] font-semibold text-brand-700 hover:underline">
            Reply
          </button>
        ) : null}
      </div>
      {editing ? <EditDialog m={m} chatKey={chatKey} threadId={threadId} onRecord={onRecord} onClose={() => setEditing(false)} onSaved={(html) => {
        setEditing(false);
        onLocal({ ...m, html, edited: true });
        onChanged();
      }} /> : null}
      {deleting ? (
        <Dialog title="Delete message" tone="danger" confirmLabel="Delete" onConfirm={() => void remove()} onClose={() => setDeleting(false)}>
          <p className="text-[13px] text-ink-600">The message is deleted in Teams too, and leaves a “Message deleted” note.</p>
        </Dialog>
      ) : null}
    </li>
  );
}

/**
 * The words and pictures of a message. A picture opens larger on a click; one that
 * cannot be loaded (removed in Teams, or the account needs reconnecting) says so
 * instead of showing a broken image.
 */
function MessageBody({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // A picture's load error does not bubble, so it is caught on the way down.
    const failed = (e: Event) => {
      const img = e.target as HTMLElement;
      if (img.tagName !== 'IMG' || !img.classList.contains('chat-img')) return;
      const note = document.createElement('span');
      note.className = 'chat-img-missing';
      note.textContent = 'This picture could not be loaded. Open it in Teams.';
      img.replaceWith(note);
    };
    el.addEventListener('error', failed, true);
    return () => el.removeEventListener('error', failed, true);
  }, [html]);

  return (
    <>
      <div
        ref={box}
        onClick={(e) => {
          const img = e.target as HTMLImageElement;
          if (img.tagName === 'IMG' && img.classList.contains('chat-img')) setViewing({ src: img.currentSrc || img.src, alt: img.alt });
        }}
        className="chat-body break-words [&_a]:text-brand-700 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-0 [&_ul]:list-disc [&_ul]:pl-5"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {viewing ? <PictureViewer src={viewing.src} alt={viewing.alt} onClose={() => setViewing(null)} /> : null}
    </>
  );
}

function PictureViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label="Picture" onClick={onClose} className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 bg-[rgba(8,14,28,.82)] p-4">
      <div className="flex w-full max-w-[92vw] justify-end gap-2" onClick={(e) => e.stopPropagation()}>
        <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-white/20">
          <Icon name="external-link" size={13} /> Open full size
        </a>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-8 cursor-pointer place-items-center rounded-md bg-white/10 text-white hover:bg-white/20">
          <Icon name="x" size={15} />
        </button>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- a picture from the message, already loaded */}
      <img src={src} alt={alt || 'Picture'} onClick={(e) => e.stopPropagation()} className="max-h-[84vh] max-w-[92vw] rounded-md bg-white object-contain shadow-2xl" />
    </div>
  );
}

/** The pictures a shown message carries, to keep beside edited words. */
const picturesIn = (html: string): string => {
  const tags = html.match(/<img class="chat-img"[^>]*>/g) ?? [];
  return tags.length ? `<p>${tags.join(' ')}</p>` : '';
};
const withoutPictures = (html: string): string => html.replace(/<img class="chat-img"[^>]*>/g, '');

function ToolButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick} className="grid size-6 cursor-pointer place-items-center rounded text-ink-500 hover:bg-canvas disabled:cursor-default disabled:opacity-40">
      {children}
    </button>
  );
}

function EditDialog({ m, chatKey, threadId, onRecord, onClose, onSaved }: { m: ChatMessage; chatKey: string; threadId?: string; onRecord?: boolean; onClose: () => void; onSaved: (html: string) => void }) {
  const editor = useRef<EditorHandle>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const empty = editor.current?.isEmpty() ?? true;
    const html = empty ? '' : (editor.current?.getHTML() ?? '');
    if (empty && m.images === 0) {
      setError(onRecord ? 'A message cannot be empty.' : 'A message cannot be empty. Delete it instead.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await editMessageAction({ key: chatKey, messageId: m.id, threadId: threadId ?? null, html });
    setBusy(false);
    // The pictures stay: the server keeps them, and so does the message on screen.
    if (r.ok) onSaved(`${html}${picturesIn(m.html)}`);
    else setError(r.message);
  };
  return (
    <Dialog title="Edit message" onClose={onClose} width={560}>
      <div className="overflow-hidden rounded-md border border-line">
        <Editor initialHTML={withoutPictures(m.html)} placeholder={m.images ? 'Words to go with the pictures' : 'Message'} minHeight={90} handleRef={editor} onChange={() => undefined} />
      </div>
      {m.images ? (
        <p className="mt-2 text-[12px] text-ink-500">
          {m.images === 1 ? 'The picture in this message stays as it is.' : `The ${m.images} pictures in this message stay as they are.`} Only the words change.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}
      <div className="mt-3 flex justify-end">
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}
