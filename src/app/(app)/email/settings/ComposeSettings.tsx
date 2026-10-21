'use client';

/**
 * Writing preferences: how long "Undo" stays available after Send, a
 * signature per mailbox (Microsoft gives no way to read Outlook's own, so it
 * is kept here and added to every message you write from that mailbox), and
 * templates — personal for everyone, shared ones managed by admins.
 */
import dynamic from 'next/dynamic';
import { useRef, useState, useTransition } from 'react';
import { Button, Dialog } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { EditorHandle } from '../ui/Editor';
import { deleteTemplateAction, saveTemplateAction, setHideFromAdminsAction, setSignatureAction, setUndoSecondsAction, type TemplateView } from '../composeActions';

const Editor = dynamic(() => import('../ui/Editor'), { ssr: false, loading: () => <div className="skeleton h-32 w-full rounded-lg" /> });

export type SignatureBox = { mailboxId: string; address: string; html: string };

export function ComposeSettings({
  undoSeconds,
  signatures,
  templates: initialTemplates,
  isAdmin,
  hideFromAdmins,
}: {
  undoSeconds: number;
  signatures: SignatureBox[];
  templates: TemplateView[];
  isAdmin: boolean;
  hideFromAdmins: boolean;
}) {
  const [undo, setUndo] = useState(undoSeconds);
  const [hidden, setHidden] = useState(hideFromAdmins);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [templates, setTemplates] = useState(initialTemplates);
  const [editing, setEditing] = useState<TemplateView | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TemplateView | null>(null);

  const say = (ok: boolean, text: string) => setNote({ tone: ok ? 'ok' : 'error', text });

  return (
    <div className="space-y-10">
      {note ? (
        <p
          role={note.tone === 'error' ? 'alert' : 'status'}
          className={`rounded-lg border px-3.5 py-2.5 text-[13px] font-medium ${note.tone === 'error' ? 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]' : 'border-[#c5ecd0] bg-[#e3f6e8] text-[#1a7a3c]'}`}
        >
          {note.text}
        </p>
      ) : null}

      <section id="sending" className="scroll-mt-6 space-y-3">
        <SectionHead title="Sending" />
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white p-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-ink-900">Undo send</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">After you press Send, you have this long to take it back. Nothing reaches Outlook until it passes.</p>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-ink-700">
            <select
              value={undo}
              disabled={pending}
              onChange={(e) => {
                const v = Number(e.target.value);
                setUndo(v);
                start(async () => {
                  const r = await setUndoSecondsAction({ seconds: v });
                  say(r.ok, r.ok ? `Undo send is now ${v} second${v === 1 ? '' : 's'}.` : r.message);
                });
              }}
              className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-600"
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} second{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>


      <section id="signatures" className="scroll-mt-6 space-y-3">
        <SectionHead title="Signatures" />
        <p className="text-[12.5px] leading-relaxed text-ink-500">
          Outlook keeps signatures on each computer, where Microsoft lets no app read them — so set yours here once, per mailbox. It is added
          below everything you write from that mailbox in TapDash.
        </p>
        {signatures.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line bg-white px-4 py-6 text-center text-[13px] text-ink-400">Connect a mailbox first.</p>
        ) : (
          signatures.map((s) => <SignatureEditor key={s.mailboxId} box={s} onSaved={(ok, text) => say(ok, text)} />)
        )}
      </section>

      <section id="templates" className="scroll-mt-6 space-y-3">
        <div className="flex items-center justify-between">
          <SectionHead title="Templates" />
          <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
            New template
          </Button>
        </div>
        {templates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line bg-white px-4 py-6 text-center text-[13px] text-ink-400">
            No templates yet. Save replies you write often, and insert them from the composer.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
            {templates.map((t) => {
              const canEdit = t.mine || (t.shared && isAdmin);
              return (
                <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Icon name="file-text" size={15} className="shrink-0 text-ink-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold text-ink-900">{t.name}</p>
                    {t.subject ? <p className="truncate text-[12px] text-ink-400">{t.subject}</p> : null}
                  </div>
                  {t.shared ? <span className="rounded-md border border-line px-1.5 py-px text-[10px] font-semibold uppercase tracking-[.06em] text-ink-500">Shared</span> : null}
                  {canEdit ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(t)}>
                        Delete
                      </Button>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {isAdmin ? (
        <section id="privacy" className="scroll-mt-6 space-y-3">
          <SectionHead title="Privacy" />
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-white p-4">
            <input
              type="checkbox"
              checked={hidden}
              disabled={pending}
              onChange={(e) => {
                const v = e.target.checked;
                setHidden(v);
                start(async () => {
                  const r = await setHideFromAdminsAction({ hide: v });
                  if (!r.ok) setHidden(!v);
                  say(r.ok, r.ok ? (v ? 'Your mailboxes are now hidden from other admins.' : 'Other admins can see your mailboxes again.') : r.message);
                });
              }}
              className="mt-0.5 accent-brand-600"
            />
            <span>
              <span className="block text-[13.5px] font-semibold text-ink-900">Hide my mailboxes from other admins</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-500">
                Admins can see members’ personal mailboxes. Turn this on and your own personal mailboxes stay visible only to you.
                Shared mailboxes are only ever visible to the people connected to them.
              </span>
            </span>
          </label>
        </section>
      ) : null}

      {editing ? (
        <TemplateDialog
          template={editing === 'new' ? null : editing}
          isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setTemplates((list) => [...list.filter((x) => x.id !== t.id), t].sort((a, b) => a.name.localeCompare(b.name)));
            say(true, `Saved “${t.name}”.`);
          }}
          onError={(m) => say(false, m)}
        />
      ) : null}
      {deleting ? (
        <Dialog
          title={`Delete “${deleting.name}”?`}
          tone="danger"
          confirmLabel="Delete template"
          onConfirm={() =>
            start(async () => {
              const r = await deleteTemplateAction({ id: deleting.id });
              if (r.ok) setTemplates((list) => list.filter((x) => x.id !== deleting.id));
              say(r.ok, r.ok ? 'Template deleted.' : r.message);
            })
          }
          onClose={() => setDeleting(null)}
        >
          <p>{deleting.shared ? 'It disappears for everyone.' : 'Messages already sent with it are not affected.'}</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function SignatureEditor({ box, onSaved }: { box: SignatureBox; onSaved: (ok: boolean, text: string) => void }) {
  const editor = useRef<EditorHandle>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div className="rounded-xl border border-line bg-white">
      <div className="flex items-center justify-between border-b border-line-faint px-4 py-2.5">
        <p className="text-[13px] font-semibold text-ink-900">{box.address}</p>
        <Button
          size="sm"
          variant={dirty ? 'primary' : 'secondary'}
          disabled={!dirty}
          loading={pending}
          loadingLabel="Saving…"
          onClick={() =>
            start(async () => {
              const html = editor.current?.isEmpty() ? '' : (editor.current?.getHTML() ?? '');
              const r = await setSignatureAction({ mailboxId: box.mailboxId, html });
              if (r.ok) setDirty(false);
              onSaved(r.ok, r.ok ? (html ? `Signature saved for ${box.address}.` : `Signature removed for ${box.address}.`) : r.message);
            })
          }
        >
          Save signature
        </Button>
      </div>
      <Editor handleRef={editor} initialHTML={box.html} placeholder="Your name, title, phone…" onChange={() => setDirty(true)} minHeight={110} />
    </div>
  );
}

function TemplateDialog({
  template,
  isAdmin,
  onClose,
  onSaved,
  onError,
}: {
  template: TemplateView | null;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (t: TemplateView) => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [shared, setShared] = useState(template?.shared ?? false);
  const editor = useRef<EditorHandle>(null);
  return (
    <Dialog
      title={template ? `Edit “${template.name}”` : 'New template'}
      confirmLabel="Save template"
      width={640}
      onClose={onClose}
      onConfirm={async () => {
        const html = editor.current?.getHTML() ?? '';
        const r = await saveTemplateAction({ id: template?.id ?? null, name, subject, html, shared });
        if (!r.ok) return onError(r.message);
        onSaved({ id: r.data.id, name: name.trim(), subject, html, shared, mine: !shared });
      }}
    >
      <div className="space-y-2.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="Template name (only you see this)"
          aria-label="Template name"
          className="w-full rounded-lg border border-line px-3 py-2 text-[13.5px] text-ink-900 outline-none focus:border-brand-600"
        />
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={255}
          placeholder="Subject (optional — used when the message has none)"
          aria-label="Template subject"
          className="w-full rounded-lg border border-line px-3 py-2 text-[13.5px] text-ink-900 outline-none focus:border-brand-600"
        />
        <div className="rounded-lg border border-line">
          <Editor handleRef={editor} initialHTML={template?.html ?? ''} placeholder="Template text…" onChange={() => undefined} minHeight={160} />
        </div>
        {isAdmin ? (
          <label className="flex items-center gap-2 text-[13px] text-ink-700">
            <input type="checkbox" checked={shared} disabled={Boolean(template)} onChange={(e) => setShared(e.target.checked)} className="accent-brand-600" />
            Shared with everyone {template ? '(fixed once created)' : ''}
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}

function SectionHead({ title }: { title: string }) {
  return <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>;
}
