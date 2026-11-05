'use client';

/**
 * Admin → Presets, sub-step 5: pipelines and their steps.
 *
 * Three things drive the shape of this screen, all from `adminPipelines.ts`,
 * which is worth reading first:
 *
 *   1. **A pipeline belongs to one module, permanently.** So the module is
 *      chosen once, at creation, and shown as a fact afterwards — there is no
 *      control to move one, because records already assigned are filed under
 *      that module and would be stranded by the move.
 *   2. **A step is removed with its records moved first** (client, 4 Nov
 *      2026). Records stand on a step by id, so Remove asks where they go and
 *      the database moves and logs each one before the step goes. A pipeline
 *      itself still cannot be deleted: that would cascade its assignments away.
 *   3. **A step's id never moves, so renaming is free.** Unlike a choice, a
 *      step has no key to derive from its label; records point at the id. That
 *      is worth saying on screen, because "will renaming break the records
 *      already on this step" is the first question an admin has.
 */

import { useActionState, useMemo, useState, useTransition } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, OutlineChip, StatusPill } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { SWATCHES } from '@/lib/records/adminSchemas';
import {
  createPipelineAction,
  renamePipelineAction,
  setPipelineStepsAction,
  setPipelineOrderAction,
  removePipelineStepAction,
  type PresetFormState,
} from './actions';
import type { AdminPipelineRow, AdminStepRow } from '@/lib/records/adminPipelines';
import type { ModuleOption } from '@/lib/records/adminPresets';
import type { Swatch } from '@/proto/schema';

/** One editable step. `id` is empty for a step that has never been saved — the
 * database assigns it and hands it back, and the draft adopts it there. */
type Row = { id: string; label: string; swatch: string };

const toRow = (s: AdminStepRow): Row => ({ id: s.id, label: s.label, swatch: s.swatch });

const sameRows = (a: Row[], b: Row[]) =>
  a.length === b.length && a.every((r, i) => r.id === b[i]!.id && r.label === b[i]!.label && r.swatch === b[i]!.swatch);

/** New steps cycle through the palette rather than all defaulting to one
 * colour — a pipeline whose chips are all grey reads as unfinished, and the
 * twelve are already contrast-checked (`proto/ui/tokens.ts`). */
const nextSwatch = (index: number): string => SWATCHES[index % SWATCHES.length]!;

export function PipelinesSection({ pipelines, modules }: { pipelines: AdminPipelineRow[]; modules: ModuleOption[] }) {
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);

  const groups = modules.map((m) => ({ module: m, list: pipelines.filter((p) => p.moduleId === m.id) }));

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(14,28,52,.05)]">
      <div className="flex items-start justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink-900">
            Pipelines <span className="ml-1 font-normal text-ink-400">({pipelines.length})</span>
          </h2>
          <p className="mt-0.5 text-[12.5px] text-ink-400">
            The step bar at the top of a record&apos;s drawer. Each pipeline belongs to one module permanently, and a
            record&apos;s position in one module&apos;s pipeline is independent of every other module&apos;s.
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          onClick={() => {
            setOpenCount((c) => c + 1);
            setOpen(true);
          }}
        >
          New pipeline
        </Button>
      </div>

      <div className="divide-y divide-line-faint">
        {groups.map(({ module, list }) => (
          <div key={module.id} className="px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-semibold uppercase tracking-wide text-brand-700">{module.label}</span>
              {module.frozen ? <OutlineChip tone="danger">Frozen — check before changing</OutlineChip> : null}
              {list.length > 1 ? <OutlineChip>{list.length} pipelines</OutlineChip> : null}
            </div>

            {list.length === 0 ? (
              <p className="mt-1.5 text-[12.5px] text-ink-400">
                No pipeline — records in this module show no step bar.
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {list.map((p, i) => (
                  <PipelineCard
                    key={p.id}
                    pipeline={p}
                    moduleLabel={module.label}
                    siblings={list}
                    index={i}
                    reorderable={list.length > 1}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {open ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            className="relative max-h-[88vh] w-full max-w-[520px] animate-dialog-in overflow-y-auto rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(14,28,52,.4)]"
          >
            <h2 className="text-[16px] font-semibold text-ink-900">New pipeline</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-400">
              A pipeline stays on the module you pick here — records assigned to it are filed under that module, so it
              can never be moved later. It needs at least one step: assigning a record puts it on the first one.
            </p>
            <CreatePipelineForm key={openCount} modules={modules} onClose={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* One pipeline: rename, and its step list                                    */
/* -------------------------------------------------------------------------- */

function PipelineCard({
  pipeline,
  moduleLabel,
  siblings,
  index,
  reorderable,
}: {
  pipeline: AdminPipelineRow;
  moduleLabel: string;
  siblings: AdminPipelineRow[];
  index: number;
  reorderable: boolean;
}) {
  const [label, setLabel] = useState(pipeline.label);
  const [savedLabel, setSavedLabel] = useState(pipeline.label);
  const [rows, setRows] = useState<Row[]>(pipeline.steps.map(toRow));
  const [savedRows, setSavedRows] = useState<Row[]>(pipeline.steps.map(toRow));
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<string | false>(false);
  const [pending, startTransition] = useTransition();
  const [counts, setCounts] = useState<Record<string, number>>(() => Object.fromEntries(pipeline.steps.map((s) => [s.id, s.records ?? 0])));
  const [removing, setRemoving] = useState<Row | null>(null);

  const labelDirty = label.trim() !== savedLabel;
  const stepsDirty = !sameRows(rows, savedRows);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** A brand-new step has no id yet, so it borrows its index — safe because the
   * whole list is re-keyed from the server the moment it is saved. */
  const idFor = (r: Row, i: number) => r.id || `new-${i}`;
  const ids = useMemo(() => rows.map(idFor), [rows]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    setRows(next);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    move(from, to);
  };

  const patch = (i: number, part: Partial<Row>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...part } : r)));

  const saveSteps = () => {
    setError(null);
    setJustSaved(false);
    startTransition(async () => {
      const result = await setPipelineStepsAction(pipeline.id, rows);
      if (result.ok) {
        // BOTH sides adopt what the server stored — the draft too. A new step
        // is submitted with a blank id and given a real one; keeping the local
        // blank copy would submit it again on the next save and mint a second
        // step instead of editing the first.
        const adopted = result.steps.map(toRow);
        setRows(adopted);
        setSavedRows(adopted);
        setJustSaved('Saved — every module route picks this up on its next render.');
      } else {
        setError(result.message);
      }
    });
  };

  const saveLabel = () => {
    setError(null);
    setJustSaved(false);
    startTransition(async () => {
      const result = await renamePipelineAction(pipeline.id, label);
      if (result.ok) {
        setSavedLabel(label.trim());
        setLabel(label.trim());
        setJustSaved('Saved — every module route picks this up on its next render.');
      } else {
        setError(result.message ?? 'Could not rename this pipeline.');
      }
    });
  };

  /** A step never saved is only in the draft: it just leaves the list. */
  const askRemove = (r: Row, i: number) => {
    setError(null);
    if (!r.id) {
      setRows(rows.filter((_, n) => n !== i));
      return;
    }
    if (stepsDirty) {
      setError('Save or discard your other step changes first, then remove the step.');
      return;
    }
    setRemoving(r);
  };

  const removed = (steps: AdminStepRow[], moved: number, label: string) => {
    const adopted = steps.map(toRow);
    setRows(adopted);
    setSavedRows(adopted);
    setCounts((c) => {
      const next = { ...c };
      const gone = removing?.id;
      if (gone) delete next[gone];
      return next;
    });
    setRemoving(null);
    setJustSaved(moved ? `“${label}” removed. ${moved} record${moved === 1 ? '' : 's'} moved, each noted in its history.` : `“${label}” removed.`);
  };

  const reorder = (to: number) => {
    if (to < 0 || to >= siblings.length) return;
    const next = siblings.map((p) => p.id);
    next.splice(to, 0, next.splice(index, 1)[0]!);
    startTransition(async () => {
      const result = await setPipelineOrderAction(pipeline.moduleId, next);
      if (!result.ok) setError(result.message ?? 'Could not reorder.');
    });
  };

  return (
    <div className="rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-faint px-3 py-2">
        <Icon name="route" size={13} className="shrink-0 text-ink-400" />
        <input
          value={label}
          aria-label={`${savedLabel} name`}
          onChange={(e) => setLabel(e.target.value)}
          className="min-w-0 flex-1 rounded border border-transparent px-1.5 py-1 text-[13.5px] font-semibold text-ink-900 outline-none hover:border-line focus-field"
        />
        <span className="shrink-0 text-[11.5px] text-ink-400">{moduleLabel}</span>

        {reorderable ? (
          <span className="flex shrink-0 items-center">
            <MiniButton icon="chevron-up" label="Move this pipeline earlier" disabled={index === 0 || pending} onClick={() => reorder(index - 1)} />
            <MiniButton
              icon="chevron-down"
              label="Move this pipeline later"
              disabled={index === siblings.length - 1 || pending}
              onClick={() => reorder(index + 1)}
            />
          </span>
        ) : null}

        {labelDirty ? (
          <Button size="sm" variant="secondary" icon="check" disabled={pending} onClick={saveLabel}>
            {pending ? 'Saving…' : 'Rename'}
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="flex items-center gap-1.5 border-b border-line-faint bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {error}
        </p>
      ) : null}
      {justSaved && !stepsDirty && !labelDirty ? (
        <p className="flex items-center gap-1.5 border-b border-line-faint px-3 py-2 text-[12.5px] text-ok">
          <Icon name="check" size={13} strokeWidth={2.5} />
          {justSaved}
        </p>
      ) : null}

      <div className="p-3">
        <DndContext id={`steps-dnd-${pipeline.id}`} sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1">
              {rows.map((r, i) => (
                <SortableRow key={idFor(r, i)} id={idFor(r, i)}>
                  {(handle) => (
                    <>
                      <button
                        type="button"
                        aria-label={`Reorder ${r.label || 'new step'}`}
                        {...handle.attributes}
                        {...handle.listeners}
                        className="shrink-0 cursor-grab text-ink-300 transition-colors hover:text-ink-500 active:cursor-grabbing"
                      >
                        <Icon name="shuffle" size={12} />
                      </button>

                      <span className="w-5 shrink-0 text-center text-[11px] tabular text-ink-400">{i + 1}</span>

                      <input
                        value={r.label}
                        aria-label={`Step ${i + 1} label`}
                        placeholder="Step name"
                        onChange={(e) => patch(i, { label: e.target.value })}
                        className="min-w-0 flex-1 rounded border border-line px-2 py-1 text-[13px] outline-none focus-field"
                      />

                      <select
                        value={r.swatch}
                        aria-label={`Step ${i + 1} colour`}
                        onChange={(e) => patch(i, { swatch: e.target.value })}
                        className="shrink-0 rounded border border-line px-1.5 py-1 text-[12px] outline-none focus-field"
                      >
                        {SWATCHES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>

                      <span className="hidden shrink-0 sm:block">
                        <StatusPill label={r.label || '—'} swatch={r.swatch as Swatch} />
                      </span>

                      <span className="hidden w-[78px] shrink-0 text-right text-[11.5px] tabular text-ink-400 md:block" title="Records on this step now">
                        {r.id ? `${counts[r.id] ?? 0} record${(counts[r.id] ?? 0) === 1 ? '' : 's'}` : 'New'}
                      </span>

                      <span className="flex shrink-0 items-center">
                        <MiniButton icon="chevron-up" label={`Move ${r.label || 'step'} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)} />
                        <MiniButton
                          icon="chevron-down"
                          label={`Move ${r.label || 'step'} later`}
                          disabled={i === rows.length - 1}
                          onClick={() => move(i, i + 1)}
                        />
                        <MiniButton
                          icon="trash"
                          label={`Remove ${r.label || 'step'}`}
                          disabled={pending || rows.length <= 1}
                          onClick={() => askRemove(r, i)}
                        />
                      </span>
                    </>
                  )}
                </SortableRow>
              ))}
            </ul>
          </SortableContext>
        </DndContext>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => setRows([...rows, { id: '', label: '', swatch: nextSwatch(rows.length) }])}
          >
            Add step
          </Button>
          <OutlineChip icon="info">Removing a step moves its records to a step you choose</OutlineChip>
          <span className="ml-auto flex items-center gap-2">
            {stepsDirty ? (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setRows(savedRows)}>
                Discard
              </Button>
            ) : null}
            <Button size="sm" variant="primary" icon="check" disabled={!stepsDirty || pending} onClick={saveSteps}>
              {pending ? 'Saving…' : 'Save steps'}
            </Button>
          </span>
        </div>

        <p className="mt-2 text-[11.5px] text-ink-400">
          Renaming or reordering a step is safe — records point at the step itself, not at its name or position.
        </p>
      </div>

      {removing ? (
        <RemoveStepDialog
          pipelineId={pipeline.id}
          step={removing}
          records={counts[removing.id] ?? 0}
          others={savedRows.filter((r) => r.id !== removing.id)}
          onClose={() => setRemoving(null)}
          onRemoved={removed}
        />
      ) : null}
    </div>
  );
}

function RemoveStepDialog({
  pipelineId,
  step,
  records,
  others,
  onClose,
  onRemoved,
}: {
  pipelineId: string;
  step: Row;
  records: number;
  others: Row[];
  onClose: () => void;
  onRemoved: (steps: AdminStepRow[], moved: number, label: string) => void;
}) {
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const confirm = () => {
    setError(null);
    start(async () => {
      const r = await removePipelineStepAction(pipelineId, step.id, records ? moveTo || null : null);
      if (r.ok) onRemoved(r.steps, r.moved, step.label);
      else setError(r.message);
    });
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={() => (pending ? null : onClose())} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`remove-step-${step.id}`}
        className="relative w-full max-w-[440px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(14,28,52,.4)]"
      >
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-bad-bg text-bad">
            <Icon name="trash" size={16} />
          </span>
          <div className="min-w-0">
            <h2 id={`remove-step-${step.id}`} className="text-[15.5px] font-semibold text-ink-900">
              Remove “{step.label}”?
            </h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              {records
                ? `${records} record${records === 1 ? ' is' : 's are'} on this step. ${records === 1 ? 'It moves' : 'They move'} to the step you pick, and each record's history notes the move.`
                : 'No record is on this step, so nothing moves.'}{' '}
              The step&apos;s option leaves the pipeline&apos;s Status field too.
            </p>
          </div>
        </div>

        {records ? (
          <label className="mt-4 block">
            <span className="text-[11.5px] font-semibold uppercase tracking-[.05em] text-ink-500">Move its records to</span>
            <select
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              disabled={pending}
              className="mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none focus-field"
            >
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 flex items-start gap-1.5 rounded-lg bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
            <Icon name="alert-triangle" size={13} className="mt-0.5 shrink-0" />
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" icon="trash" disabled={pending || (records > 0 && !moveTo)} onClick={confirm}>
            {pending ? 'Removing…' : records ? 'Move records and remove' : 'Remove step'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

const initial: PresetFormState = { ok: false };

function CreatePipelineForm({ modules, onClose }: { modules: ModuleOption[]; onClose: () => void }) {
  const [state, action] = useActionState(createPipelineAction, initial);
  const [steps, setSteps] = useState<{ label: string; swatch: string }[]>([
    { label: '', swatch: nextSwatch(0) },
    { label: '', swatch: nextSwatch(1) },
  ]);

  /** Blank rows are dropped rather than submitted: an admin who added a row and
   * changed their mind should not have to delete it to save. If every row is
   * blank the list is empty, and the schema's own "needs at least one step"
   * message is the right one to show. */
  const serialised = JSON.stringify(
    steps.map((s) => ({ id: '', label: s.label.trim(), swatch: s.swatch })).filter((s) => s.label),
  );

  const patch = (i: number, part: Partial<{ label: string; swatch: string }>) =>
    setSteps(steps.map((s, n) => (n === i ? { ...s, ...part } : s)));

  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    setSteps(next);
  };

  if (state.ok) {
    return (
      <div className="mt-4">
        <p className="flex items-center gap-1.5 text-[13px] text-ok">
          <Icon name="check" size={14} strokeWidth={2.5} />
          Pipeline created.
        </p>
        <div className="mt-5 flex justify-end">
          <Button type="button" variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="mt-4">
      <label htmlFor="pipeline-module" className="block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
        Module
      </label>
      <select
        id="pipeline-module"
        name="moduleId"
        required
        defaultValue=""
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      >
        <option value="" disabled>
          Choose a module…
        </option>
        {modules.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.frozen ? ' (frozen)' : ''}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11.5px] text-ink-400">Permanent — a pipeline cannot be moved to another module later.</p>

      <label htmlFor="pipeline-label" className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
        Name
      </label>
      <input
        id="pipeline-label"
        name="label"
        required
        placeholder="e.g. Onboarding Pipeline"
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      />

      <p className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-ink-400">Steps</p>
      <div className="mt-1.5 space-y-1 rounded-md border border-line p-2.5">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-4 shrink-0 text-center text-[11px] tabular text-ink-400">{i + 1}</span>
            <input
              value={s.label}
              aria-label={`Step ${i + 1} name`}
              placeholder="Step name"
              onChange={(e) => patch(i, { label: e.target.value })}
              className="min-w-0 flex-1 rounded border border-line px-2 py-1 text-[13px] outline-none focus-field"
            />
            <select
              value={s.swatch}
              aria-label={`Step ${i + 1} colour`}
              onChange={(e) => patch(i, { swatch: e.target.value })}
              className="shrink-0 rounded border border-line px-1.5 py-1 text-[12px] outline-none focus-field"
            >
              {SWATCHES.map((sw) => (
                <option key={sw} value={sw}>
                  {sw}
                </option>
              ))}
            </select>
            <span className="hidden shrink-0 sm:block">
              <StatusPill label={s.label || '—'} swatch={s.swatch as Swatch} />
            </span>
            <span className="flex shrink-0 items-center">
              <MiniButton icon="chevron-up" label={`Move step ${i + 1} earlier`} disabled={i === 0} onClick={() => move(i, i - 1)} />
              <MiniButton
                icon="chevron-down"
                label={`Move step ${i + 1} later`}
                disabled={i === steps.length - 1}
                onClick={() => move(i, i + 1)}
              />
            </span>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          onClick={() => setSteps([...steps, { label: '', swatch: nextSwatch(steps.length) }])}
        >
          Add step
        </Button>
      </div>
      <p className="mt-1 text-[11.5px] text-ink-400">
        At least one. Assigning a record puts it on the first step. Steps can be added, renamed, reordered and removed later.
      </p>
      <input type="hidden" name="steps" value={serialised} />

      {state.message ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {state.message}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" icon="check">
          Create pipeline
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Row chrome — the same handle and mini-buttons as ChoicesSection            */
/* -------------------------------------------------------------------------- */

type DragHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
};

function SortableRow({ id, children }: { id: string; children: (handle: DragHandleProps) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-md border border-line-soft bg-white px-2 py-1.5 ${
        isDragging ? 'relative z-10 opacity-50' : ''
      }`}
    >
      {children({ attributes, listeners })}
    </li>
  );
}

function MiniButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: 'chevron-up' | 'chevron-down' | 'trash';
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 place-items-center rounded text-ink-400 transition-colors hover:bg-canvas hover:text-ink-700 disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-ink-400"
    >
      <Icon name={icon} size={12} />
    </button>
  );
}
