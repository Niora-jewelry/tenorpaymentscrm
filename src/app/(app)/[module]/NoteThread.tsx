'use client';

/**
 * Notes — one component, two scopes (field or tab), ported from
 * `src/proto/ui/tabs.tsx`'s `NoteThread`/`TabNotes`. Real author names come
 * from `profile_names()` (migration 28) via `authorNames`, resolved once
 * server-side in `page.tsx` — this component never fetches, it only renders
 * what it's given and calls the three note actions.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, CountPill, IconButton } from '@/proto/ui/kit';
import { relative } from '@/proto/ui/tokens';
import { UserAvatar } from './UserAvatar';
import { addNoteAction, editNoteAction, deleteNoteAction } from './actions';
import type { Note } from '@/lib/records/notes';

/** "Each tab should have a notes field" — a collapsible thread per tab/subtab. */
export function TabNotes({
  moduleSlug,
  recordId,
  scopeId,
  notes,
  authorNames,
  viewerId,
  isAdmin,
}: {
  moduleSlug: string;
  recordId: string;
  scopeId: string;
  notes: Note[];
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-canvas"
      >
        <Icon name="sticky-note" size={13} className="text-ink-400" />
        <span className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-500">Tab notes</span>
        {notes.length ? <CountPill n={notes.length} /> : null}
        <Icon
          name="chevron-down"
          size={13}
          className={`ml-auto text-ink-400 transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open ? (
        <div className="border-t border-line-soft px-3 pb-3">
          <NoteThread
            moduleSlug={moduleSlug}
            recordId={recordId}
            scopeKind="tab"
            scopeId={scopeId}
            notes={notes}
            authorNames={authorNames}
            viewerId={viewerId}
            isAdmin={isAdmin}
            title="this tab"
          />
        </div>
      ) : null}
    </section>
  );
}

export function NoteThread({
  moduleSlug,
  recordId,
  scopeKind,
  scopeId,
  notes,
  authorNames,
  viewerId,
  isAdmin,
  title,
  compact,
}: {
  moduleSlug: string;
  recordId: string;
  scopeKind: 'field' | 'tab';
  scopeId: string;
  notes: Note[];
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
  title: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [now] = useState(() => new Date());
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!draft.trim()) return;
    const formData = new FormData();
    formData.set('body', draft.trim());
    startTransition(async () => {
      await addNoteAction(moduleSlug, recordId, scopeKind, scopeId, formData);
      setDraft('');
      router.refresh();
    });
  };

  const saveEdit = (noteId: string) => {
    if (!editDraft.trim()) return;
    startTransition(async () => {
      const result = await editNoteAction(moduleSlug, noteId, editDraft.trim());
      if (!result.ok) setError(result.message ?? 'Could not save.');
      else {
        setEditingId(null);
        router.refresh();
      }
    });
  };

  const remove = (noteId: string) => {
    startTransition(async () => {
      await deleteNoteAction(moduleSlug, noteId);
      router.refresh();
    });
  };

  return (
    <div className={compact ? 'mt-1.5 rounded-lg border border-line bg-canvas p-2' : 'pt-2'}>
      {error ? <p className="mb-1.5 text-[11px] text-danger">{error}</p> : null}
      <div className="space-y-1.5">
        {notes.length === 0 ? (
          <p className="text-[12px] text-ink-400">No notes on {title} yet.</p>
        ) : (
          notes.map((n) => {
            const authorName = authorNames[n.authorId] ?? 'Unknown user';
            const mine = n.authorId === viewerId;
            return (
              <div key={n.id} className="rounded-md border border-line bg-white p-2">
                {editingId === n.id ? (
                  <>
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={2}
                      disabled={pending}
                      className="w-full resize-none rounded border border-line px-2 py-1.5 text-[13px] outline-none editing-underline"
                    />
                    <div className="mt-1.5 flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" loading={pending} loadingLabel="Saving…" disabled={!editDraft.trim()} onClick={() => saveEdit(n.id)}>
                        Save
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-[12.5px] leading-relaxed text-ink-700">{n.body}</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <UserAvatar userId={n.authorId} name={authorName} size={15} />
                      <span className="text-[11px] text-ink-400">
                        {authorName} · {relative(n.createdAt, now)}
                        {n.editedAt ? ' · edited' : ''}
                      </span>
                      {mine || isAdmin ? (
                        <span className="ml-auto flex gap-0.5">
                          <IconButton
                            icon="pencil"
                            size={20}
                            title={mine ? 'Edit this note' : 'Edit as admin'}
                            onClick={() => {
                              setEditingId(n.id);
                              setEditDraft(n.body);
                              setError(null);
                            }}
                          />
                          <IconButton
                            icon="trash"
                            size={20}
                            tone="danger"
                            title={mine ? 'Delete this note' : 'Delete as admin'}
                            onClick={() => remove(n.id)}
                          />
                        </span>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-1.5 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Add a note…"
          disabled={pending}
          className="flex-1 rounded-md border border-line bg-white px-2 py-1.5 text-[12.5px] outline-none transition-colors focus-underline"
        />
        <Button size="sm" icon="plus" loading={pending} loadingLabel="Adding…" disabled={!draft.trim()} onClick={submit}>
          Add
        </Button>
      </div>
    </div>
  );
}
