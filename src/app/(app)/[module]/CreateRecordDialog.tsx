'use client';

/**
 * "+ New" — a real modal, not an inline text box next to a button. Same
 * chrome as `RecordsTable.tsx`'s bulk-edit dialog and `src/proto/ui/kit.tsx`'s
 * `Dialog` (overlay, panel, animation classes) — matching the rest of the
 * app rather than a one-off styled `<input>`+`<button>` pair.
 *
 * Not built on `kit.tsx`'s generic `Dialog` directly: that component closes
 * itself the instant Confirm is clicked, with no way to keep it open on a
 * server-side failure (e.g. the duplicate-Deal-Name refusal) — the same
 * reason `BulkEditDialog` in `RecordsTable.tsx` is hand-built instead of
 * using it. This follows that same, already-established pattern.
 */
import { useActionState, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/proto/ui/kit';
import { PersonAvatar, resolvePerson, usePeopleById } from '@/proto/ui/people';
import { Icon } from '@/proto/ui/icons';
import type { AssignableTeam } from '@/lib/teams/types';
import { createRecordAction, type ActionState } from './actions';

const initial: ActionState = { ok: false };

/** A pick that is a team, not one of its people. */
const WHOLE_TEAM = 'team';

export function CreateRecordDialog({
  moduleSlug,
  moduleLabel,
  viewerId,
  assignable,
}: {
  moduleSlug: string;
  moduleLabel: string;
  /** The creator, who is on the new record's team whether this dialog says so
   * or not — `createRecord` puts them there unconditionally, because the
   * trigger that grants visibility runs after the insert and the creator has to
   * be able to read the row it just wrote. Shown, pinned and not removable, so
   * the list on screen is the list that will exist. */
  viewerId: string;
  /** What this viewer may assign: the same list as the drawer's picker. */
  assignable: AssignableTeam[];
}) {
  const [open, setOpen] = useState(false);
  /*
   * `isPending` — the third element of `useActionState`, which this dialog was
   * discarding.
   *
   * Creating a record is a server round trip that ends in a `redirect` into
   * the new record's drawer, so on the live database the dialog sat there
   * completely unchanged for a second or more after Create was clicked. There
   * was no spinner, no disabled button, nothing — and the obvious response to a
   * button that appears not to have worked is to click it again. The action is
   * not idempotent, so a second submit is a second record, blocked only by the
   * unique Deal Name constraint happening to catch it.
   */
  const [state, action, isPending] = useActionState(createRecordAction.bind(null, moduleSlug), initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const byId = usePeopleById();
  /** Per team: the whole team, or one person from it. Never both, never two. */
  const [picks, setPicks] = useState<Record<string, string>>({});

  const you = resolvePerson(viewerId, byId);
  // The creator takes their own team, so it has nothing left to offer here.
  const teams = assignable.filter((t) => !t.own);

  const choose = (teamId: string, pick: string) =>
    setPicks((prev) => {
      const next = { ...prev };
      if (next[teamId] === pick) delete next[teamId];
      else next[teamId] = pick;
      return next;
    });

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /*
   * Close once the new record's drawer has actually opened.
   *
   * `createRecordAction` ends in `redirect('/{slug}?record=…')`, which is a
   * client-side navigation WITHIN the same route segment — so this component
   * never unmounts and `open` stayed true. The new record's drawer opened
   * UNDERNEATH the still-open dialog (`z-[80]` here vs the sheet's `z-[70]`),
   * with the typed Deal Name still sitting in the form. It reads as a submit
   * that did nothing, and clicking Create again tries to make a second record
   * with the same name.
   *
   * Watching `state.ok` would not work: the action never RETURNS on success,
   * because `redirect()` throws to perform the navigation, so `useActionState`
   * keeps whatever state it had — including a stale error message from an
   * earlier failed attempt. The `record` search param changing is the only
   * signal that is actually true of a success and only a success.
   *
   * The snapshot taken at submit time is what makes it specific: it closes on
   * the navigation THIS dialog caused, not merely because some record is open
   * (a user can open this dialog from behind an already-open drawer).
   */
  const recordParam = useSearchParams().get('record');
  const paramAtSubmit = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (paramAtSubmit.current === null) return;
    if (recordParam && recordParam !== paramAtSubmit.current) {
      paramAtSubmit.current = null;
      setOpen(false);
      setPicks({});
    }
  }, [open, recordParam]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPending) setOpen(false);
    };
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, isPending]);

  return (
    <>
      <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
        New record
      </Button>

      {open ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          {/* Closing mid-flight would leave the create running with nothing on
              screen to show for it, and then redirect the user into a drawer
              they did not appear to ask for. The dialog stays put until the
              action settles. Same reason Escape is ignored while pending. */}
          <div
            className="absolute inset-0 animate-fade-in bg-brand-950/35"
            onClick={() => { if (!isPending) setOpen(false); }}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-[440px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700">
                <Icon name="plus" size={16} strokeWidth={2} />
              </span>
              <div>
                <h2 className="text-[16px] font-semibold text-ink-900">New record</h2>
                <p className="mt-0.5 text-[12.5px] text-ink-400">
                  Creates a record and adds it to {moduleLabel}.
                </p>
              </div>
            </div>

            {/* The snapshot the effect above compares against. Recorded on
                submit, so a navigation that this submit did not cause cannot
                close the dialog. A sentinel string covers the case where no
                drawer was open, since `null` means "not submitted yet". */}
            <form
              action={action}
              onSubmit={() => { paramAtSubmit.current = recordParam ?? ''; }}
              className="mt-4"
            >
              <label className="block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
                Deal Name
              </label>
              <input
                ref={inputRef}
                name="dealName"
                required
                disabled={isPending}
                placeholder="e.g. Joe's Pizza"
                className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
              />
              {state.message ? (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-bad">
                  <Icon name="alert-triangle" size={12} />
                  <span>{state.message}</span>
                  {/* Named and linked only when this user may be told which
                      record is blocking (Modules Amendment 2). When they may
                      not, the message above already says to contact an
                      administrator and there is deliberately nothing to open. */}
                  {state.blockedBy ? (
                    <Link
                      href={`/${moduleSlug}?record=${state.blockedBy.id}`}
                      className="font-semibold underline underline-offset-2 hover:no-underline"
                    >
                      Open it
                    </Link>
                  ) : null}
                </p>
              ) : (
                <p className="mt-1.5 text-[11.5px] text-ink-400">
                  Must be unique — case-insensitive, ignoring extra spaces.
                </p>
              )}

              {/* Who works the record, at creation. Team member(s) assigned is the
                  one thing that decides who can see a record, so the dialog says
                  so. The picker is the drawer's: only what this viewer may
                  assign is here, and one person per team. */}
              <label className="mt-4 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
                Assign
              </label>
              <p className="mt-1 text-[11.5px] text-ink-400">
                You are always added. A team stays open until someone on it takes the record.
              </p>

              <div className="mt-2 max-h-[220px] space-y-px overflow-y-auto rounded-md border border-line p-1">
                <div className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink-500">
                  <PersonAvatar person={you} size={20} />
                  <span className="truncate font-medium text-ink-700">{you.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-ink-400">you — always added</span>
                </div>

                {teams.map((t) => {
                  const pick = picks[t.id];
                  return (
                    <div key={t.id}>
                      <label
                        className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] transition-colors ${
                          pick === WHOLE_TEAM ? 'bg-brand-50' : 'hover:bg-canvas'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={pick === WHOLE_TEAM}
                          disabled={isPending}
                          onChange={() => choose(t.id, WHOLE_TEAM)}
                          className="size-3.5 accent-[#1d4ed8]"
                        />
                        <Icon name="users" size={14} className="text-ink-400" />
                        <span className="truncate font-medium text-ink-900">{t.label}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-ink-400">whole team</span>
                      </label>
                      {t.members.map((id) => {
                        const p = resolvePerson(id, byId);
                        return (
                          <label
                            key={id}
                            className={`flex cursor-pointer items-center gap-2 rounded py-1 pl-6 pr-2 text-[13px] transition-colors ${
                              pick === id ? 'bg-brand-50' : 'hover:bg-canvas'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={pick === id}
                              disabled={isPending}
                              onChange={() => choose(t.id, id)}
                              className="size-3.5 accent-[#1d4ed8]"
                            />
                            <PersonAvatar person={p} size={20} />
                            <span className="truncate text-ink-800">{p.name}</span>
                            {/* Two colleagues can share a display name, or have none
                                at all — the address is what makes the choice
                                unambiguous, and getting it wrong here hands the wrong
                                person a record. */}
                            {p.email && p.email !== p.name ? (
                              <span className="ml-auto shrink-0 truncate text-[11px] text-ink-400">{p.email}</span>
                            ) : null}
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              {Object.entries(picks).map(([teamId, pick]) =>
                pick === WHOLE_TEAM ? (
                  <input key={teamId} type="hidden" name="teamIds" value={teamId} />
                ) : (
                  <input key={teamId} type="hidden" name="memberIds" value={pick} />
                ),
              )}

              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={isPending} onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" icon="check" loading={isPending} loadingLabel="Creating…">
                  Create
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
