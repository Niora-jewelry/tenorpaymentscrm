'use client';

/**
 * Cases — ported from `src/proto/ui/tabs.tsx`'s `CasesTab`/`CaseCard`.
 * Manager-gated actions (write solution, close/reopen) are enforced
 * server-side inside `set_case_solution()`/`toggle_case_state()` (migration
 * 30) — `isManager` here only decides what to show, same as the prototype.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useActionState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, CaseStatePill, Dialog, EmptyState, IconButton, SectionLabel, SpecNote } from '@/proto/ui/kit';
import { relative } from '@/proto/ui/tokens';
import { UserAvatar } from './UserAvatar';
import {
  createCaseAction,
  addCaseReplyAction,
  setCaseStateAction,
  setCaseSolutionAction,
  setCaseHandlingNoteAction,
  deleteCaseAction,
  type ActionState,
} from './actions';
import type { CaseThread, CaseReply, CaseHandlingNote } from '@/lib/records/cases';
import type { Candidate, NotificationView } from '@/lib/records/notifications';
import { MentionTextarea } from './MentionTextarea';
import { RichText } from '@/proto/ui/richText';
import { FLASH_CLASS, targetId, useFlashTarget } from './mentionTarget';
import type { CaseAttachments as CaseAttachmentMap } from '@/lib/records/caseAttachments';
import { CaseAttachments } from './CaseAttachments';

const initial: ActionState = { ok: false };

export function CasesPanel({
  moduleSlug,
  recordId,
  cases,
  repliesByCase,
  managersByCase,
  attachmentsByCase,
  authorNames,
  viewerId,
  isAdmin,
  editable,
  handlingNote,
  caseRoster = [],
  mentionsByCase = {},
  openMention = null,
}: {
  /** Who may be @mentioned on this record's cases. */
  caseRoster?: Candidate[];
  /** The viewer's unread mentions here, by case id, oldest first. */
  mentionsByCase?: Record<string, NotificationView[]>;
  openMention?: NotificationView | null;
  moduleSlug: string;
  recordId: string;
  cases: CaseThread[];
  repliesByCase: Record<string, CaseReply[]>;
  managersByCase: Record<string, string[]>;
  /** Files on each case's Issue, Solution and replies — Modules §3.7. Keyed by
   *  case id, then by attachment point (`issue`, `solution`, `reply:<id>`). */
  attachmentsByCase: Record<string, CaseAttachmentMap>;
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
  /** The Cases tab resolved to Edit for this viewer. False makes the thread
   * read-only — no new case, no reply, no solution, no state change. The
   * matching refusals live in `lib/records/cases.ts`; this only stops an
   * honest click from reaching one. */
  editable: boolean;
  /** The record's standing "how to handle tickets here" instruction, or null. */
  handlingNote: CaseHandlingNote;
}) {
  const [state, action, creatingPending] = useActionState(
    createCaseAction.bind(null, moduleSlug, recordId),
    initial,
  );
  const [creating, setCreating] = useState(false);
  const open = cases.filter((c) => c.state === 'open').length;

  /*
   * `createCaseAction` returns `{ ok: true }` and nothing was reading it. The
   * new case did appear in the list below, but the form stayed open with the
   * typed title and issue still in it and no confirmation of any kind — which
   * reads as "that didn't submit". Pressing the button again opens a real
   * duplicate case: `create_case` has no idempotency and no duplicate guard,
   * and case numbers come from a global sequence that never reuses a number.
   */
  // Adjusted during render rather than in an effect — React's own "you might
  // not need an effect" pattern, and the same one `RecordsTable` uses for its
  // `rowsSnapshot`. An effect here would render the form open for one frame
  // after a successful submit before closing it.
  const [okSnapshot, setOkSnapshot] = useState(state.ok);
  if (state.ok !== okSnapshot) {
    setOkSnapshot(state.ok);
    if (state.ok) setCreating(false);
  }

  return (
    <div className="space-y-4">
      {/*
        ── HOW TO DEAL WITH THIS MERCHANT'S TICKETS ────────────────────────
        Asked for by the client in these words: "an input at the top where we
        can input a method of dealing with tickets so anyone dealing with the
        ticket knows how to deal with it".

        FIRST in the tab, above even the spec note, because its whole purpose
        is to be read BEFORE a case is opened or answered. Anywhere lower and
        the person it is written for has already started.

        One per record, not per case, and it is not a thread — there is
        nothing to reply to. See `case_handling_notes`.
      */}
      <HandlingNote
        moduleSlug={moduleSlug}
        recordId={recordId}
        note={handlingNote}
        editable={editable}
        authorNames={authorNames}
      />

      <SpecNote>
        Case numbers come from a <strong>single global sequence starting at #10000</strong> spanning
        the whole CRM, so a number identifies exactly one case anywhere. Numbers are never reused,
        even after a purge. Case content is <strong>immutable to non-admins</strong> — including its
        own author — but anyone can reply.
      </SpecNote>

      {!editable ? null : creating ? (
        <form action={action} className="rounded-xl border border-line bg-white p-3">
          <SectionLabel>New case</SectionLabel>
          <input
            name="title"
            required
            placeholder="Short title"
            className="mt-2 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none transition-colors focus-field"
          />
          <label className="mt-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-400">
            Issue
            <span className="inline-flex items-center gap-1 text-[#c07714]">
              <Icon name="alert-triangle" size={11} />
              required
            </span>
          </label>
          <textarea
            name="issue"
            required
            rows={3}
            placeholder="Describe the problem. This cannot be edited once saved."
            className="mt-1 w-full resize-none rounded-md border border-line px-3 py-2 text-[13.5px] outline-none transition-colors focus-field"
          />
          {state.message ? <p className="mt-1.5 text-[11.5px] text-danger">{state.message}</p> : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" type="button" disabled={creatingPending} onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="flag"
              type="submit"
              loading={creatingPending}
              loadingLabel="Opening…"
            >
              Open case
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
            Open a case
          </Button>
          {cases.length ? (
            <span className="text-[12.5px] text-ink-400 tabular">
              {cases.length} total · {open} open
            </span>
          ) : null}
        </div>
      )}

      {cases.length === 0 ? (
        <EmptyState icon="flag" title="No cases on this record" />
      ) : (
        <ul className="space-y-3">
          {cases.map((c) => (
            <CaseCard
              key={c.id}
              moduleSlug={moduleSlug}
              c={c}
              replies={repliesByCase[c.id] ?? []}
              managerIds={managersByCase[c.id] ?? []}
              attachments={attachmentsByCase[c.id] ?? {}}
              authorNames={authorNames}
              viewerId={viewerId}
              isAdmin={isAdmin}
              editable={editable}
              roster={caseRoster}
              mentions={mentionsByCase[c.id] ?? []}
              openMention={openMention?.caseId === c.id ? openMention : null}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseCard({
  moduleSlug,
  c,
  replies,
  managerIds,
  attachments,
  authorNames,
  viewerId,
  isAdmin,
  editable,
  roster,
  mentions,
  openMention,
}: {
  moduleSlug: string;
  c: CaseThread;
  replies: CaseReply[];
  roster: Candidate[];
  mentions: NotificationView[];
  openMention: NotificationView | null;
  managerIds: string[];
  /** This case's files, by attachment point — `issue`, `solution`,
   *  `reply:<replyId>`. Absent keys mean nothing attached there. */
  attachments: CaseAttachmentMap;
  authorNames: Record<string, string>;
  viewerId: string;
  isAdmin: boolean;
  editable: boolean;
}) {
  const router = useRouter();
  const [now] = useState(() => new Date());
  const [pending, startTransition] = useTransition();
  // Open if the case is open, if a link landed here, or if I was mentioned in it.
  const [expanded, setExpanded] = useState(c.state === 'open' || Boolean(openMention) || mentions.length > 0);
  const [writing, setWriting] = useState(false);
  const [solutionDraft, setSolutionDraft] = useState('');
  const [replyDraft, setReplyDraft] = useState('');
  const [replyMentionIds, setReplyMentionIds] = useState<string[]>([]);
  const mentionedReplies = new Set(mentions.map((m) => m.caseReplyId));
  const knownNames = useMemo(() => Array.from(new Set([...roster.map((m) => m.name), ...Object.values(authorNames)])), [roster, authorNames]);
  const flashCard = useFlashTarget(targetId.case(c.id), Boolean(openMention) && !openMention?.caseReplyId);
  const [error, setError] = useState<string | null>(null);
  /*
   * Reply failures get their OWN message, rendered under the reply box.
   * `error` renders at the top of the expanded case, which is fine for the
   * solution editor sitting near it — but the reply box is at the very bottom,
   * under the issue text and every existing reply. A failed reply reported up
   * there is off-screen on any case with real content, so the user sees the
   * spinner stop and nothing else.
   */
  const [replyError, setReplyError] = useState<string | null>(null);

  // A View tab takes the manager's own controls away too — being a ticket
  // manager is not a route around the tab's grant.
  const isManager = editable && (isAdmin || managerIds.includes(viewerId));
  const canClose = Boolean(c.solution);

  const sendReply = () => {
    if (!replyDraft.trim()) return;
    const formData = new FormData();
    formData.set('body', replyDraft.trim());
    formData.set('mentions', JSON.stringify(replyMentionIds));
    startTransition(async () => {
      setReplyError(null);
      const result = await addCaseReplyAction(moduleSlug, c.id, formData);
      if (!result.ok) {
        // The draft is deliberately NOT cleared — someone who has just typed a
        // reply to a merchant should not lose it because the server refused.
        setReplyError(result.message ?? 'Could not send that reply.');
        return;
      }
      setReplyDraft('');
      router.refresh();
    });
  };

  const saveSolution = () => {
    if (!solutionDraft.trim()) return;
    startTransition(async () => {
      const result = await setCaseSolutionAction(moduleSlug, c.id, solutionDraft.trim());
      if (!result.ok) setError(result.message ?? 'Could not save.');
      else {
        setWriting(false);
        router.refresh();
      }
    });
  };

  const toggleState = () => {
    startTransition(async () => {
      const result = await setCaseStateAction(moduleSlug, c.id, c.state === 'open');
      if (!result.ok) setError(result.message ?? 'Could not change state.');
      else router.refresh();
    });
  };

  /*
   * ── CLOSE AND DELETE FROM THE HEADER ROW ─────────────────────────────────
   * Asked for by the client (16 Oct 2026): "add delete icon and also closed
   * case or complete option" on the case itself. Both used to need the card
   * expanded — Close sat at the bottom of the open card, Delete did not exist
   * in the app at all (`delete_case` has been in the database since migration
   * 53 with nothing calling it).
   *
   * Closing needs a Solution — a database rule, `closed_requires_solution` —
   * so a case without one does not simply refuse: the header button opens a
   * small "Complete" box that takes the solution and closes in one go. A case
   * that already has one closes straight away. Reopen is the same button.
   *
   * Delete is admin-only (the function refuses anyone else) and soft: the
   * thread and its replies go to the Recycle Bin, where `restore_case` brings
   * them back. Case NUMBERS are never reused, so #10068 stays #10068.
   */
  const [completing, setCompleting] = useState(false);
  const [completeDraft, setCompleteDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const complete = () => {
    if (c.state !== 'open') return toggleState();
    if (c.solution) return toggleState();
    setCompleteDraft('');
    setCompleting(true);
  };

  const confirmComplete = () => {
    const solution = completeDraft.trim();
    if (!solution) return;
    startTransition(async () => {
      const saved = await setCaseSolutionAction(moduleSlug, c.id, solution);
      if (!saved.ok) {
        setError(saved.message ?? 'Could not save the solution.');
        setCompleting(false);
        return;
      }
      const closed = await setCaseStateAction(moduleSlug, c.id, true);
      if (!closed.ok) setError(closed.message ?? 'Could not close the case.');
      setCompleting(false);
      router.refresh();
    });
  };

  const runDelete = () => {
    startTransition(async () => {
      const result = await deleteCaseAction(moduleSlug, c.id);
      setConfirmDelete(false);
      if (!result.ok) setError(result.message ?? 'Could not delete that case.');
      else router.refresh();
    });
  };

  return (
    <li id={targetId.case(c.id)} className={`overflow-hidden rounded-xl border bg-white transition-shadow ${mentions.length ? 'border-brand-300' : 'border-line'} ${flashCard ? FLASH_CLASS : ''}`}>
      {/* A row, not one big button: the title half toggles the card, the
          action half holds real controls. Nesting buttons is invalid HTML and
          made every control a toggle as well. */}
      <div className="flex w-full flex-wrap items-center gap-2 border-b border-line-soft bg-canvas px-4 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-brand-700"
        >
          <Icon name="chevron-down" size={13} className={`shrink-0 text-ink-400 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`} />
          <span className="font-mono text-[12.5px] font-semibold text-ink-500 tabular">#{c.number}</span>
          <span className="truncate text-[13.5px] font-semibold text-ink-900">{c.title}</span>
          {mentions.length ? (
            <span
              title={`${mentions.length} unread mention${mentions.length === 1 ? '' : 's'} for you in this case`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-600 px-1.5 py-px text-[10px] font-bold text-white"
            >
              <Icon name="at-sign" size={9} strokeWidth={2.5} />
              {mentions.length > 1 ? mentions.length : null}
            </span>
          ) : null}
          {replies.length ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-400">
              <Icon name="message-square" size={11} />
              {replies.length}
            </span>
          ) : null}
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <CaseStatePill state={c.state} />
          {editable ? (
            <Button
              size="sm"
              icon={c.state === 'open' ? 'check' : 'rotate-ccw'}
              variant={c.state === 'open' ? 'secondary' : 'ghost'}
              disabled={pending || !isManager}
              title={
                !isManager
                  ? 'Only an assigned ticket manager can change the state'
                  : c.state === 'open'
                    ? c.solution
                      ? 'Close this case'
                      : 'Write the solution and close this case'
                    : 'Reopen this case'
              }
              onClick={complete}
            >
              {c.state === 'open' ? 'Close case' : 'Reopen'}
            </Button>
          ) : null}
          {isAdmin && editable ? (
            <IconButton
              icon="trash"
              tone="danger"
              size={28}
              title={`Delete case #${c.number} — moves it to the Recycle Bin`}
              onClick={() => setConfirmDelete(true)}
            />
          ) : null}
        </span>
      </div>

      {completing ? (
        <Dialog
          title={`Close case #${c.number}`}
          confirmLabel={pending ? 'Closing…' : 'Save solution and close'}
          confirmIcon="check"
          onConfirm={confirmComplete}
          onClose={() => setCompleting(false)}
        >
          <p className="text-[13px] text-ink-600">
            A case closes with its solution on record. Write what resolved it; the case is then marked
            Closed and leaves Tickets.
          </p>
          <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Solution</label>
          <textarea
            autoFocus
            value={completeDraft}
            onChange={(e) => setCompleteDraft(e.target.value)}
            rows={4}
            placeholder="What resolved this case?"
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
          />
          {!completeDraft.trim() ? (
            <p className="mt-1 text-[11.5px] text-ink-400">The solution is required to close a case.</p>
          ) : null}
        </Dialog>
      ) : null}

      {confirmDelete ? (
        <Dialog
          title={`Delete case #${c.number}?`}
          tone="danger"
          confirmLabel={pending ? 'Deleting…' : 'Delete case'}
          confirmIcon="trash"
          onConfirm={runDelete}
          onClose={() => setConfirmDelete(false)}
        >
          <p className="text-[13px] text-ink-600">
            <strong className="font-semibold text-ink-900">{c.title}</strong> and its{' '}
            {replies.length === 1 ? 'reply' : `${replies.length} replies`} move to the Recycle Bin, where an admin
            can restore them. Its number is never reused.
          </p>
        </Dialog>
      ) : null}

      {expanded ? (
        <>
          <div className="space-y-3 px-4 py-3">
            {error ? <p className="text-[11.5px] text-danger">{error}</p> : null}
            <div>
              <SectionLabel>Issue</SectionLabel>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-700">{c.issue}</p>
              <p className="mt-1 text-[11.5px] text-ink-400">
                {authorNames[c.issueAuthor] ?? 'Unknown user'} · {relative(c.issueAt, now)}
                {c.editedBy ? ` · edited by ${authorNames[c.editedBy] ?? 'Unknown user'}` : ''}
              </p>
              {/* Modules §3.7: files attach to the Issue, the Solution and each
                  individual reply. Three points, one component — underneath
                  they are the same file rows the Files tab uses. */}
              <CaseAttachments
                moduleSlug={moduleSlug}
                caseId={c.id}
                point="issue"
                files={attachments.issue ?? []}
                editable={editable}
              />
            </div>

            <div>
              <SectionLabel>Solution</SectionLabel>
              {c.solution ? (
                <>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-ink-700">{c.solution}</p>
                  <p className="mt-1 text-[11.5px] text-ink-400">
                    {c.solutionAuthor ? authorNames[c.solutionAuthor] ?? 'Unknown user' : ''} ·{' '}
                    {c.solutionAt ? relative(c.solutionAt, now) : ''}
                  </p>
                  <CaseAttachments
                    moduleSlug={moduleSlug}
                    caseId={c.id}
                    point="solution"
                    files={attachments.solution ?? []}
                    editable={editable}
                  />
                </>
              ) : writing ? (
                <div className="mt-1">
                  <textarea
                    value={solutionDraft}
                    onChange={(e) => setSolutionDraft(e.target.value)}
                    rows={3}
                    disabled={pending}
                    className="w-full resize-none rounded-md border border-line px-3 py-2 text-[13.5px] outline-none transition-colors focus-field"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => setWriting(false)}>
                      Cancel
                    </Button>
                    <Button size="sm" icon="check" loading={pending} loadingLabel="Saving…" disabled={!solutionDraft.trim()} onClick={saveSolution}>
                      Save solution
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-1 flex items-center gap-3">
                    <span className="text-[13px] text-ink-400">Not written yet.</span>
                    {isManager ? (
                      <button
                        type="button"
                        onClick={() => setWriting(true)}
                        className="text-[12.5px] font-semibold text-brand-700 hover:underline"
                      >
                        Write the solution
                      </button>
                    ) : null}
                  </div>
                  {/* Files already attached to an unwritten Solution still show.
                      The two are independent: §3.7 attaches files to the
                      Solution as a place on the thread, not to its text, and a
                      file uploaded before anyone wrote the words must not
                      vanish from the screen until they do. */}
                  {attachments.solution?.length ? (
                    <CaseAttachments
                      moduleSlug={moduleSlug}
                      caseId={c.id}
                      point="solution"
                      files={attachments.solution}
                      editable={editable}
                    />
                  ) : null}
                </>
              )}
            </div>

            <div>
              <SectionLabel>Replies</SectionLabel>
              {replies.length ? (
                <div className="mt-1 space-y-2 border-l-2 border-line pl-3">
                  {replies.map((r) => {
                    const name = authorNames[r.authorId] ?? 'Unknown user';
                    return (
                      <CaseReplyRow
                        key={r.id}
                        r={r}
                        mentioned={mentionedReplies.has(r.id)}
                        flash={openMention?.caseReplyId === r.id}
                      >
                        <UserAvatar userId={r.authorId} name={name} size={20} />
                        <div className="min-w-0 flex-1">
                          <RichText body={r.body} names={knownNames} className="text-[13px] leading-relaxed text-ink-700" />
                          <p className="text-[11px] text-ink-400">
                            {name} · {relative(r.createdAt, now)} · not editable
                            {r.mentionedUserIds.length ? ` · ${r.mentionedUserIds.map((id) => `@${authorNames[id] ?? 'Unknown user'}`).join(', ')} notified` : ''}
                          </p>
                          {/* "Not editable" is about the WORDS — §3.7 says
                              replies cannot be edited or deleted once posted.
                              Attaching a file to one is a separate act with its
                              own activity-log entry, and the client asks for it
                              explicitly. */}
                          <CaseAttachments
                            moduleSlug={moduleSlug}
                            caseId={c.id}
                            point="reply"
                            replyId={r.id}
                            files={attachments[`reply:${r.id}`] ?? []}
                            editable={editable}
                          />
                        </div>
                      </CaseReplyRow>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1 text-[12.5px] text-ink-400">No replies yet.</p>
              )}

              {editable ? (
              <div className="mt-2 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <MentionTextarea
                    value={replyDraft}
                    onChange={setReplyDraft}
                    onMentionsChange={setReplyMentionIds}
                    roster={roster}
                    rows={1}
                    disabled={pending}
                    placeholder={c.state === 'open' ? 'Reply to this case… @mention someone to notify them' : 'Reply — the case is closed'}
                    onSubmitShortcut={sendReply}
                  />
                </div>
                <Button size="sm" icon="reply" loading={pending} loadingLabel="Sending…" disabled={!replyDraft.trim()} onClick={sendReply}>
                  Reply
                </Button>
              </div>
              ) : null}
              {replyError ? (
                <p role="alert" className="mt-1.5 text-[11.5px] text-danger">
                  {replyError}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-4 py-2.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">Ticket managers</span>
            <span className="flex -space-x-1.5">
              {managerIds.map((id) => (
                <UserAvatar key={id} userId={id} name={authorNames[id] ?? 'Unknown user'} />
              ))}
            </span>
            <div className="ml-auto">
              <Button
                size="sm"
                icon={c.state === 'open' ? 'check' : 'rotate-ccw'}
                variant={c.state === 'open' ? 'secondary' : 'ghost'}
                disabled={pending || !isManager || (c.state === 'open' && !canClose)}
                title={
                  !isManager
                    ? 'Only an assigned ticket manager can change the state'
                    : c.state === 'open' && !canClose
                      ? 'Write the Solution before closing'
                      : undefined
                }
                onClick={toggleState}
              >
                {c.state === 'open' ? 'Close case' : 'Reopen case'}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </li>
  );
}


/**
 * The standing instruction, read-only until you click Edit.
 *
 * ── WHY IT IS NOT ALWAYS A TEXTAREA ─────────────────────────────────────
 * This is read far more often than it is written — once per person per
 * ticket, against roughly never. A box permanently in edit mode reads as
 * something you are being asked to fill in, which is wrong for a note that
 * is usually already correct, and it invites an accidental keystroke into a
 * paragraph several people rely on.
 *
 * When empty it collapses to one quiet line rather than an empty card. A
 * record with no special handling is the normal case, and a blank panel at
 * the top of every Cases tab would be noise on all of them.
 */
function HandlingNote({
  moduleSlug,
  recordId,
  note,
  editable,
  authorNames,
}: {
  moduleSlug: string;
  recordId: string;
  note: CaseHandlingNote;
  editable: boolean;
  authorNames: Record<string, string>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  /*
   * ⚠️ WHAT WE JUST SAVED, UNTIL THE SERVER SAYS SO ITSELF.
   *
   * `note` is a server prop, and `revalidatePath` does not repaint this
   * component synchronously — the action resolves, `editing` goes false, and
   * for a moment the component renders from a prop that still says there is
   * no note. Without this the text the user had just typed VANISHED on save
   * and the empty "add a note" button came back, which reads as the save
   * having failed. It had not: the row was already in the database. Caught by
   * `scripts/verify-client-reports.mjs`, which asserts on both the database
   * and the screen rather than trusting one of them.
   *
   * `null` means "we have not saved anything this session, use the server's
   * copy". An empty STRING means "we saved a removal", which must win over a
   * server prop that still carries the old text — the same
   * absent-versus-empty distinction the shared value store makes.
   */
  const [saved, setSaved] = useState<string | null>(null);

  /* The server's copy wins whenever a fresh render arrives, so a save made
     somewhere else is not masked by a stale draft, and our own optimistic
     copy is retired once the real one carries the same news. Compared during
     render against a snapshot, the idiom used elsewhere in this drawer. */
  const [snapshot, setSnapshot] = useState(note?.body ?? '');
  if ((note?.body ?? '') !== snapshot) {
    setSnapshot(note?.body ?? '');
    setSaved(null);
    if (!editing) setDraft(note?.body ?? '');
  }

  /** What is actually on screen: our own save if we made one, else the server's. */
  const body = saved !== null ? saved : (note?.body ?? '');

  const save = (next: string) => {
    setError(null);
    startSaving(async () => {
      const result = await setCaseHandlingNoteAction(moduleSlug, recordId, next);
      if (result.ok) {
        setSaved(next.trim());
        setEditing(false);
      } else {
        setError(result.message ?? 'Could not save that note.');
      }
    });
  };

  if (editing) {
    return (
      <div className="rounded-xl border border-brand-600/30 bg-brand-50/40 p-3">
        <SectionLabel>How to deal with this merchant&rsquo;s tickets</SectionLabel>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          maxLength={4000}
          placeholder="e.g. Always call Yitzchok before replying — he answers on the mobile, not the office line."
          className="mt-2 w-full resize-y rounded-md border border-line bg-white px-3 py-2 text-[13.5px] leading-relaxed outline-none transition-colors focus-field"
        />
        {error ? (
          <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-danger">
            <Icon name="alert-triangle" size={12} />
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            icon="check"
            loading={saving}
            loadingLabel="Saving…"
            onClick={() => save(draft)}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setDraft(note?.body ?? '');
              setError(null);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          {/* Clearing is the same action with an empty body, which deletes
              the row — see `setCaseHandlingNote`. Offered only when there is
              something to clear. */}
          {body ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setDraft('');
                save('');
              }}
              className="ml-auto text-[12px] text-ink-400 underline underline-offset-2 transition-colors hover:text-danger"
            >
              Remove the note
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!body) {
    if (!editable) return null;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex w-full items-center gap-1.5 rounded-xl border border-dashed border-line px-3 py-2 text-left text-[12.5px] text-ink-400 transition-colors hover:border-brand-600/40 hover:bg-brand-50/40 hover:text-brand-700"
      >
        <Icon name="plus" size={12} strokeWidth={2.4} />
        Add how this merchant&rsquo;s tickets should be handled
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-brand-600/20 bg-brand-50/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>How to deal with this merchant&rsquo;s tickets</SectionLabel>
        {editable ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-brand-700 transition-colors hover:bg-brand-100"
          >
            <Icon name="pencil" size={11} />
            Edit
          </button>
        ) : null}
      </div>
      {/* `whitespace-pre-wrap` so the line breaks whoever wrote this intended
          survive — a numbered list of steps is the obvious thing to put here
          and it would otherwise collapse into one paragraph. */}
      <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-800">
        {body}
      </p>
      {/* The byline comes from the server row, so it is shown only while that
          row is what is on screen. After our own save it is deliberately
          absent for the moment before the server render lands, rather than
          attributing the new text to whoever wrote the old. */}
      {saved === null && note?.updatedBy ? (
        <p className="mt-1.5 text-[11.5px] text-ink-400">
          Last set by {authorNames[note.updatedBy] ?? 'someone'} &middot; {relative(note.updatedAt, new Date())}
        </p>
      ) : null}
    </div>
  );
}

/** One reply row; tinted when it mentions the viewer, flashed when a link lands on it. */
function CaseReplyRow({ r, mentioned, flash, children }: { r: CaseReply; mentioned: boolean; flash: boolean; children: React.ReactNode }) {
  const flashing = useFlashTarget(targetId.reply(r.id), flash);
  return (
    <div id={targetId.reply(r.id)} className={`-mx-2 flex gap-2 rounded-lg px-2 py-1 transition-shadow ${mentioned ? 'bg-brand-50/50' : ''} ${flashing ? FLASH_CLASS : ''}`}>
      {children}
    </div>
  );
}
