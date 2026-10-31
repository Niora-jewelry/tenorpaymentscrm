'use client';

/**
 * Spec: while a record is partway through a wait, a small icon shows in the
 * drawer header. Clicking it shows which automation is waiting; allowed users
 * can switch it off for this record. Everyone else sees the icon only.
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Waiting } from '@/lib/automations/service';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { switchOffRunAction } from '../admin/automations/actions';

const carriesOn = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function AutomationWaiting({ waiting }: { waiting: Waiting[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const anchor = useRef<HTMLButtonElement>(null);
  if (waiting.length === 0) return null;

  const stop = (runId: string) =>
    start(async () => {
      const r = await switchOffRunAction(runId);
      if (!r.ok) return setError(r.message);
      setError(null);
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="An automation is waiting on this record"
        aria-label="An automation is waiting on this record"
        className="relative grid size-8 shrink-0 place-items-center rounded-lg text-[#8a5a09] transition-colors hover:bg-[#fdf1d8]"
      >
        <Icon name="clock" size={16} />
        <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-[#d9920a]" />
      </button>
      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={300} role="dialog" label="Automations waiting on this record">
        <p className="px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">Waiting on this record</p>
        <ul className="space-y-1">
          {waiting.map((w) => (
            <li key={w.runId} className="rounded-lg bg-canvas px-2.5 py-2">
              <p className="text-[13px] font-semibold text-ink-900">{w.name}</p>
              <p className="text-[12px] text-ink-500">Carries on {carriesOn(w.resumeAt)}</p>
              {w.canSwitchOff ? (
                <div className="mt-1.5">
                  <Button size="sm" onClick={() => stop(w.runId)} loading={pending} loadingLabel="Switching off…">Switch off for this record</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {error ? <p role="alert" className="mt-1.5 px-1 text-[12px] text-danger">{error}</p> : null}
      </MenuSurface>
    </>
  );
}
