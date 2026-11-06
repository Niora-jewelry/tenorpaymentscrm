'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, Dialog, Spinner } from '@/proto/ui/kit';
import { toggleMembershipAction, deleteRecordAction } from './actions';
import type { Module } from '@/lib/records/config';

/** "In modules" — a dynamically generated, individually-clickable chip per
 * display module. Matches the module's own row of chips (`OutlineChip`-style
 * on/off state) rather than a checkbox list gated behind an Update button —
 * each click toggles that one membership immediately.
 *
 * Laid out like the pipeline card beside it: a header line, the chips under it
 * (client, 6 Nov 2026). There is no Archive button any more: taking a record
 * out of the last module it shows in IS archiving it, so that one click asks
 * first and says so. */
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
  /** The module whose removal would archive the record, awaiting a yes. */
  const [lastOff, setLastOff] = useState<Module | null>(null);

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

  /*
   * The record leaves every display module when this chip is its only one. An
   * open case keeps it in a case-driven module, which counts as staying.
   */
  const shownIn = allModules.filter((m) => current.includes(m.id));
  const wouldArchive = (m: Module) => shownIn.length === 1 && shownIn[0]!.id === m.id;

  const click = (m: Module, on: boolean) => {
    if (on && wouldArchive(m)) return setLastOff(m);
    toggle(m.id, !on);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="layout-list" size={13} className="text-ink-400" />
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-500">In modules</span>
        <span className="inline-flex items-center rounded-full bg-canvas px-1.5 py-[1px] text-[11px] tabular text-ink-400 ring-1 ring-inset ring-line">
          {shownIn.length} of {allModules.length}
        </span>
        {pending ? <Spinner /> : null}
        {error ? (
          <span role="alert" className="ml-auto text-[11.5px] text-danger">
            {error}
          </span>
        ) : null}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
              aria-pressed={on}
              title={
                on
                  ? wouldArchive(m)
                    ? `Remove from ${m.label}. It is the last module, so the record is archived.`
                    : `Remove from ${m.label}`
                  : `Add to ${m.label}`
              }
              onClick={() => click(m, on)}
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

      {lastOff ? (
        <Dialog
          title={`Remove from ${lastOff.label}?`}
          confirmLabel="Remove and archive"
          confirmIcon="archive"
          onConfirm={() => toggle(lastOff.id, false)}
          onClose={() => setLastOff(null)}
        >
          <p>
            {lastOff.label} is the last module this record shows in, so removing it archives the record. It leaves every
            display module and stays in the Records List with everything intact.
          </p>
          <p className="text-ink-400">Add it to a module again at any time to bring it back.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * Records List only: Delete, which sends an archived record to the Recycle
 * Bin (client, 6 Nov 2026: it replaces the Archive button there). The
 * database refuses anything still shown in a module, so the button says that
 * up front instead of failing after a confirm.
 */
export function DeleteRecordButton({ recordId, archived, name }: { recordId: string; archived: boolean; name: string }) {
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () =>
    startTransition(async () => {
      setError(null);
      // Redirects to the Records List on success; returns only on a refusal.
      const r = await deleteRecordAction(recordId);
      if (r && !r.ok) setError(r.message ?? 'Could not delete this record.');
    });

  return (
    <>
      {error ? (
        <span role="alert" className="text-[11.5px] text-danger">
          {error}
        </span>
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        icon="trash"
        loading={pending}
        loadingLabel="Deleting…"
        disabled={!archived}
        title={
          archived
            ? 'Move this record to the Recycle Bin'
            : 'Remove it from every module first: only an archived record can be deleted.'
        }
        onClick={() => setAsking(true)}
      >
        Delete
      </Button>
      {asking ? (
        <Dialog
          title={`Delete ${name || 'this record'}?`}
          tone="danger"
          confirmLabel="Delete to Recycle Bin"
          confirmIcon="trash"
          onConfirm={run}
          onClose={() => setAsking(false)}
        >
          <p>It moves to the Recycle Bin. An admin can restore it from there.</p>
        </Dialog>
      ) : null}
    </>
  );
}
