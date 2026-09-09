'use client';

/**
 * One row in the Recycle Bin, with the two things the server-rendered version
 * was missing.
 *
 * ── 1. PURGE HAD NO CONFIRMATION ─────────────────────────────────────────
 * It was a bare `<form action={purgeAction.bind(null, r.id)}>` with a submit
 * button: one click, permanently gone, no dialog. Deleting a record TO the bin
 * does have a confirmation (`RecordsTable`'s bulk dialog) — so the reversible
 * step was guarded and the irreversible one was not, which is exactly backwards.
 *
 * The confirmation is inline rather than a modal: this is a list of rows, and a
 * modal would have to restate which record it is about, which is the sentence
 * an inline confirm does not need.
 *
 * ── 2. NEITHER ACTION SHOWED IT WAS WORKING ──────────────────────────────
 * Both are server round trips followed by a revalidate. On the live remote
 * database that is a visible pause with nothing on screen changing, and the
 * natural response to an unresponsive Purge is to click it again.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Button, Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { restoreAction, purgeAction } from './actions';

export function BinRow({
  id,
  dealName,
  deletedAt,
}: {
  id: string;
  dealName: string;
  deletedAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [blocker, setBlocker] = useState<{ id: string; dealName: string } | null>(null);

  const run = (fn: () => Promise<void>, what: string) => {
    setError(null);
    setBlocker(null);
    startTransition(async () => {
      try {
        await fn();
      } catch {
        // Purge can genuinely fail — a record whose notifications still
        // reference it, for one — and a silent failure on an irreversible
        // action is the worst possible combination.
        setError(`Could not ${what} this record. Nothing was changed.`);
        setConfirming(false);
      }
    });
  };

  /**
   * Restore is separate from `run` because it has a refusal that is not an
   * exception: a Deal Name taken while this record sat in the bin. The client
   * asks for "a clear, linked error message" there (Overview §3.5), so the
   * blocking record is shown by name and linked when the viewer may see it.
   */
  const restore = () => {
    setError(null);
    setBlocker(null);
    startTransition(async () => {
      try {
        const result = await restoreAction(id);
        if (!result.ok) {
          setError(result.message);
          setBlocker(result.record);
        }
      } catch {
        setError('Could not restore this record. Nothing was changed.');
      }
    });
  };

  return (
    <div className="rounded-lg border border-line-soft bg-white px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-ink-900">{dealName}</div>
          <div className="text-[11.5px] text-ink-400">
            Deleted {deletedAt ? new Date(deletedAt).toLocaleString() : ''}
          </div>
        </div>

        {confirming ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[12.5px] font-semibold text-[#b02a30]">Purge permanently?</span>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="trash"
              loading={pending}
              loadingLabel="Purging…"
              onClick={() => run(() => purgeAction(id), 'purge')}
            >
              Yes, purge
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-3">
            {pending ? (
              <span className="flex items-center gap-1.5 text-[12.5px] text-ink-400">
                <Spinner />
                Restoring…
              </span>
            ) : (
              <>
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
                  Purge permanently
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {error ? (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-[#b02a30]">
          <Icon name="alert-triangle" size={12} />
          <span>{error}</span>
          {/* The link half of "a clear, linked error message". Absent when the
              viewer may not be told which record is blocking, which is the
              disclosure gate rather than an oversight. */}
          {blocker ? (
            <Link
              href={`/records?record=${blocker.id}`}
              className="font-semibold underline underline-offset-2 hover:no-underline"
            >
              Open {blocker.dealName}
            </Link>
          ) : null}
          <span className="text-ink-400">Rename it, then restore this one.</span>
        </p>
      ) : null}
    </div>
  );
}
