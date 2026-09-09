'use client';

/**
 * A soft-deleted user in the Recycle Bin — Admin §6 lists users among the things
 * the bin holds, and §2.1 gives them a third level below it.
 *
 * ── RESTORE BRINGS THEM BACK PAUSED ──────────────────────────────────────
 * Not active. `restore_user` (migration 55) decides that, and this row says so
 * rather than leaving the admin to discover it: restoring an account and
 * re-enabling sign-in are two decisions, and the second one is Resume on the
 * Users screen.
 *
 * ── AND FULL DELETE IS HONEST ABOUT WHICH THING IT DID ───────────────────
 * `purge_user` removes the row outright when nothing references the person, and
 * empties it when their authorship does — fourteen foreign keys carry who wrote
 * what, and that history may not be forged. The confirmation says both
 * possibilities before the click, because "permanently deleted" about a row that
 * still exists is a claim an admin may have to stand behind.
 */
import { useState, useTransition } from 'react';
import { Button, Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { restoreUserAction, purgeUserAction } from '../users/actions';
import type { DeletedUserRow } from '@/lib/records/adminUsers';

export function BinUserRow({ user }: { user: DeletedUserRow }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = user.fullName ?? user.email;

  const restore = () => {
    setError(null);
    startTransition(async () => {
      const result = await restoreUserAction(user.id);
      if (!result.ok) setError(result.message ?? 'Could not restore this user.');
    });
  };

  const purge = () => {
    setError(null);
    startTransition(async () => {
      const result = await purgeUserAction(user.id);
      if (!result.ok) {
        setError(result.message ?? 'Could not permanently delete this user.');
        setConfirming(false);
      }
      // On success the row disappears with the revalidate, so there is nothing
      // to report back into a component that is about to unmount.
    });
  };

  return (
    <div className="rounded-lg border border-line-soft bg-white px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-[3px] grid size-6 shrink-0 place-items-center rounded-md bg-canvas text-ink-400">
            <Icon name="user" size={12} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-ink-900">{name}</div>
            <div className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-400">
              <span>{user.roleName}</span>
              {user.fullName ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">{user.email}</span>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <span>Deleted {user.deletedAt ? new Date(user.deletedAt).toLocaleString() : ''}</span>
            </div>
          </div>
        </div>

        {confirming ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
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
        ) : pending ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-ink-400">
            <Spinner />
            Working…
          </span>
        ) : (
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={restore}
              className="text-[12.5px] font-semibold text-brand-700 transition-colors hover:underline"
            >
              Restore
            </button>
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="text-[12.5px] font-semibold text-[#b02a30] transition-colors hover:underline"
            >
              Delete permanently
            </button>
          </div>
        )}
      </div>

      {confirming ? (
        <p className="mt-2 text-[12px] leading-relaxed text-[#b02a30]">
          This cannot be undone. Anything {name} wrote — notes, files, cases, updates — stays where
          it is and keeps its authorship; the account and their personal details go. If they never
          wrote anything, the account is removed outright.
        </p>
      ) : (
        <p className="mt-1.5 pl-[34px] text-[11.5px] text-ink-400">
          Restoring brings them back paused, not active.
        </p>
      )}

      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-[#b02a30]">
          <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
