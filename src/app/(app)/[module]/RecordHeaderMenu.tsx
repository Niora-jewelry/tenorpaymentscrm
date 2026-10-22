'use client';

/**
 * The record's "⋯" menu in the drawer header. Today it holds one thing: Mute
 * this record — stop @mention alerts and emails about it for me. Per
 * person, nobody else affected; mentions sent while muted are not brought
 * back by unmuting (they were never created).
 */
import { useRef, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { muteRecordAction } from './actions';

export function RecordHeaderMenu({ recordId, muted: initial }: { recordId: string; muted: boolean }) {
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const anchor = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    setOpen(false);
    start(async () => {
      const r = await muteRecordAction({ recordId, muted: !muted });
      if (!r.ok) return setError(r.message ?? 'Could not change that.');
      setError(null);
      setMuted(Boolean(r.muted));
    });
  };

  return (
    <>
      {muted ? (
        <span
          title="You won't get @mention alerts or emails about this record."
          className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas px-2 py-[2.5px] text-[11.5px] font-semibold text-ink-500"
        >
          <Icon name="ban" size={11} /> Muted
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-[11.5px] text-danger">
          {error}
        </span>
      ) : null}
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions"
        disabled={pending}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors duration-150 hover:bg-canvas hover:text-ink-900 disabled:opacity-60"
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={260} label="Record actions">
        <button
          type="button"
          role="menuitem"
          onClick={toggle}
          className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-canvas"
        >
          <Icon name={muted ? 'bell' : 'ban'} size={15} className="mt-0.5 shrink-0 text-ink-400" />
          <span>
            <span className="block text-[13px] font-semibold text-ink-900">{muted ? 'Unmute this record' : 'Mute this record'}</span>
            <span className="block text-[11.5px] leading-snug text-ink-400">
              {muted ? 'Get @mention alerts and emails about it again.' : 'No @mention alerts or emails about it, for you only.'}
            </span>
          </span>
        </button>
      </MenuSurface>
    </>
  );
}
