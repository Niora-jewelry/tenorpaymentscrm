'use client';

/**
 * One non-record row in the Recycle Bin — a file, an update, a reply, a login,
 * a case thread, a case reply or an automation.
 *
 * Separate from `BinRow` (which is records) rather than merged with it, because
 * the two do genuinely different things. Nothing in the build permanently removes
 * a file, an update or a login row, and offering a button that does would be
 * inventing a requirement. What these get is restore, and the refusals each one
 * can raise. Automations are the exception: the client asked for them to be purged
 * from here too, which `canPurge` decides.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Spinner } from '@/proto/ui/kit';
import { Icon, type IconName } from '@/proto/ui/icons';
import { purgeBinItemAction, restoreBinItemAction } from './actions';
import type { BinItem, BinKind } from '@/lib/records/recycleBin';

const LABEL: Record<BinKind, string> = {
  file: 'File',
  file_row: 'File row',
  update: 'Update',
  reply: 'Reply',
  login: 'Login',
  case: 'Case',
  case_reply: 'Case reply',
  equipment_row: 'Equipment row',
  automation: 'Automation',
  system_automation: 'Hard-coded automation',
};

/** Mirrors `PURGE_FN`: that file is server-only, and the server refuses anything else. */
const canPurge = (kind: BinKind) => kind === 'automation' || kind === 'system_automation';

const ICON: Record<BinKind, IconName> = {
  file: 'paperclip',
  file_row: 'file-text',
  update: 'message-square',
  reply: 'reply',
  login: 'key',
  case: 'lifebuoy',
  case_reply: 'reply',
  equipment_row: 'file-text',
  automation: 'route',
  system_automation: 'cog',
};

export function BinItemRow({ item }: { item: BinItem }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'Restoring…' | 'Purging…'>('Restoring…');
  const [confirming, setConfirming] = useState(false);

  const purge = () => {
    setError(null);
    setBusy('Purging…');
    startTransition(async () => {
      const result = await purgeBinItemAction(item.kind, item.id);
      if (!result.ok) {
        setConfirming(false);
        setError(result.message);
      }
    });
  };

  const restore = () => {
    setError(null);
    setBusy('Restoring…');
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
              <span>{item.label ?? LABEL[item.kind]}</span>
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
            {busy}
          </span>
        ) : confirming ? (
          <span className="flex shrink-0 items-center gap-3">
            <span className="text-[12.5px] font-semibold text-[#b02a30]">Purge permanently?</span>
            <button type="button" onClick={purge} className="text-[12.5px] font-semibold text-[#b02a30] transition-colors hover:underline">
              Yes, purge
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="text-[12.5px] font-semibold text-ink-500 transition-colors hover:text-ink-900">
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-4">
            <button
              type="button"
              onClick={restore}
              className="text-[12.5px] font-semibold text-brand-700 transition-colors hover:underline"
            >
              Restore
            </button>
            {canPurge(item.kind) ? (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="text-[12.5px] font-semibold text-[#b02a30] transition-colors hover:underline"
              >
                Purge permanently
              </button>
            ) : null}
          </span>
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
