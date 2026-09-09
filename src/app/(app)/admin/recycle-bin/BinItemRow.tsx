'use client';

/**
 * One non-record row in the Recycle Bin — a file, an update, a reply, a login,
 * a case thread or a case reply.
 *
 * Separate from `BinRow` (which is records) rather than merged with it, because
 * the two do genuinely different things: a record can be PURGED from here and
 * these cannot. Nothing in the build permanently removes a file, an update or a
 * login row, and offering a button that does would be inventing a requirement —
 * Admin §6 lists purge for records only. What these get is restore, and the
 * refusals each one can raise.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Spinner } from '@/proto/ui/kit';
import { Icon, type IconName } from '@/proto/ui/icons';
import { restoreBinItemAction } from './actions';
import type { BinItem, BinKind } from '@/lib/records/recycleBin';

const LABEL: Record<BinKind, string> = {
  file: 'File',
  update: 'Update',
  reply: 'Reply',
  login: 'Login',
  case: 'Case',
  case_reply: 'Case reply',
};

const ICON: Record<BinKind, IconName> = {
  file: 'paperclip',
  update: 'message-square',
  reply: 'reply',
  login: 'key',
  case: 'lifebuoy',
  case_reply: 'reply',
};

export function BinItemRow({ item }: { item: BinItem }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const restore = () => {
    setError(null);
    startTransition(async () => {
      const result = await restoreBinItemAction(item.kind, item.id);
      // Each refusal is already a sentence written for a person — "Restore the
      // case thread first", "That file row already holds 5 files" — so it is
      // shown as it arrives rather than replaced with a generic failure.
      if (!result.ok) setError(result.message);
    });
  };

  return (
    <div className="rounded-lg border border-line-soft bg-white px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-[3px] grid size-6 shrink-0 place-items-center rounded-md bg-canvas text-ink-400">
            <Icon name={ICON[item.kind]} size={12} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-ink-900">{item.title}</div>
            <div className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-400">
              <span>{LABEL[item.kind]}</span>
              {item.recordId ? (
                <>
                  <span aria-hidden>·</span>
                  <Link
                    href={`/records?record=${item.recordId}`}
                    className="text-brand-700 hover:underline"
                  >
                    {item.recordName ?? 'a record'}
                  </Link>
                </>
              ) : null}
              <span aria-hidden>·</span>
              <span>Deleted {item.deletedAt ? new Date(item.deletedAt).toLocaleString() : ''}</span>
            </div>
          </div>
        </div>

        {pending ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-ink-400">
            <Spinner />
            Restoring…
          </span>
        ) : (
          <button
            type="button"
            onClick={restore}
            className="shrink-0 text-[12.5px] font-semibold text-brand-700 transition-colors hover:underline"
          >
            Restore
          </button>
        )}
      </div>

      {error ? (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-[#b02a30]">
          <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
