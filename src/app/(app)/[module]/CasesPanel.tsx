'use client';

/**
 * Cases — ported from `src/proto/ui/tabs.tsx`'s `CasesTab`/`CaseCard`.
 * Manager-gated actions (write solution, close/reopen) are enforced
 * server-side inside `set_case_solution()`/`toggle_case_state()` (migration
 * 30) — `isManager` here only decides what to show, same as the prototype.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useActionState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, CaseStatePill, EmptyState, SectionLabel, SpecNote } from '@/proto/ui/kit';
import { relative } from '@/proto/ui/tokens';
import { UserAvatar } from './UserAvatar';
import { createCaseAction, addCaseReplyAction, setCaseStateAction, setCaseSolutionAction, type ActionState } from './actions';
import type { CaseThread, CaseReply } from '@/lib/records/cases';
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
}: {
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
}: {
  moduleSlug: string;
  c: CaseThread;
  replies: CaseReply[];
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
  const [expanded, setExpanded] = useState(c.state === 'open');
  const [writing, setWriting] = useState(false);
  const [solutionDraft, setSolutionDraft] = useState('');
  const [replyDraft, setReplyDraft] = useState('');
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

  return (
    <li className="overflow-hidden rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full flex-wrap items-center gap-2 border-b border-line-soft bg-canvas px-4 py-2.5 text-left transition-colors hover:bg-[#eef3f7]"
      >
        <Icon name="chevron-down" size={13} className={`text-ink-400 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`} />
        <span className="font-mono text-[12.5px] font-semibold text-ink-500 tabular">#{c.number}</span>
        <span className="text-[13.5px] font-semibold text-ink-900">{c.title}</span>
        <span className="ml-auto flex items-center gap-2">
          {replies.length ? (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-400">
              <Icon name="message-square" size={11} />
              {replies.length}
            </span>
          ) : null}
          <CaseStatePill state={c.state} />
        </span>
      </button>

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
                      <div key={r.id} className="flex gap-2">
                        <UserAvatar userId={r.authorId} name={name} size={20} />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] leading-relaxed text-ink-700">{r.body}</p>
                          <p className="text-[11px] text-ink-400">
                            {name} · {relative(r.createdAt, now)} · not editable
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
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1 text-[12.5px] text-ink-400">No replies yet.</p>
              )}

              {editable ? (
              <div className="mt-2 flex gap-2">
                <input
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendReply()}
                  disabled={pending}
                  placeholder={c.state === 'open' ? 'Reply to this case…' : 'Reply — the case is closed'}
                  className="flex-1 rounded-md border border-line px-2.5 py-1.5 text-[13px] outline-none transition-colors focus-field"
                />
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
