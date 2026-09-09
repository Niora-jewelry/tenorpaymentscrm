'use client';

/**
 * Updates — threaded exactly one level deep, ported from
 * `src/proto/ui/tabs.tsx`'s `UpdatesTab`/`Thread`. @mention autocomplete
 * (`MentionTextarea`) and the "was notified" chip are real now — parsed
 * against the record's actual team roster and written through
 * `add_update_with_mentions()`. The notification bell itself lives in
 * `Sidebar.tsx`.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, EmptyState, IconButton } from '@/proto/ui/kit';
import { relative } from '@/proto/ui/tokens';
import { UserAvatar } from './UserAvatar';
import { MentionTextarea } from './MentionTextarea';
import { RichText } from '@/proto/ui/richText';
import { addUpdateAction, editUpdateAction, deleteUpdateAction } from './actions';
import type { Update, TeamRosterEntry } from '@/lib/records/updates';

export function UpdatesPanel({
  moduleSlug,
  recordId,
  updates,
  authorNames,
  viewerId,
  isAdmin,
  teamRoster,
  editable,
}: {
  moduleSlug: string;
  recordId: string;
  updates: Update[];
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
  teamRoster: TeamRosterEntry[];
  /** The Updates tab resolved to Edit for this viewer. False leaves the thread
   * readable and takes away every way to write to it — including an author's
   * own edit/delete. `lib/records/updates.ts` refuses the same set. */
  editable: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [pending, startTransition] = useTransition();

  const threads = useMemo(() => {
    const roots = updates.filter((u) => !u.parentId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return roots.map((root) => ({
      root,
      replies: updates.filter((u) => u.parentId === root.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
    }));
  }, [updates]);

  const post = () => {
    if (!draft.trim()) return;
    const formData = new FormData();
    formData.set('body', draft.trim());
    startTransition(async () => {
      await addUpdateAction(moduleSlug, recordId, null, formData);
      setDraft('');
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {editable ? (
      <div className="rounded-xl border border-line bg-white p-3">
        {/* Modules §3.2: "users write updates with rich text support". The
            toolbar wraps the selection in markers; the body stays plain text so
            @mentions still parse and the audit trail stays readable. */}
        <MentionTextarea
          value={draft}
          onChange={setDraft}
          roster={teamRoster}
          rows={2}
          disabled={pending}
          formatting
          placeholder="Write an update…  **bold**, *italic*, - lists, and @mention a team member to notify them"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-[11.5px] text-ink-400">Replies go exactly one level deep — no replies to replies.</p>
          <Button variant="primary" size="sm" icon="send" loading={pending} loadingLabel="Posting…" disabled={!draft.trim()} onClick={post}>
            Post update
          </Button>
        </div>
      </div>
      ) : null}

      {threads.length === 0 ? (
        <EmptyState icon="message-square" title="No updates yet" body="Team notes appear here." />
      ) : (
        <ul className="space-y-2">
          {threads.map(({ root, replies }) => (
            <Thread
              key={root.id}
              moduleSlug={moduleSlug}
              root={root}
              replies={replies}
              teamRoster={teamRoster}
              authorNames={authorNames}
              viewerId={viewerId}
              isAdmin={isAdmin}
              editable={editable}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Thread({
  moduleSlug,
  root,
  replies,
  teamRoster,
  authorNames,
  viewerId,
  isAdmin,
  editable,
}: {
  moduleSlug: string;
  root: Update;
  replies: Update[];
  /** Needed down here too: editing an update keeps the same composer, and that
   *  composer offers @mention autocomplete against this record's own team. */
  teamRoster: TeamRosterEntry[];
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
  editable: boolean;
}) {
  const router = useRouter();
  const [now] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(root.body);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const authorName = authorNames[root.authorId] ?? 'Unknown user';
  const mine = root.authorId === viewerId;

  const reply = () => {
    if (!draft.trim()) return;
    const formData = new FormData();
    formData.set('body', draft.trim());
    startTransition(async () => {
      await addUpdateAction(moduleSlug, root.recordId, root.id, formData);
      setDraft('');
      setOpen(true);
      router.refresh();
    });
  };

  const saveEdit = () => {
    if (!editDraft.trim()) return;
    startTransition(async () => {
      const result = await editUpdateAction(moduleSlug, root.id, editDraft.trim());
      if (!result.ok) setError(result.message ?? 'Could not save.');
      else {
        setEditing(false);
        router.refresh();
      }
    });
  };

  const remove = () => {
    startTransition(async () => {
      await deleteUpdateAction(moduleSlug, root.id);
      router.refresh();
    });
  };

  return (
    <li className="rounded-xl border border-line bg-white p-3">
      <div className="flex gap-3">
        <UserAvatar userId={root.authorId} name={authorName} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink-900">{authorName}</span>
            <span className="text-[11.5px] text-ink-400">{relative(root.createdAt, now)}</span>
            {root.editedAt ? <span className="text-[11.5px] text-ink-400">(edited)</span> : null}
            {editable && (mine || isAdmin) ? (
              <span className="ml-auto flex gap-0.5">
                <IconButton
                  icon="pencil"
                  size={22}
                  title={mine ? 'Edit your update' : 'Edit as admin'}
                  onClick={() => {
                    setEditing(true);
                    setEditDraft(root.body);
                    setError(null);
                  }}
                />
                <IconButton icon="trash" size={22} tone="danger" title={mine ? 'Delete your update' : 'Delete as admin'} onClick={remove} />
              </span>
            ) : null}
          </div>

          {editing ? (
            <div className="mt-1.5">
              {/* The same composer the update was written in, so editing keeps
                  the formatting bar and the @mention autocomplete instead of
                  dropping to a bare box the moment someone fixes a typo. */}
              <MentionTextarea
                value={editDraft}
                onChange={setEditDraft}
                roster={teamRoster}
                rows={2}
                disabled={pending}
                formatting
              />
              {error ? <p className="mt-1 text-[11px] text-danger">{error}</p> : null}
              <div className="mt-1.5 flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" loading={pending} loadingLabel="Saving…" disabled={!editDraft.trim()} onClick={saveEdit}>
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <RichText body={root.body} className="mt-1 text-[13.5px] leading-relaxed text-ink-700" />
          )}

          {!editing && root.mentionedUserIds.length ? (
            <p className="mt-1.5 inline-flex flex-wrap items-center gap-x-1 text-[12px] text-brand-700">
              <Icon name="bell" size={11} />
              {root.mentionedUserIds
                .map((id) => `@${authorNames[id] ?? 'Unknown user'}`)
                .join(', ')}{' '}
              {root.mentionedUserIds.length === 1 ? 'was' : 'were'} notified
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline"
          >
            <Icon name="chevron-down" size={12} className={`transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </button>

          {open ? (
            <div className="mt-2 space-y-2 border-l-2 border-line pl-3">
              {replies.map((r) => (
                <div key={r.id}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12.5px] font-semibold text-ink-900">{authorNames[r.authorId] ?? 'Unknown user'}</span>
                    <span className="text-[11.5px] text-ink-400">{relative(r.createdAt, now)}</span>
                  </div>
                  {/* Replies render the same way. The client asks for
                      "update-style replies", and a reply that shows its markers
                      raw while the update above it renders would read as a bug
                      in the update, not a limitation of the reply. */}
                  <RichText body={r.body} className="text-[13px] leading-relaxed text-ink-700" />
                </div>
              ))}
              {editable ? (
              <div className="flex gap-2 pt-1">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && reply()}
                  disabled={pending}
                  placeholder="Reply…"
                  className="flex-1 rounded-md border border-line px-2 py-1.5 text-[13px] outline-none transition-colors focus-underline"
                />
                <Button size="sm" icon="reply" loading={pending} loadingLabel="Sending…" disabled={!draft.trim()} onClick={reply}>
                  Reply
                </Button>
              </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
