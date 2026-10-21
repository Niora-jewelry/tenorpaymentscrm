'use client';

/**
 * Writing a message: new mail, reply, reply all, forward, or a draft picked
 * up again. Takes the reading pane's place.
 *
 *   * Autosaves to Outlook's Drafts two seconds after you stop typing (and
 *     when you close it), so nothing is lost and Outlook sees the draft too.
 *   * Attachments upload straight to private storage as soon as they are
 *     added, with progress; Send waits for them.
 *   * Send checks recipients (an invalid address blocks it), asks about an
 *     empty subject, and hands over to the undo window. "Schedule send…"
 *     picks a time instead.
 *   * Ctrl+Enter sends. Esc never discards.
 */
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Dialog, Popover, Spinner } from '@/proto/ui/kit';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { fileSize, fullStamp } from '@/lib/mail/dates';
import type { ComposeInit, OutgoingAttachment } from '@/lib/mail/viewTypes';
import {
  discardDraftAction,
  removeUploadAction,
  saveDraftAction,
  sendMailAction,
  sourcePreviewAction,
  templatesAction,
  uploadUrlAction,
  type TemplateView,
} from '../composeActions';
import type { EditorHandle } from './Editor';
import { RecipientField, type Chip } from './RecipientField';
import { BodyFrame } from './ReadingPane';

const Editor = dynamic(() => import('./Editor'), {
  ssr: false,
  loading: () => <div className="skeleton mx-5 my-4 h-[220px] rounded-lg" />,
});

const MAX_TOTAL = 35 * 1024 * 1024;
const AUTOSAVE_MS = 2_000;

type Upload = { key: string; name: string; size: number; contentType: string; path: string | null; progress: number; error: string | null };
type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: string } | { kind: 'error'; message: string };

export type SentResult = { outboxId: string; releaseAt: string; status: 'held' | 'scheduled'; subject: string };

const TITLE: Record<ComposeInit['kind'], string> = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' };

export function Composer({
  init,
  onClose,
  onSent,
  onDiscarded,
}: {
  init: ComposeInit;
  onClose: (draftSaved: boolean) => void;
  onSent: (r: SentResult) => void;
  onDiscarded: () => void;
}) {
  const [mailboxId, setMailboxId] = useState(init.mailboxId);
  const [to, setTo] = useState<Chip[]>(init.to);
  const [cc, setCc] = useState<Chip[]>(init.cc);
  const [bcc, setBcc] = useState<Chip[]>(init.bcc);
  const [showCc, setShowCc] = useState(init.cc.length > 0);
  const [showBcc, setShowBcc] = useState(init.bcc.length > 0);
  const [subject, setSubject] = useState(init.subject);
  const [includeSignature, setIncludeSignature] = useState(init.includeSignature ?? true);
  const [uploads, setUploads] = useState<Upload[]>(() =>
    (init.attachments ?? []).map((a) => ({ key: a.path, name: a.name, size: a.size, contentType: a.contentType, path: a.path, progress: 1, error: null })),
  );
  const [draftId, setDraftId] = useState<string | null>(init.draftId);
  const [save, setSave] = useState<SaveState>(init.draftId ? { kind: 'saved', at: '' } : { kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [askSubject, setAskSubject] = useState<null | { sendAt: string | null }>(null);
  const [scheduling, setScheduling] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [original, setOriginal] = useState<string | null>(null);
  const [edits, setEdits] = useState(0);

  const editor = useRef<EditorHandle>(null);
  const draftRef = useRef<string | null>(init.draftId);
  const saving = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const from = init.fromOptions.find((o) => o.mailboxId === mailboxId) ?? init.fromOptions[0];
  const changed = () => {
    dirty.current = true;
    setEdits((n) => n + 1);
    // Whatever Send complained about, the person is acting on it now.
    setError(null);
  };

  // ── autosave ────────────────────────────────────────────────────────────
  const valid = (list: Chip[]) => list.filter((c) => !c.invalid).map(({ name, address }) => ({ name, address }));
  const snapshot = useCallback(
    () => ({
      draftId: draftRef.current,
      mailboxId,
      kind: init.kind,
      sourceMessageId: init.sourceMessageId,
      subject,
      html: editor.current?.getHTML() ?? init.html,
      includeSignature,
      to: valid(to),
      cc: valid(cc),
      bcc: valid(bcc),
    }),
    [mailboxId, init.kind, init.sourceMessageId, init.html, subject, includeSignature, to, cc, bcc],
  );

  // Saves run strictly one after another (chained), so two can never both
  // create an Outlook draft; each checks for changes when its turn comes.
  const saveNow = useCallback((): Promise<void> => {
    const run = async () => {
      if (!dirty.current) return;
      dirty.current = false;
      setSave({ kind: 'saving' });
      const res = await saveDraftAction({ ...snapshot(), draftId: draftRef.current });
      if (res.ok) {
        draftRef.current = res.data.draftId;
        setDraftId(res.data.draftId);
        setSave({ kind: 'saved', at: res.data.savedAt });
      } else {
        dirty.current = true;
        setSave({ kind: 'error', message: res.message });
      }
    };
    const p = (saving.current ?? Promise.resolve()).then(run, run);
    saving.current = p;
    void p.finally(() => {
      if (saving.current === p) saving.current = null;
    });
    return p;
  }, [snapshot]);

  useEffect(() => {
    if (edits === 0) return;
    const t = setTimeout(() => void saveNow(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [edits, saveNow]);

  // ── attachments ─────────────────────────────────────────────────────────
  const addFiles = useCallback(
    (files: File[]) => {
      const total = uploads.reduce((n, u) => n + u.size, 0);
      let room = MAX_TOTAL - total;
      for (const file of files) {
        if (file.size > room) {
          setError(`“${file.name}” would push this message over Outlook’s 35 MB limit.`);
          continue;
        }
        room -= file.size;
        const key = crypto.randomUUID();
        const up: Upload = { key, name: file.name, size: file.size, contentType: file.type || 'application/octet-stream', path: null, progress: 0, error: null };
        setUploads((u) => [...u, up]);
        void (async () => {
          const url = await uploadUrlAction({ name: file.name, size: file.size, contentType: up.contentType });
          if (!url.ok) {
            setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: url.message } : x)));
            return;
          }
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: 0.15 } : x)));
          const { error: upErr } = await supabase.storage.from('mail-outbox').uploadToSignedUrl(url.data.path, url.data.token, file, { contentType: up.contentType });
          setUploads((u) =>
            u.map((x) => (x.key === key ? (upErr ? { ...x, error: 'Upload failed. Remove it and try again.' } : { ...x, path: url.data.path, progress: 1 }) : x)),
          );
        })();
      }
    },
    [uploads, supabase],
  );

  const removeUpload = (u: Upload) => {
    setUploads((list) => list.filter((x) => x.key !== u.key));
    if (u.path) void removeUploadAction({ path: u.path });
  };

  // ── sending ─────────────────────────────────────────────────────────────
  const uploading = uploads.some((u) => !u.path && !u.error);
  const invalid = [...to, ...cc, ...bcc].some((c) => c.invalid);

  const send = async (sendAt: string | null, skipSubjectCheck = false) => {
    setError(null);
    if (invalid) return setError('One of the addresses isn’t valid. Fix it or remove it, then send.');
    if (valid(to).length + valid(cc).length + valid(bcc).length === 0) return setError('Add at least one recipient.');
    if (uploads.some((u) => u.error)) return setError('Remove the attachment that failed to upload, then send.');
    if (uploading) return setError('Wait for the attachments to finish uploading.');
    if (!subject.trim() && !skipSubjectCheck) return setAskSubject({ sendAt });
    setSending(true);
    // An autosave in flight decides which Outlook draft gets sent: wait for it.
    if (saving.current) await saving.current;
    // …and no autosave may start while the send is on its way.
    const wasDirty = dirty.current;
    dirty.current = false;
    const att: OutgoingAttachment[] = uploads.map((u) => ({ path: u.path!, name: u.name, size: u.size, contentType: u.contentType }));
    const res = await sendMailAction({ ...snapshot(), requestId: crypto.randomUUID(), attachments: att, sendAt });
    setSending(false);
    if (!res.ok) {
      dirty.current = wasDirty;
      return setError(res.message);
    }
    onSent({ ...res.data, subject: subject.trim() || '(no subject)' });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void send(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const close = async () => {
    await saveNow();
    onClose(Boolean(draftRef.current));
  };

  const discard = async () => {
    for (const u of uploads) if (u.path) void removeUploadAction({ path: u.path });
    if (draftRef.current) await discardDraftAction({ draftId: draftRef.current });
    onDiscarded();
  };

  const loadOriginal = async () => {
    setShowOriginal((s) => !s);
    if (original === null && init.sourceMessageId) setOriginal(await sourcePreviewAction({ messageId: init.sourceMessageId }));
  };

  const saveLabel =
    save.kind === 'saving' ? 'Saving…' : save.kind === 'saved' ? (save.at ? `Draft saved ${new Date(save.at).toTimeString().slice(0, 5)}` : 'Draft') : save.kind === 'error' ? 'Not saved' : '';

  return (
    <section aria-label={TITLE[init.kind]} className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex items-center gap-3 border-b border-line bg-canvas px-6 py-3">
        <h2 className="text-[15px] font-semibold text-ink-900">{TITLE[init.kind]}</h2>
        {init.source ? (
          <span className="truncate text-[12px] text-ink-400">
            to {init.source.fromName || init.source.fromAddress} · {init.source.subject || '(no subject)'}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ink-400" aria-live="polite">
          {save.kind === 'saving' ? <Spinner /> : null}
          {saveLabel}
          {save.kind === 'error' ? (
            <button type="button" onClick={() => void saveNow()} className="font-semibold text-brand-700 hover:text-brand-900" title={save.message}>
              Retry
            </button>
          ) : null}
        </span>
        <button type="button" onClick={() => void close()} title="Close (keeps the draft)" aria-label="Close" className="grid size-7 place-items-center rounded-lg text-ink-400 hover:bg-white hover:text-ink-900">
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div
          // No overflow-hidden: it would clip the editor's menus (templates, colour, link, emoji).
          className="rounded-xl border border-line bg-white shadow-[0_1px_3px_rgba(8,32,47,.05)]"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {init.fromOptions.length > 1 ? (
            <div className="flex items-center gap-2 border-b border-line-faint px-5 py-2">
              <label htmlFor="compose-from" className="w-9 shrink-0 text-[12.5px] font-medium text-ink-400">
                From
              </label>
              <select
                id="compose-from"
                value={mailboxId}
                onChange={(e) => {
                  setMailboxId(e.target.value);
                  changed();
                }}
                disabled={Boolean(draftId)}
                title={draftId ? 'A saved draft stays in the mailbox it was started in.' : undefined}
                className="min-w-0 flex-1 rounded-md bg-transparent py-1 text-[13px] text-ink-900 outline-none disabled:opacity-70"
              >
                {init.fromOptions.map((o) => (
                  <option key={o.mailboxId} value={o.mailboxId}>
                    {o.displayName ? `${o.displayName} <${o.address}>` : o.address}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p className="border-b border-line-faint px-5 py-2 text-[12.5px] text-ink-400">
              From <span className="text-ink-700">{from?.address}</span>
            </p>
          )}

          <RecipientField
            label="To"
            value={to}
            onChange={(v) => {
              setTo(v);
              changed();
            }}
            autoFocus={init.kind === 'new' || init.kind === 'forward'}
            trailing={
              <span className="flex gap-1 text-[12px] font-semibold text-ink-400">
                {!showCc ? (
                  <button type="button" onClick={() => setShowCc(true)} className="rounded px-1 hover:bg-canvas hover:text-ink-700">
                    Cc
                  </button>
                ) : null}
                {!showBcc ? (
                  <button type="button" onClick={() => setShowBcc(true)} className="rounded px-1 hover:bg-canvas hover:text-ink-700">
                    Bcc
                  </button>
                ) : null}
              </span>
            }
          />
          {showCc ? (
            <RecipientField
              label="Cc"
              value={cc}
              onChange={(v) => {
                setCc(v);
                changed();
              }}
            />
          ) : null}
          {showBcc ? (
            <RecipientField
              label="Bcc"
              value={bcc}
              onChange={(v) => {
                setBcc(v);
                changed();
              }}
            />
          ) : null}
          <div className="flex items-center gap-2 border-b border-line-faint px-5 py-1.5">
            <label htmlFor="compose-subject" className="sr-only">
              Subject
            </label>
            <input
              id="compose-subject"
              value={subject}
              maxLength={255}
              onChange={(e) => {
                setSubject(e.target.value);
                changed();
              }}
              placeholder="Subject"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] font-semibold text-ink-900 outline-none placeholder:font-normal placeholder:text-ink-300"
            />
          </div>

          <Editor
            handleRef={editor}
            initialHTML={init.html}
            placeholder={init.kind === 'new' ? 'Write your message…' : 'Write your reply…'}
            onChange={changed}
            onFiles={addFiles}
            toolbarExtra={
              <>
                <TemplatesMenu
                  onPick={(t) => {
                    editor.current?.insertHTML(t.html);
                    if (!subject.trim() && t.subject) setSubject(t.subject);
                    changed();
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  title="Attach files"
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-semibold text-ink-500 hover:bg-canvas hover:text-ink-900"
                >
                  <Icon name="paperclip" size={14} /> Attach
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []));
                    e.target.value = '';
                  }}
                />
              </>
            }
          />

          {from?.signatureHtml && includeSignature ? (
            <div className="group/sig mx-5 mb-4 rounded-lg border border-dashed border-line px-3 pb-2 pt-1.5">
              <div className="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[.08em] text-ink-300">
                Signature
                <button
                  type="button"
                  onClick={() => {
                    setIncludeSignature(false);
                    changed();
                  }}
                  className="normal-case tracking-normal text-ink-400 opacity-0 transition-opacity hover:text-ink-900 group-hover/sig:opacity-100 focus:opacity-100"
                >
                  Leave out
                </button>
              </div>
              <BodyFrame html={from.signatureHtml} messageId="00000000-0000-4000-8000-000000000000" loadImages={false} title="Signature" />
            </div>
          ) : from?.signatureHtml ? (
            <button
              type="button"
              onClick={() => {
                setIncludeSignature(true);
                changed();
              }}
              className="mx-5 mb-4 text-[12px] font-semibold text-ink-400 hover:text-ink-900"
            >
              + Add signature
            </button>
          ) : null}

          {uploads.length ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 border-t border-line-faint px-5 py-3">
              {uploads.map((u) => (
                <li key={u.key} className={`relative overflow-hidden rounded-lg border px-2.5 py-2 ${u.error ? 'border-[#f7cfd1] bg-[#fce9ea]' : 'border-line bg-white'}`}>
                  <div className="flex items-center gap-2">
                    <Icon name="paperclip" size={13} className="shrink-0 text-ink-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-ink-800">{u.name}</span>
                      <span className={`block text-[11px] ${u.error ? 'text-[#b02a30]' : 'text-ink-400'}`}>
                        {u.error ?? (u.path ? fileSize(u.size) : `Uploading… ${fileSize(u.size)}`)}
                      </span>
                    </span>
                    <button type="button" onClick={() => removeUpload(u)} aria-label={`Remove ${u.name}`} className="grid size-6 place-items-center rounded-md text-ink-400 hover:bg-canvas hover:text-ink-900">
                      <Icon name="x" size={12} />
                    </button>
                  </div>
                  {!u.path && !u.error ? (
                    <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-line-soft">
                      <span className="block h-full bg-brand-600 transition-[width] duration-300" style={{ width: `${Math.max(8, u.progress * 100)}%` }} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p role="alert" className="flex items-start gap-2 border-t border-[#f7cfd1] bg-[#fce9ea] px-5 py-2.5 text-[12.5px] text-[#b02a30]">
              <Icon name="alert-triangle" size={13} className="mt-px shrink-0" />
              {error}
            </p>
          ) : null}

          <footer className="flex items-center gap-2 border-t border-line-faint px-5 py-3">
            <div className="inline-flex rounded-lg shadow-[0_1px_2px_rgba(8,32,47,.08)]">
              <button
                type="button"
                onClick={() => void send(null)}
                disabled={sending}
                className="inline-flex h-9 items-center gap-1.5 rounded-l-lg bg-accent px-4 text-[13.5px] font-semibold text-accent-ink transition-colors hover:bg-accent-dim disabled:opacity-60"
              >
                {sending ? <Spinner /> : <Icon name="send" size={14} />}
                {sending ? 'Sending…' : 'Send'}
              </button>
              <Popover
                width={200}
                side="right"
                trigger={() => (
                  <span title="More send options" className="grid h-9 place-items-center rounded-r-lg border-l border-accent-ink/15 bg-accent px-2 text-accent-ink hover:bg-accent-dim">
                    <Icon name="chevron-down" size={13} />
                    <span className="sr-only">More send options</span>
                  </span>
                )}
              >
                {(closeMenu) => (
                  <button
                    type="button"
                    onClick={() => {
                      closeMenu();
                      setScheduling(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-700 hover:bg-canvas"
                  >
                    <Icon name="clock" size={14} className="text-ink-400" /> Schedule send…
                  </button>
                )}
              </Popover>
            </div>
            <span className="text-[11.5px] text-ink-300">Ctrl+Enter</span>
            <button
              type="button"
              onClick={() => (dirty.current || draftRef.current || uploads.length || init.html || init.subject ? setConfirmDiscard(true) : onDiscarded())}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-400 hover:bg-[#fce9ea] hover:text-[#b02a30]"
            >
              <Icon name="trash" size={13} /> Discard
            </button>
          </footer>
        </div>

        {init.sourceMessageId ? (
          <div className="mt-3">
            <button type="button" onClick={() => void loadOriginal()} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-400 hover:text-ink-900">
              <Icon name="chevron-right" size={12} className={`transition-transform ${showOriginal ? 'rotate-90' : ''}`} />
              {init.kind === 'forward' ? 'Forwarded message' : 'Original message'}
              {init.source ? ` · ${init.source.fromName || init.source.fromAddress}${init.source.at ? `, ${fullStamp(init.source.at)}` : ''}` : ''}
            </button>
            {showOriginal ? (
              <div className="mt-2 rounded-xl border border-line bg-white px-5 py-4">
                {original === null ? <div className="skeleton h-16 w-full" /> : <BodyFrame html={original} messageId={init.sourceMessageId} loadImages={false} title="Original message" />}
                <p className="mt-2 text-[11.5px] text-ink-400">Outlook adds this below your {init.kind === 'forward' ? 'message, with its attachments' : 'reply'} when it sends.</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {askSubject ? (
        <Dialog title="Send without a subject?" confirmLabel="Send anyway" onConfirm={() => void send(askSubject.sendAt, true)} onClose={() => setAskSubject(null)}>
          <p>Mail without a subject is easy to miss and often lands in spam filters.</p>
        </Dialog>
      ) : null}
      {confirmDiscard ? (
        <Dialog title="Discard this message?" tone="danger" confirmLabel="Discard" onConfirm={() => void discard()} onClose={() => setConfirmDiscard(false)}>
          <p>{draftId ? 'The draft is deleted from Outlook’s Drafts as well.' : 'What you wrote is not kept.'}</p>
        </Dialog>
      ) : null}
      {scheduling ? <ScheduleDialog onClose={() => setScheduling(false)} onPick={(iso) => void send(iso)} /> : null}
    </section>
  );
}

function TemplatesMenu({ onPick }: { onPick: (t: TemplateView) => void }) {
  return (
    <Popover
      width={260}
      align="right"
      trigger={() => (
        <span className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-semibold text-ink-500 hover:bg-canvas hover:text-ink-900">
          <Icon name="file-text" size={14} /> Templates
        </span>
      )}
    >
      {(close) => (
        <TemplateList
          onPick={(t) => {
            close();
            onPick(t);
          }}
        />
      )}
    </Popover>
  );
}

/** Fetched each time the menu opens, however it was opened, so a template made a minute ago is there. */
function TemplateList({ onPick }: { onPick: (t: TemplateView) => void }) {
  const [list, setList] = useState<TemplateView[] | null>(null);
  useEffect(() => {
    let live = true;
    void templatesAction().then((r) => {
      if (live) setList(r.ok ? r.data : []);
    });
    return () => {
      live = false;
    };
  }, []);
  if (list === null) return <p className="px-2 py-3 text-[12.5px] text-ink-400">Loading…</p>;
  if (list.length === 0) return <p className="px-2 py-3 text-[12.5px] leading-relaxed text-ink-400">No templates yet. Create them in Email settings.</p>;
  return (
    <div>
      {(['Personal', 'Shared'] as const).map((group) => {
        const items = list.filter((t) => (group === 'Shared' ? t.shared : !t.shared));
        return items.length ? (
          <div key={group} className="mb-1">
            <p className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[.1em] text-ink-400">{group}</p>
            {items.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t)}
                className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-700 hover:bg-canvas"
              >
                {t.name}
              </button>
            ))}
          </div>
        ) : null;
      })}
    </div>
  );
}

/** Presets people actually use, plus an exact time. Local time throughout. */
function ScheduleDialog({ onClose, onPick }: { onClose: () => void; onPick: (iso: string) => void }) {
  const presets = useMemo(() => {
    const at = (d: Date, h: number) => {
      const x = new Date(d);
      x.setHours(h, 0, 0, 0);
      return x;
    };
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const monday = new Date(now);
    monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
    const list = [
      { label: 'Later today', when: at(now, Math.min(now.getHours() + 3, 23)) },
      { label: 'Tomorrow morning', when: at(tomorrow, 8) },
      { label: 'Tomorrow afternoon', when: at(tomorrow, 13) },
      { label: 'Monday morning', when: at(monday, 8) },
    ];
    return list.filter((p) => p.when.getTime() > now.getTime() + 5 * 60_000);
  }, []);
  const [custom, setCustom] = useState('');
  const [pick, setPick] = useState<Date | null>(presets[1]?.when ?? null);
  // The dialog's notion of "now", fixed when it opens.
  const [openedAt] = useState(() => Date.now());
  const minLocal = useMemo(() => new Date(openedAt + 2 * 60_000 - new Date(openedAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16), [openedAt]);
  const chosen = custom ? new Date(custom) : pick;
  const ok = chosen && !Number.isNaN(chosen.getTime()) && chosen.getTime() > openedAt + 60_000;
  return (
    <Dialog title="Schedule send" confirmLabel={ok ? `Send ${fullStamp(chosen!.toISOString())}` : 'Choose a time'} onConfirm={() => ok && onPick(chosen!.toISOString())} onClose={onClose}>
      <div className="space-y-1.5">
        {presets.map((p) => (
          <label key={p.label} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-canvas">
            <input type="radio" name="when" checked={!custom && pick === p.when} onChange={() => { setPick(p.when); setCustom(''); }} className="accent-brand-600" />
            <span className="flex-1 text-[13px] text-ink-800">{p.label}</span>
            <span className="text-[12px] tabular text-ink-400">{fullStamp(p.when.toISOString())}</span>
          </label>
        ))}
        <label className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <span className="text-[13px] text-ink-800">Pick a time</span>
          <input
            type="datetime-local"
            value={custom}
            min={minLocal}
            onChange={(e) => setCustom(e.target.value)}
            className="ml-auto rounded-md border border-line px-2 py-1 text-[12.5px] text-ink-900 outline-none focus:border-brand-600"
          />
        </label>
      </div>
    </Dialog>
  );
}
