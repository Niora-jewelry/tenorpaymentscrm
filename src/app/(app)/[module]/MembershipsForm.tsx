'use client';

import { useState, useTransition } from 'react';
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
  allowed,
}: {
  moduleSlug: string;
  recordId: string;
  allModules: Module[];
  current: string[];
  /**
   * Modules this viewer may add records to and remove them from — the
   * `membership` permission (migration 9766), resolved on the server. A chip
   * outside this list is drawn but cannot be clicked, with the reason on
   * hover, so the row still shows where the record is.
   */
  allowed: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /*
   * Which modules a record appears in is a real change — archiving is exactly
   * "remove from all of them". The action returns void and throws on refusal,
   * so unguarded a denied toggle left the checkbox looking however the click
   * left it, with `router.refresh()` skipped and nothing said.
   */
  const [error, setError] = useState<string | null>(null);

  const toggle = (targetModuleId: string, on: boolean) => {
    startTransition(async () => {
      try {
        setError(null);
        await toggleMembershipAction(moduleSlug, recordId, targetModuleId, on);
        router.refresh();
      } catch {
        setError('Could not change that membership.');
      }
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">In modules</span>
      {error ? <span role="alert" className="text-[11.5px] text-danger">{error}</span> : null}
      {allModules.map((m) => {
        const on = current.includes(m.id);
        /*
         * A module that shows open cases is an indicator, not a switch: the
         * record is in it exactly while a case is open (migration 9764), and
         * the server ignores any request to change that. Drawn in the same
         * on/off colours so the row still reads as one list, with the reason
         * on hover.
         */
        if (m.showsOpenCases) {
          return (
            <span
              key={m.id}
              title={
                on
                  ? `In ${m.label} automatically — a case is open on this record.`
                  : `${m.label} is automatic — the record appears there while it has an open case.`
              }
              className={`inline-flex cursor-default items-center gap-1 rounded-full border border-dashed px-2.5 py-[3px] text-[11.5px] font-semibold ${
                on ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-300'
              }`}
            >
              {on ? <Icon name="check" size={11} strokeWidth={2.5} /> : null}
              {m.label}
            </span>
          );
        }
        const canToggle = allowed.includes(m.id);
        if (!canToggle) {
          return (
            <span
              key={m.id}
              aria-disabled
              title={`You do not have permission to add records to or remove them from ${m.label}.`}
              className={`inline-flex cursor-not-allowed items-center gap-1 rounded-full border px-2.5 py-[3px] text-[11.5px] font-semibold opacity-70 ${
                on ? 'border-brand-100 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-400'
              }`}
            >
              {on ? <Icon name="check" size={11} strokeWidth={2.5} /> : null}
              {m.label}
              <Icon name="lock" size={10} className="opacity-70" />
            </span>
          );
        }
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
  const [archiveError, setArchiveError] = useState<string | null>(null);

  return (
    <>
    {archiveError ? (
      <span role="alert" className="text-[11.5px] text-danger">
        {archiveError}
      </span>
    ) : null}
    <button
      type="button"
      disabled={pending}
      aria-busy={pending || undefined}
      title="Clear every display membership — stays in the Records List"
      onClick={() =>
        startTransition(async () => {
          try {
            setArchiveError(null);
            await archiveRecordAction(moduleSlug, recordId);
            router.refresh();
          } catch {
            setArchiveError('Could not archive this record.');
          }
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
    </>
  );
}
