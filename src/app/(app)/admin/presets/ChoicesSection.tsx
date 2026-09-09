'use client';

/**
 * Admin → Presets, sub-step 4: the options on a dropdown, status, multi-select
 * or percent-split field — globally, or overridden for one module.
 *
 * Property (f) of the client's six-things-vary table: *"Current Status has
 * different choices in Leads vs Contacts."*
 *
 * Three things drive the shape of this screen, all of them from
 * `adminChoices.ts`, which is worth reading first:
 *
 *   1. **A module override REPLACES the global list, it does not extend it.**
 *      So an override is created by an explicit button that copies the global
 *      set server-side, never by an admin adding one row under a module tab.
 *      The scope switcher says which modules have their own list and which
 *      fall back, because that distinction is invisible everywhere else.
 *   2. **Renaming is free; the key never moves.** Each row's key is shown,
 *      locked, next to its label — an admin who can see that the label is the
 *      only editable half does not have to be told renaming is safe. New rows
 *      show "key assigned on save".
 *   3. **Nothing can be removed.** Records store the key, so a removed option
 *      leaves them resolving to nothing. There is no delete control, and the
 *      writer has no DELETE either.
 */

import { useMemo, useState, useTransition } from 'react';
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
import { SWATCHES, SWATCHED_FIELD_TYPES } from '@/lib/records/adminSchemas';
import { setFieldChoicesAction, createModuleOverrideAction } from './actions';
import type { ChoiceFieldRow } from '@/lib/records/adminChoices';
import type { ModuleOption } from '@/lib/records/adminPresets';
import type { Swatch } from '@/proto/schema';

/** One editable row. `key` is empty for an option that has never been saved —
 * the server assigns it and hands it back, and the draft adopts it there. */
type Row = { key: string; value: string; swatch: string };

/** `null` is the global set; a uuid is that module's own list. */
type Scope = string | null;

const scopeId = (fieldId: string, scope: Scope) => `${fieldId}|${scope ?? 'global'}`;

const sameRows = (a: Row[], b: Row[]) =>
  a.length === b.length && a.every((r, i) => r.key === b[i]!.key && r.value === b[i]!.value && r.swatch === b[i]!.swatch);

export function ChoicesSection({ fields, modules }: { fields: ChoiceFieldRow[]; modules: ModuleOption[] }) {
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? '');
  const [scope, setScope] = useState<Scope>(null);
  const field = fields.find((f) => f.id === fieldId);

  /** Drafts and their saved counterparts are both keyed by field+scope, so
   * switching field or module never discards unsaved work — the same choice
   * `ColumnsSection` makes, for the same reason: a confirm dialog is a worse
   * answer than simply keeping it. */
  const [drafts, setDrafts] = useState<Record<string, Row[]>>({});
  const [saved, setSaved] = useState<Record<string, Row[]>>({});

  /** What the database holds, from props — the baseline a draft is compared
   * against until a save replaces it with what the server actually stored. */
  const fromProps = (f: ChoiceFieldRow, s: Scope): Row[] =>
    (s === null ? f.global : (f.byModule[s] ?? [])).map((c) => ({
      key: c.key,
      value: c.value,
      swatch: c.swatch ?? '',
    }));

  const rowsFor = (f: ChoiceFieldRow, s: Scope): Row[] => drafts[scopeId(f.id, s)] ?? fromProps(f, s);
  const savedFor = (f: ChoiceFieldRow, s: Scope): Row[] => saved[scopeId(f.id, s)] ?? fromProps(f, s);

  const setRows = (next: Row[]) => setDrafts((prev) => ({ ...prev, [scopeId(fieldId, scope)]: next }));

  /** After a save, BOTH sides adopt what the server stored — the draft too,
   * not just the baseline. A new option is submitted with an empty key and is
   * given one server-side; keeping the local blank-key copy would submit it
   * again on the next save and mint a second option instead of editing the
   * first. */
  const adoptSaved = (rows: Row[]) => {
    const id = scopeId(fieldId, scope);
    setDrafts((prev) => ({ ...prev, [id]: rows }));
    setSaved((prev) => ({ ...prev, [id]: rows }));
  };

  const dirtyFor = (f: ChoiceFieldRow, s: Scope) => !sameRows(rowsFor(f, s), savedFor(f, s));

  /** Only modules that can actually show this field's options. The Records
   * List is a real module here — it displays records like any other, so a
   * per-module status set for it is meaningful. */
  const overriddenIn = (f: ChoiceFieldRow, moduleId: string) => Boolean(f.byModule[moduleId]?.length);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <div className="border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">Choices</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-400">
          The options on a dropdown, status, multi-select or percent-split field. One list for every module, or a
          module with its own — “different statuses per module”.
        </p>
      </div>

      {fields.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-ink-400">
          No dropdown, status, multi-select or percent-split fields yet. Create one in Fields first.
        </p>
      ) : (
        <div className="space-y-3 p-4">
          <div>
            <label htmlFor="choices-field" className="block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
              Field
            </label>
            <select
              id="choices-field"
              value={fieldId}
              onChange={(e) => {
                setFieldId(e.target.value);
                setScope(null);
              }}
              className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-underline"
            >
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label} — {f.subtabLabel ? `${f.tabLabel} › ${f.subtabLabel}` : f.tabLabel}
                </option>
              ))}
            </select>
          </div>

          {field ? (
            <>
              {/* Scope switcher. "Uses the shared list" is the important state
                  to show: it is what makes an override a deliberate act rather
                  than something an admin discovers they created. */}
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line-faint bg-canvas px-2.5 py-2">
                <ScopeButton
                  label="All modules"
                  active={scope === null}
                  dirty={dirtyFor(field, null)}
                  onClick={() => setScope(null)}
                />
                <span className="mx-1 h-4 w-px bg-line" />
                {modules.map((m) => (
                  <ScopeButton
                    key={m.id}
                    label={m.label}
                    active={scope === m.id}
                    dirty={dirtyFor(field, m.id)}
                    muted={!overriddenIn(field, m.id)}
                    onClick={() => setScope(m.id)}
                  />
                ))}
              </div>

              <ScopeEditor
                key={scopeId(field.id, scope)}
                field={field}
                scope={scope}
                scopeLabel={scope === null ? 'All modules' : (modules.find((m) => m.id === scope)?.label ?? 'this module')}
                hasOwnList={scope === null || overriddenIn(field, scope)}
                globalCount={field.global.length}
                rows={rowsFor(field, scope)}
                dirty={dirtyFor(field, scope)}
                onChange={setRows}
                onReset={() => setRows(savedFor(field, scope))}
                onSaved={adoptSaved}
              />
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ScopeButton({
  label,
  active,
  dirty,
  muted,
  onClick,
}: {
  label: string;
  active: boolean;
  dirty: boolean;
  /** No list of its own — it falls back to the shared one. */
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={muted ? `${label} uses the shared list` : undefined}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
        active
          ? 'border-brand-600 bg-brand-50 text-brand-700'
          : muted
            ? 'border-dashed border-line bg-white text-ink-400 hover:bg-canvas'
            : 'border-line bg-white text-ink-600 hover:bg-canvas'
      }`}
    >
      {label}
      {dirty ? <span className="size-1.5 rounded-full bg-warn" title="Unsaved changes" /> : null}
    </button>
  );
}

function ScopeEditor({
  field,
  scope,
  scopeLabel,
  hasOwnList,
  globalCount,
  rows,
  dirty,
  onChange,
  onReset,
  onSaved,
}: {
  field: ChoiceFieldRow;
  scope: Scope;
  scopeLabel: string;
  hasOwnList: boolean;
  globalCount: number;
  rows: Row[];
  dirty: boolean;
  onChange: (next: Row[]) => void;
  onReset: () => void;
  onSaved: (rows: Row[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const swatched = SWATCHED_FIELD_TYPES.includes(field.type);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Stable per-row identity for the sort list. A brand-new row has no key
   * yet, so it borrows its index — which is safe because a new row cannot be
   * dragged before it has been given something to be identified by, and the
   * whole list is re-keyed from the server the moment it is saved. */
  const idFor = (r: Row, i: number) => r.key || `new-${i}`;
  const ids = useMemo(() => rows.map(idFor), [rows]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onChange(next);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    move(from, to);
  };

  const patch = (i: number, part: Partial<Row>) =>
    onChange(rows.map((r, n) => (n === i ? { ...r, ...part } : r)));

  const run = (fn: () => Promise<Awaited<ReturnType<typeof setFieldChoicesAction>>>) => {
    setError(null);
    setJustSaved(false);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        onSaved(result.choices.map((c) => ({ key: c.key, value: c.value, swatch: c.swatch })));
        setJustSaved(true);
      } else {
        setError(result.message);
      }
    });
  };

  /* A module that has no list of its own is not editable in place — editing it
     would have to create the override, and an override created as a side
     effect of typing is exactly the silent failure `adminChoices.ts` exists to
     prevent. It gets an explicit copy instead. */
  if (!hasOwnList) {
    return (
      <div className="rounded-lg border border-dashed border-line p-4">
        <p className="text-[13px] text-ink-700">
          <strong className="font-semibold">{scopeLabel}</strong> uses the shared list — the same{' '}
          {globalCount} {globalCount === 1 ? 'option' : 'options'} every other module sees.
        </p>
        <p className="mt-1.5 text-[12.5px] text-ink-400">
          Giving it its own list copies those {globalCount} across first, so nothing changes for anyone until you edit
          the copy. A module&apos;s own list <strong>replaces</strong> the shared one rather than adding to it — that is
          why it starts as a full copy and not as an empty list.
        </p>
        {error ? (
          <p className="mt-2 flex items-center gap-1.5 rounded-md bg-bad-bg px-2 py-1.5 text-[12.5px] text-bad">
            <Icon name="alert-triangle" size={12} />
            {error}
          </p>
        ) : null}
        <div className="mt-3">
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            disabled={pending || !scope}
            onClick={() => {
              if (scope) run(() => createModuleOverrideAction(field.id, scope));
            }}
          >
            {pending ? 'Copying…' : `Give ${scopeLabel} its own options`}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-faint px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-ink-900">
            {scopeLabel} <span className="ml-1 font-normal text-ink-400">({rows.length})</span>
          </h3>
          <p className="mt-0.5 text-[11.5px] text-ink-400">
            {scope === null
              ? 'Every module without its own list shows these, in this order.'
              : `Only ${scopeLabel} shows these. They replace the shared list here rather than adding to it.`}
          </p>
        </div>
        {dirty ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={onReset}>
            Discard
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          icon="check"
          disabled={!dirty || pending}
          onClick={() => run(() => setFieldChoicesAction(field.id, scope, rows))}
        >
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {error ? (
        <p className="flex items-center gap-1.5 border-b border-line-faint bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {error}
        </p>
      ) : null}
      {justSaved && !dirty ? (
        <p className="flex items-center gap-1.5 border-b border-line-faint px-3 py-2 text-[12.5px] text-ok">
          <Icon name="check" size={13} strokeWidth={2.5} />
          Saved — every module route picks this up on its next render.
        </p>
      ) : null}

      <div className="p-3">
        <DndContext
          id={`choices-dnd-${scopeId(field.id, scope)}`}
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul className="space-y-1">
              {rows.map((r, i) => (
                <SortableRow key={idFor(r, i)} id={idFor(r, i)}>
                  {(handle) => (
                    <>
                      <button
                        type="button"
                        aria-label={`Reorder ${r.value || 'new option'}`}
                        {...handle.attributes}
                        {...handle.listeners}
                        className="shrink-0 cursor-grab text-ink-300 transition-colors hover:text-ink-500 active:cursor-grabbing"
                      >
                        <Icon name="shuffle" size={12} />
                      </button>

                      <input
                        value={r.value}
                        aria-label={`Option ${i + 1} label`}
                        placeholder="Option label"
                        onChange={(e) => patch(i, { value: e.target.value })}
                        className="min-w-0 flex-1 rounded border border-line px-2 py-1 text-[13px] outline-none focus-underline"
                      />

                      {/* The permanent half, shown so the editable half is
                          obviously the editable half. */}
                      {r.key ? (
                        <code className="hidden shrink-0 rounded bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-400 sm:block">
                          {r.key}
                        </code>
                      ) : (
                        <span className="hidden shrink-0 text-[11px] italic text-ink-400 sm:block">key on save</span>
                      )}

                      {swatched ? (
                        <select
                          value={r.swatch}
                          aria-label={`Option ${i + 1} colour`}
                          onChange={(e) => patch(i, { swatch: e.target.value })}
                          className="shrink-0 rounded border border-line px-1.5 py-1 text-[12px] outline-none focus-underline"
                        >
                          <option value="">No colour</option>
                          {SWATCHES.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      ) : null}

                      {swatched && r.swatch ? (
                        <span className="hidden shrink-0 sm:block">
                          <StatusPill label={r.value || '—'} swatch={r.swatch as Swatch} />
                        </span>
                      ) : null}

                      <span className="flex shrink-0 items-center">
                        <MiniButton
                          icon="chevron-up"
                          label={`Move ${r.value || 'option'} earlier`}
                          disabled={i === 0}
                          onClick={() => move(i, i - 1)}
                        />
                        <MiniButton
                          icon="chevron-down"
                          label={`Move ${r.value || 'option'} later`}
                          disabled={i === rows.length - 1}
                          onClick={() => move(i, i + 1)}
                        />
                      </span>
                    </>
                  )}
                </SortableRow>
              ))}
            </ul>
          </SortableContext>
        </DndContext>

        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-line px-3 py-5 text-center text-[12.5px] text-ink-400">
            No options yet — this field renders an empty picker until one is added.
          </p>
        ) : null}

        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => onChange([...rows, { key: '', value: '', swatch: '' }])}
          >
            Add option
          </Button>
          <OutlineChip icon="info">Options cannot be removed — records store them</OutlineChip>
        </div>
      </div>
    </div>
  );
}

type DragHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
};

/** Same render-prop handle as `ColumnsSection`'s row — the grip belongs inline
 * at the start, not as an overlay sitting on the row's own controls. */
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
  icon: 'chevron-up' | 'chevron-down';
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
