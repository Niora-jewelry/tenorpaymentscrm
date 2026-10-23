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

/** The home of a field, as labels, for the chip on a field-mention entry. */
export type FieldPath = { tab: string; subtab: string | null; field: string };
import type { NotificationView } from '@/lib/records/notifications';
import { FLASH_CLASS, targetId, useFlashTarget } from './mentionTarget';

export function UpdatesPanel({
  moduleSlug,
  recordId,
  updates,
  authorNames,
  viewerId,
  isAdmin,
  teamRoster,
  editable,
  mentionsByUpdate = {},
  openMention = null,
  fieldPathByUpdate = {},
}: {
  moduleSlug: string;
  recordId: string;
  updates: Update[];
  /** For a field-mention entry: where the field lives, as labels. */
  fieldPathByUpdate?: Record<string, FieldPath>;
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
  teamRoster: TeamRosterEntry[];
  /** The viewer's unread mentions here, by update id. */
  mentionsByUpdate?: Record<string, NotificationView>;
  /** The mention a link landed on: scrolled to and flashed. */
  openMention?: NotificationView | null;
  /** The Updates tab resolved to Edit for this viewer. False leaves the thread
   * readable and takes away every way to write to it — including an author's
   * own edit/delete. `lib/records/updates.ts` refuses the same set. */
  editable: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [postError, setPostError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Who can be bold: the roster plus everyone who wrote here (an author who
  // has since left the team still has their name in the thread).
  const knownNames = useMemo(
    () => Array.from(new Set([...teamRoster.map((m) => m.name), ...Object.values(authorNames)])),
    [teamRoster, authorNames],
  );

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
    formData.set('mentions', JSON.stringify(mentionIds));
    startTransition(async () => {
      /*
       * These actions return void and THROW on refusal — `requireTabEdit`
       * raises for a viewer without Edit on the tab, and the data layer
       * refuses an author's edit of someone else's post. Unguarded, the throw
       * skipped `router.refresh()` and the click did nothing visible at all.
       */
      try {
        setPostError(null);
        await addUpdateAction(moduleSlug, recordId, null, formData);
        setDraft('');
        router.refresh();
      } catch {
        // The draft survives on purpose — nobody should lose what they wrote
        // because the server said no.
        setPostError('Could not post that update.');
      }
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
          onMentionsChange={setMentionIds}
          roster={teamRoster}
          rows={2}
          disabled={pending}
          formatting
          placeholder="Write an update…  **bold**, *italic*, - lists, and @mention someone to notify them"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-[11.5px] text-ink-400">Replies go exactly one level deep — no replies to replies.</p>
          <Button variant="primary" size="sm" icon="send" loading={pending} loadingLabel="Posting…" disabled={!draft.trim()} onClick={post}>
            Post update
          </Button>
        </div>
        {postError ? (
          <p role="alert" className="mt-1.5 text-[11.5px] text-danger">
            {postError}
          </p>
        ) : null}
      </div>
      ) : null}

      {threads.length === 0 ? (
        <EmptyState icon="message-square" title="No updates yet" body="Team notes appear here." />
      ) : (
        <ul className="space-y-2">
          {threads.map(({ root, replies }) => (
            <Thread
              key={root.id}
              knownNames={knownNames}
              fieldPath={fieldPathByUpdate[root.id] ?? null}
              moduleSlug={moduleSlug}
              root={root}
              replies={replies}
              teamRoster={teamRoster}
              authorNames={authorNames}
              viewerId={viewerId}
              isAdmin={isAdmin}
              editable={editable}
              mentionsByUpdate={mentionsByUpdate}
              openMention={openMention}
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
  knownNames,
  fieldPath,
  teamRoster,
  authorNames,
  viewerId,
  isAdmin,
  editable,
  mentionsByUpdate,
  openMention,
}: {
  moduleSlug: string;
  root: Update;
  replies: Update[];
  knownNames: string[];
  /** Set for a field-mention entry. */
  fieldPath: FieldPath | null;
  mentionsByUpdate: Record<string, NotificationView>;
  openMention: NotificationView | null;
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
  // A link to a reply in this thread opens it; a mention on one keeps it open.
  const targetReply = openMention?.updateId && replies.some((r) => r.id === openMention.updateId) ? openMention.updateId : null;
  const [open, setOpen] = useState(Boolean(targetReply) || replies.some((r) => mentionsByUpdate[r.id]));
  const [draft, setDraft] = useState('');
  const [replyMentionIds, setReplyMentionIds] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(root.body);
  const [editMentionIds, setEditMentionIds] = useState<string[]>(root.mentionedUserIds);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const flashRoot = useFlashTarget(targetId.update(root.id), openMention?.updateId === root.id);

  const authorName = authorNames[root.authorId] ?? 'Unknown user';
  const mine = root.authorId === viewerId;
  const mentionedHere = (id: string) => Boolean(mentionsByUpdate[id]);

  const reply = () => {
    if (!draft.trim()) return;
    const formData = new FormData();
    formData.set('body', draft.trim());
    formData.set('mentions', JSON.stringify(replyMentionIds));
    startTransition(async () => {
      try {
        setError(null);
        await addUpdateAction(moduleSlug, root.recordId, root.id, formData);
      } catch {
        setError('Could not post that reply.');
        return;
      }
      setDraft('');
      setOpen(true);
      router.refresh();
    });
  };

  const saveEdit = () => {
    if (!editDraft.trim()) return;
    startTransition(async () => {
      const result = await editUpdateAction(moduleSlug, root.id, editDraft.trim(), editMentionIds);
      if (!result.ok) setError(result.message ?? 'Could not save.');
      else {
        setEditing(false);
        router.refresh();
      }
    });
  };

  const remove = () => {
    startTransition(async () => {
      try {
        setError(null);
        await deleteUpdateAction(moduleSlug, root.id);
        router.refresh();
      } catch {
        setError('Could not delete that update.');
      }
    });
  };

  return (
    <li
      id={targetId.update(root.id)}
      className={`rounded-xl border bg-white p-3 transition-shadow ${mentionedHere(root.id) ? 'border-brand-300' : 'border-line'} ${flashRoot ? FLASH_CLASS : ''}`}
    >
      <div className="flex gap-3">
        <UserAvatar userId={root.authorId} name={authorName} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink-900">{authorName}</span>
            {fieldPath ? (
              /* A field mention's trace in the feed: where it was sent from. */
              <span
                title="Mentioned from this field"
                className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas px-1.5 py-px text-[10.5px] font-medium text-ink-600"
              >
                <Icon name="at-sign" size={9} strokeWidth={2.5} />
                {fieldPath.tab} → {fieldPath.subtab ? `${fieldPath.subtab} → ` : ''}{fieldPath.field}
              </span>
            ) : null}
            <span className="text-[11.5px] text-ink-400">{relative(root.createdAt, now)}</span>
            {root.editedAt ? <span className="text-[11.5px] text-ink-400">(edited)</span> : null}
            {mentionedHere(root.id) ? <MentionedYou /> : null}
            {editable && (mine || isAdmin) ? (
              <span className="ml-auto flex gap-0.5">
                {/* A field entry records what was sent; it can be removed, not rewritten. */}
                {!root.fieldKey ? (
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
                ) : null}
                <IconButton icon="trash" size={22} tone="danger" title={mine ? 'Remove your update' : 'Remove as admin'} onClick={remove} />
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
                onMentionsChange={setEditMentionIds}
                initialMentions={teamRoster.filter((m) => root.mentionedUserIds.includes(m.id))}
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
            <RichText body={root.body} names={knownNames} className="mt-1 text-[13.5px] leading-relaxed text-ink-700" />
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
                <Reply
                  key={r.id}
                  knownNames={knownNames}
                  r={r}
                  now={now}
                  authorNames={authorNames}
                  mentioned={mentionedHere(r.id)}
                  flash={openMention?.updateId === r.id}
                />
              ))}
              {editable ? (
              <div className="flex items-start gap-2 pt-1">
                <div className="min-w-0 flex-1">
                  {/* The same @ picker as the post, minus the toolbar — the
                      client asks for mentions in replies too. Enter sends. */}
                  <MentionTextarea
                    value={draft}
                    onChange={setDraft}
                    onMentionsChange={setReplyMentionIds}
                    roster={teamRoster}
                    rows={1}
                    disabled={pending}
                    placeholder="Reply… @mention someone to notify them"
                    onSubmitShortcut={reply}
                  />
                </div>
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

function Reply({
  r,
  now,
  authorNames,
  knownNames,
  mentioned,
  flash,
}: {
  r: Update;
  now: Date;
  authorNames: Record<string, string>;
  knownNames: string[];
  mentioned: boolean;
  flash: boolean;
}) {
  const flashing = useFlashTarget(targetId.update(r.id), flash);
  return (
    <div id={targetId.update(r.id)} className={`rounded-lg px-2 py-1 -mx-2 transition-shadow ${mentioned ? 'bg-brand-50/50' : ''} ${flashing ? FLASH_CLASS : ''}`}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[12.5px] font-semibold text-ink-900">{authorNames[r.authorId] ?? 'Unknown user'}</span>
        <span className="text-[11.5px] text-ink-400">{relative(r.createdAt, now)}</span>
        {mentioned ? <MentionedYou /> : null}
      </div>
      {/* Replies render the same way. The client asks for "update-style
          replies", and a reply that shows its markers raw while the update
          above it renders would read as a bug in the update, not a limitation
          of the reply. */}
      <RichText body={r.body} names={knownNames} className="text-[13px] leading-relaxed text-ink-700" />
      {r.mentionedUserIds.length ? (
        <p className="mt-1 inline-flex flex-wrap items-center gap-x-1 text-[11.5px] text-brand-700">
          <Icon name="bell" size={10} />
          {r.mentionedUserIds.map((id) => `@${authorNames[id] ?? 'Unknown user'}`).join(', ')} {r.mentionedUserIds.length === 1 ? 'was' : 'were'} notified
        </p>
      ) : null}
    </div>
  );
}

/** The viewer's own unread mention, on this very item. */
function MentionedYou() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-1.5 py-px text-[10px] font-bold uppercase tracking-[.04em] text-white">
      <Icon name="at-sign" size={9} strokeWidth={2.5} /> You
    </span>
  );
}
