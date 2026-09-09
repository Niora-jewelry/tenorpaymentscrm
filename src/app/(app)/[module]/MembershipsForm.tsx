'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { toggleMembershipAction, archiveRecordAction } from './actions';
import type { Module } from '@/lib/records/config';

/** "In modules" — a dynamically generated, individually-clickable chip per
 * display module. Matches the module's own row of chips (`OutlineChip`-style
 * on/off state) rather than a checkbox list gated behind an Update button —
 * each click toggles that one membership immediately. */
export function MembershipsForm({
  moduleSlug,
  recordId,
  allModules,
  current,
}: {
  moduleSlug: string;
  recordId: string;
  allModules: Module[];
  current: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const toggle = (targetModuleId: string, on: boolean) => {
    startTransition(async () => {
      await toggleMembershipAction(moduleSlug, recordId, targetModuleId, on);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">In modules</span>
      {allModules.map((m) => {
        const on = current.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            disabled={pending}
            onClick={() => toggle(m.id, !on)}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-[3px] text-[11.5px] font-semibold transition-colors duration-150 disabled:cursor-wait disabled:opacity-60 ${
              on
                ? 'border-brand-100 bg-brand-50 text-brand-700 hover:bg-brand-100'
                : 'border-line bg-white text-ink-400 hover:border-ink-400 hover:text-ink-700'
            }`}
          >
            {on ? <Icon name="check" size={11} strokeWidth={2.5} /> : null}
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

export function ArchiveButton({ moduleSlug, recordId }: { moduleSlug: string; recordId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending || undefined}
      title="Clear every display membership — stays in the Records List"
      onClick={() =>
        startTransition(async () => {
          await archiveRecordAction(moduleSlug, recordId);
          router.refresh();
        })
      }
      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-500 transition-colors duration-150 hover:border-warn/40 hover:bg-warn-bg hover:text-warn disabled:cursor-wait disabled:opacity-60"
    >
      {/* Archiving removes the record from every display module and then
          refreshes the route, so it is one of the slower actions in the drawer
          and it sits in the header where nothing else moves. Dimming alone left
          it ambiguous; the label says what is happening. */}
      {pending ? <Spinner /> : <Icon name="archive" size={13} />}
      {pending ? 'Archiving…' : 'Archive'}
    </button>
  );
}
