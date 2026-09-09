'use client';

/**
 * Removing a user — Admin Plan §2.1's second and third levels.
 *
 * ── WHAT THE CLIENT ASKED FOR ────────────────────────────────────────────
 * "Remove users — three levels: Pause … Soft delete — the user moves to the
 * Recycle Bin and is restorable … Full delete — permanent removal.
 *
 *  Forced reassignment: before a soft or full delete can proceed, the admin must
 *  complete a reassignment flow covering every record on which the departing
 *  user is the Team member (a bulk 'reassign all of X's records to …' action). A
 *  delete is blocked until reassignment is complete."
 *
 * Pause already existed on the row beside this. This is the rest.
 *
 * ── WHY THE REASSIGNMENT IS A STEP AND NOT A WARNING ─────────────────────
 * Team member is the ONLY field that grants record visibility (Admin §2.3), so
 * removing the last one on a record makes it invisible to every non-admin in
 * the company — with no error, because an empty team is a legal state. The
 * database refuses the delete outright while any record is still held
 * (migration 55); this dialog is that refusal made legible, so the admin is
 * never in a position to press a button that cannot work.
 *
 * ── WHY THE COUNT IS FETCHED WHEN THE DIALOG OPENS ───────────────────────
 * It is the input to a destructive decision. Carrying it on the page render
 * would let an admin act on a number that was true when the tab was opened.
 * `soft_delete_user` re-counts at write time regardless, so a stale count here
 * could only mislead — never corrupt.
 *
 * ── WHY FULL DELETE REPORTS WHICH THING IT DID ───────────────────────────
 * `purge_user` removes the row when nothing references the person, and empties
 * it when their authorship does. Those are different outcomes and the screen
 * says which one happened, because "permanently deleted" about a row that still
 * exists is a claim an admin may have to stand behind.
 */
import { useEffect, useState, useTransition } from 'react';
import { Button, Dialog, Spinner, StatusPill } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import {
  userRecordCountAction,
  reassignUserRecordsAction,
  softDeleteUserAction,
  purgeUserAction,
} from './actions';
import type { AdminUserRow } from '@/lib/records/adminUsers';

export function OffboardDialog({
  user,
  candidates,
  /** True on the Recycle Bin's copy of this dialog, where the person is already
   *  soft-deleted and the only remaining step is the permanent one. */
  purgeOnly = false,
  onClose,
}: {
  user: { id: string; email: string; fullName: string | null };
  /** Who the records may be moved to — active, non-deleted people other than
   *  this one. The database checks this too (`reassign_user_records` refuses a
   *  target that is not an active user), so this list is convenience, not the
   *  rule. */
  candidates: Pick<AdminUserRow, 'id' | 'email' | 'fullName'>[];
  purgeOnly?: boolean;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [count, setCount] = useState<number | null>(null);
  const [target, setTarget] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const name = user.fullName ?? user.email;

  // One read when the dialog opens. `useEffect` rather than a prop: this is a
  // fetch triggered by the dialog existing, which is exactly what an effect is
  // for, and the value must not be older than the dialog.
  useEffect(() => {
    let cancelled = false;
    userRecordCountAction(user.id)
      .then((n) => {
        if (!cancelled) setCount(n);
      })
      .catch(() => {
        if (!cancelled) setMessage('Could not check how many records this person holds.');
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const reassign = () => {
    setMessage(null);
    setNote(null);
    startTransition(async () => {
      const result = await reassignUserRecordsAction(user.id, target);
      if (!result.ok) {
        setMessage(result.message ?? 'Could not reassign those records.');
        return;
      }
      setNote(
        `${result.moved ?? 0} record${result.moved === 1 ? '' : 's'} moved. Nothing is assigned to ${name} any more.`,
      );
      setTarget('');
      setCount(await userRecordCountAction(user.id));
    });
  };

  const softDelete = () => {
    setMessage(null);
    setNote(null);
    startTransition(async () => {
      const result = await softDeleteUserAction(user.id);
      if (!result.ok) {
        setMessage(result.message ?? 'Could not delete this user.');
        // The block is re-checked server-side, so a refusal means the count on
        // screen was stale. Re-read it rather than leave a number that says the
        // delete should have worked.
        setCount(await userRecordCountAction(user.id));
        return;
      }
      onClose();
    });
  };

  const purge = () => {
    setMessage(null);
    setNote(null);
    startTransition(async () => {
      const result = await purgeUserAction(user.id);
      if (!result.ok) {
        setMessage(result.message ?? 'Could not permanently delete this user.');
        setConfirmingDelete(false);
        return;
      }
      onClose();
    });
  };

  const blocked = count === null || count > 0;

  return (
    <Dialog
      title={purgeOnly ? `Permanently delete ${name}` : `Remove ${name}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        {/* Step 1 — reassignment */}
        <section>
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink-900">
            <Step n={1} done={count === 0} />
            Reassign their records
          </h3>

          {count === null ? (
            <p className="mt-1.5 flex items-center gap-2 pl-7 text-[12.5px] text-ink-400">
              <Spinner />
              Checking what they hold…
            </p>
          ) : count === 0 ? (
            <p className="mt-1.5 pl-7 text-[12.5px] text-ink-500">
              Nothing is assigned to {name}. There is nothing to move.
            </p>
          ) : (
            <div className="mt-1.5 space-y-2 pl-7">
              <p className="text-[12.5px] leading-relaxed text-ink-600">
                {name} is the Team member on <strong>{count}</strong> record
                {count === 1 ? '' : 's'}. Team member is the only thing that decides who can see a
                record, so these have to be handed to someone before the account can go.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Reassign records to"
                  value={target}
                  disabled={pending}
                  onChange={(e) => setTarget(e.target.value)}
                  className="min-w-[220px] rounded-lg border border-line bg-white px-2 py-1.5 text-[12.5px] text-ink-700 outline-none focus:ring-2 focus:ring-brand-100"
                >
                  <option value="">Reassign all to…</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.fullName ?? c.email}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="primary"
                  icon="shuffle"
                  disabled={!target}
                  loading={pending}
                  loadingLabel="Moving…"
                  onClick={reassign}
                >
                  Reassign {count}
                </Button>
              </div>
            </div>
          )}
        </section>

        {/* Step 2 — the delete itself */}
        <section className="border-t border-line-soft pt-3.5">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink-900">
            <Step n={2} done={false} />
            {purgeOnly ? 'Delete permanently' : 'Delete the account'}
          </h3>

          <div className="mt-1.5 space-y-2.5 pl-7">
            {blocked ? (
              <p className="text-[12.5px] text-ink-400">
                Available once their records have been reassigned.
              </p>
            ) : purgeOnly ? (
              <>
                <p className="text-[12.5px] leading-relaxed text-ink-600">
                  This cannot be undone. Anything {name} wrote — notes, files, cases, updates —
                  stays where it is and keeps its authorship; what goes is the person. If they never
                  wrote anything, the account is removed outright.
                </p>
                {confirmingDelete ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-[#b02a30]">
                      Permanently delete {name}?
                    </span>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmingDelete(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon="trash"
                      loading={pending}
                      loadingLabel="Deleting…"
                      onClick={purge}
                    >
                      Yes, delete permanently
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="danger" icon="trash" onClick={() => setConfirmingDelete(true)}>
                    Delete permanently
                  </Button>
                )}
              </>
            ) : (
              <>
                <p className="text-[12.5px] leading-relaxed text-ink-600">
                  {name} moves to the Recycle Bin. Every session ends immediately and they cannot
                  sign in. An admin can restore them from there — restored accounts come back
                  paused, not active.
                </p>
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  loading={pending}
                  loadingLabel="Deleting…"
                  onClick={softDelete}
                >
                  Move to the Recycle Bin
                </Button>
              </>
            )}
          </div>
        </section>

        {note ? (
          <p className="flex items-start gap-1.5 text-[12px] font-semibold text-[#1c7a4f]">
            <Icon name="check" size={12} className="mt-[2px] shrink-0" />
            {note}
          </p>
        ) : null}
        {message ? (
          <p className="flex items-start gap-1.5 text-[12px] text-[#b02a30]">
            <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
            {message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function Step({ n, done }: { n: number; done: boolean }) {
  return done ? (
    <StatusPill label={`${n}`} swatch="teal" dot={false} />
  ) : (
    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-canvas text-[11px] font-semibold text-ink-500 ring-1 ring-inset ring-line">
      {n}
    </span>
  );
}
