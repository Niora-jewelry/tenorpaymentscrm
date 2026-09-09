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
import { PersonAvatar, resolvePerson, usePeople, usePeopleById } from '@/proto/ui/people';
import { Icon } from '@/proto/ui/icons';
import { createRecordAction, type ActionState } from './actions';

const initial: ActionState = { ok: false };

export function CreateRecordDialog({
  moduleSlug,
  moduleLabel,
  viewerId,
}: {
  moduleSlug: string;
  moduleLabel: string;
  /** The creator, who is on the new record's team whether this dialog says so
   * or not — `createRecord` puts them there unconditionally, because the
   * trigger that grants visibility runs after the insert and the creator has to
   * be able to read the row it just wrote. Shown, pinned and not removable, so
   * the list on screen is the list that will exist. */
  viewerId: string;
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
  const people = usePeople();
  const byId = usePeopleById();
  const [members, setMembers] = useState<string[]>([]);

  const you = resolvePerson(viewerId, byId);
  const others = people.filter((p) => p.id !== viewerId && !p.suspended);

  const toggle = (id: string) =>
    setMembers((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

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
      setMembers([]);
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
            className="absolute inset-0 animate-fade-in bg-brand-950/35 backdrop-blur-[2px]"
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

              {/* The team, at creation. This is not a convenience field: it is
                  the ONLY thing that decides who can see the record, so the
                  dialog states that rather than leaving it to be discovered in
                  the drawer afterwards. */}
              <label className="mt-4 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
                Team members
              </label>
              <p className="mt-1 text-[11.5px] text-ink-400">
                Only these people can see the record. Everyone else — apart from admins — will not
                find it at all.
              </p>

              <div className="mt-2 max-h-[190px] space-y-px overflow-y-auto rounded-md border border-line p-1">
                <div className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink-500">
                  <PersonAvatar person={you} size={20} />
                  <span className="truncate font-medium text-ink-700">{you.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-ink-400">you — always added</span>
                </div>

                {others.map((p) => {
                  const on = members.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] transition-colors ${
                        on ? 'bg-brand-50' : 'hover:bg-canvas'
                      }`}
                    >
                      <input
                        type="checkbox"
                        name="memberIds"
                        value={p.id}
                        checked={on}
                        disabled={isPending}
                        onChange={() => toggle(p.id)}
                        className="size-3.5 accent-[#1d4ed8]"
                      />
                      <PersonAvatar person={{ ...p, unknown: false }} size={20} />
                      <span className="truncate font-medium text-ink-900">{p.name}</span>
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

                {others.length === 0 ? (
                  <p className="px-2 py-1.5 text-[12px] text-ink-400">
                    Nobody else has an active account yet.
                  </p>
                ) : null}
              </div>

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
