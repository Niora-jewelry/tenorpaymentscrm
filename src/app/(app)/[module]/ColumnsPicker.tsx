'use client';

/**
 * "Columns n of m" — each user shows or hides list columns for their own view
 * (UI/UX spec §6), over the admin's "visible by default". Only columns the
 * viewer may see are listed: a permission-hidden field is not a column at all,
 * so it can neither be shown nor named here.
 */
import { useOptimistic, useRef, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { resetColumnVisibilityAction, setColumnVisibilityAction } from './actions';

type Choice = { key: string; label: string; shown: boolean };

export function ColumnsPicker({
  moduleSlug,
  choices,
  onError,
}: {
  moduleSlug: string;
  choices: Choice[];
  onError: (message: string | null) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const [shown, setShown] = useOptimistic(
    choices,
    (cur: Choice[], change: { key: string; shown: boolean } | 'reset') =>
      change === 'reset' ? cur : cur.map((c) => (c.key === change.key ? { ...c, shown: change.shown } : c)),
  );
  const count = shown.filter((c) => c.shown).length;

  const toggle = (c: Choice) =>
    start(async () => {
      setShown({ key: c.key, shown: !c.shown });
      try {
        onError(null);
        await setColumnVisibilityAction(moduleSlug, c.key, !c.shown);
      } catch {
        onError('That column change could not be saved.');
      }
    });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-600 shadow-[0_1px_1px_rgba(8,32,47,.04)] transition-colors hover:border-ink-300 hover:text-ink-900"
      >
        <Icon name="sliders" size={12} />
        Columns
        <span className="tabular font-medium text-ink-400">
          {count} of {shown.length}
        </span>
      </button>
      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={280} role="dialog" label="Columns">
        <p className="px-2 pb-1.5 pt-1 text-[11.5px] text-ink-400">Shown in your list. Only you see these choices.</p>
        <ul className="max-h-[340px] overflow-y-auto">
          {shown.map((c) => (
            <li key={c.key}>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-ink-800 hover:bg-canvas">
                <input
                  type="checkbox"
                  checked={c.shown}
                  onChange={() => toggle(c)}
                  className="size-3.5 accent-[#1d4ed8]"
                />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-1 flex items-center justify-between border-t border-line-faint px-2 pt-1.5">
          <button
            type="button"
            onClick={() =>
              start(async () => {
                try {
                  onError(null);
                  await resetColumnVisibilityAction(moduleSlug);
                } catch {
                  onError('Could not reset your columns.');
                }
              })
            }
            className="rounded px-1.5 py-1 text-[12px] font-semibold text-ink-500 hover:bg-canvas hover:text-ink-900"
          >
            Reset to default
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded px-1.5 py-1 text-[12px] font-semibold text-brand-700 hover:bg-brand-50"
          >
            Done
          </button>
        </div>
      </MenuSurface>
    </>
  );
}
