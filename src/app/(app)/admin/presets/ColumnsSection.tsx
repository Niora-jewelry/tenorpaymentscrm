'use client';

/**
 * Admin → Presets, sub-step 3: dashboard columns and header-strip membership,
 * per module — properties (a)(b)(e) of the client's six-things-vary table.
 *
 * Two shape decisions worth knowing before editing this:
 *
 *   1. **Drafts are kept per module, not per screen.** Switching modules with
 *      unsaved changes is the obvious way to lose work here, and a confirm
 *      dialog is a worse answer than simply not throwing the draft away. Each
 *      module keeps its own pending list; the switcher marks the ones that
 *      have unsaved changes so nothing is silently abandoned.
 *   2. **Dragging is never the only way to reorder.** Every row carries move
 *      up / move down buttons as well, matching `DataTable`'s own column
 *      header and `RealFieldGrid`'s field cells — the admin screen is not the
 *      place to make ordering mouse-only.
 *
 * Deal Name is not in the picker and cannot be: it is drawn as the frozen
 * first column outside the configured set, so it is always first and can
 * never be de-selected. `adminColumns.ts` explains why adding it would
 * duplicate it rather than pin it.
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
import { Button, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { setModuleColumnsAction, setModuleHeaderFieldsAction, type PresetFormState } from './actions';
import type { AssignableField, ModuleFieldSelection } from '@/lib/records/adminColumns';
import type { ModuleOption } from '@/lib/records/adminPresets';

type ListKind = 'columns' | 'headers';
type Draft = Record<string, Record<ListKind, string[]>>;

function buildDraft(selections: ModuleFieldSelection[]): Draft {
  const out: Draft = {};
  for (const s of selections) out[s.moduleId] = { columns: s.columnIds, headers: s.headerIds };
  return out;
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

export function ColumnsSection({
  modules,
  fields,
  selections,
}: {
  modules: ModuleOption[];
  fields: AssignableField[];
  selections: ModuleFieldSelection[];
}) {
  const [moduleId, setModuleId] = useState(modules[0]?.id ?? '');
  const [draft, setDraft] = useState<Draft>(() => buildDraft(selections));
  /** What the database currently holds. Updated on a successful save rather
   * than re-derived from props: the action revalidates this route anyway, but
   * the dirty marks must clear the moment the write lands, not one render
   * later. */
  const [saved, setSaved] = useState<Draft>(() => buildDraft(selections));

  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const activeModule = modules.find((m) => m.id === moduleId);
  const empty: Record<ListKind, string[]> = { columns: [], headers: [] };

  const setList = (kind: ListKind, next: string[]) =>
    setDraft((prev) => ({
      ...prev,
      [moduleId]: { ...(prev[moduleId] ?? empty), [kind]: next },
    }));

  const markSaved = (kind: ListKind, next: string[]) =>
    setSaved((prev) => ({
      ...prev,
      [moduleId]: { ...(prev[moduleId] ?? empty), [kind]: next },
    }));

  const dirtyKinds = (id: string): ListKind[] => {
    const d = draft[id] ?? empty;
    const s = saved[id] ?? empty;
    return (['columns', 'headers'] as ListKind[]).filter((k) => !sameOrder(d[k], s[k]));
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <div className="border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">Columns &amp; header strip</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-400">
          The three things that differ per module: which fields are table columns, in what order, and which appear at
          the top of the drawer. The fields themselves are the same everywhere.
        </p>
      </div>

      {/* Module switcher. Unsaved work is kept per module rather than
          discarded, so this dot is a reminder, not a warning. */}
      <div className="flex flex-wrap gap-1.5 border-b border-line-faint bg-canvas px-4 py-2">
        {modules.map((m) => {
          const pending = dirtyKinds(m.id).length > 0;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setModuleId(m.id)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                m.id === moduleId
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-line bg-white text-ink-600 hover:bg-canvas'
              }`}
            >
              {m.label}
              {pending ? <span className="size-1.5 rounded-full bg-warn" title="Unsaved changes" /> : null}
            </button>
          );
        })}
      </div>

      {activeModule ? (
        <div className="space-y-4 p-4">
          {activeModule.frozen ? (
            <p className="flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn-bg px-3 py-2 text-[12.5px] text-ink-700">
              <Icon name="info" size={13} className="mt-0.5 shrink-0" />
              <span>
                {activeModule.label} is on hold — the client asked for its fields to be designed elsewhere. Column and
                header choices are safe to set, but check with him before assuming they are final.
              </span>
            </p>
          ) : null}

          <ListEditor
            key={`${moduleId}-columns`}
            kind="columns"
            title="Dashboard columns"
            blurb="Shown as table columns on this module's dashboard, left to right. Deal Name is always first and is not listed here — it is frozen outside this selection."
            moduleId={moduleId}
            selectedIds={(draft[moduleId] ?? empty).columns}
            fields={fields}
            fieldById={fieldById}
            dirty={!sameOrder((draft[moduleId] ?? empty).columns, (saved[moduleId] ?? empty).columns)}
            onChange={(next) => setList('columns', next)}
            onReset={() => setList('columns', (saved[moduleId] ?? empty).columns)}
            onSaved={(next) => markSaved('columns', next)}
          />

          <ListEditor
            key={`${moduleId}-headers`}
            kind="headers"
            title="Header strip"
            blurb="Shown under the record's name at the top of the drawer. This is how the spec's scoping is expressed — “Last merchant response: Leads and Tickets only” means it is in those two modules' strips and no others."
            moduleId={moduleId}
            selectedIds={(draft[moduleId] ?? empty).headers}
            fields={fields}
            fieldById={fieldById}
            dirty={!sameOrder((draft[moduleId] ?? empty).headers, (saved[moduleId] ?? empty).headers)}
            onChange={(next) => setList('headers', next)}
            onReset={() => setList('headers', (saved[moduleId] ?? empty).headers)}
            onSaved={(next) => markSaved('headers', next)}
          />
        </div>
      ) : (
        <p className="px-4 py-6 text-[13px] text-ink-400">No modules yet.</p>
      )}
    </section>
  );
}

function ListEditor({
  kind,
  title,
  blurb,
  moduleId,
  selectedIds,
  fields,
  fieldById,
  dirty,
  onChange,
  onReset,
  onSaved,
}: {
  kind: ListKind;
  title: string;
  blurb: string;
  moduleId: string;
  selectedIds: string[];
  fields: AssignableField[];
  fieldById: Map<string, AssignableField>;
  dirty: boolean;
  onChange: (next: string[]) => void;
  onReset: () => void;
  onSaved: (next: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const available = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return fields.filter(
      (f) =>
        !selectedSet.has(f.id) &&
        (!needle || f.label.toLowerCase().includes(needle) || f.key.toLowerCase().includes(needle) || f.tabLabel.toLowerCase().includes(needle)),
    );
  }, [fields, selectedSet, search]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= selectedIds.length) return;
    const next = [...selectedIds];
    next.splice(to, 0, next.splice(from, 1)[0]!);
    onChange(next);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = selectedIds.indexOf(String(active.id));
    const to = selectedIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    move(from, to);
  };

  const save = () => {
    setError(null);
    setJustSaved(false);
    const next = selectedIds;
    startTransition(async () => {
      const action = kind === 'columns' ? setModuleColumnsAction : setModuleHeaderFieldsAction;
      const result: PresetFormState = await action(moduleId, next);
      if (result.ok) {
        onSaved(next);
        setJustSaved(true);
      } else {
        setError(result.message ?? 'That did not save.');
      }
    });
  };

  return (
    <div className="rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line-faint px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold text-ink-900">
            {title} <span className="ml-1 font-normal text-ink-400">({selectedIds.length})</span>
          </h3>
          <p className="mt-0.5 text-[11.5px] text-ink-400">{blurb}</p>
        </div>
        {dirty ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={onReset}>
            Discard
          </Button>
        ) : null}
        <Button size="sm" variant="primary" icon="check" disabled={!dirty || pending} onClick={save}>
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

      <div className="grid gap-3 p-3 md:grid-cols-2">
        {/* ---- selected, in order ---- */}
        <div className="min-w-0">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-ink-400">
            Selected — top to bottom is {kind === 'columns' ? 'left to right' : 'the strip order'}
          </p>
          {selectedIds.length === 0 ? (
            <p className="rounded-md border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-ink-400">
              {kind === 'columns'
                ? 'No columns — the dashboard shows only the frozen Deal Name.'
                : 'No header fields — the drawer shows only the record name.'}
            </p>
          ) : (
            <DndContext
              id={`list-dnd-${moduleId}-${kind}`}
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={selectedIds} strategy={verticalListSortingStrategy}>
                <ul className="space-y-1">
                  {selectedIds.map((id, i) => {
                    const f = fieldById.get(id);
                    return (
                      <SortableRow key={id} id={id}>
                        {(handle) => (
                          <>
                            <button
                              type="button"
                              aria-label={`Reorder ${f?.label ?? id}`}
                              {...handle.attributes}
                              {...handle.listeners}
                              className="shrink-0 cursor-grab text-ink-300 transition-colors hover:text-ink-500 active:cursor-grabbing"
                            >
                              <Icon name="shuffle" size={12} />
                            </button>
                            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-800">
                              {f?.label ?? <span className="text-ink-400">(field no longer available)</span>}
                              {f ? <span className="ml-1.5 text-[11px] text-ink-400">{f.tabLabel}</span> : null}
                            </span>
                            <span className="flex shrink-0 items-center">
                              <MiniButton
                                icon="chevron-up"
                                label={`Move ${f?.label ?? 'field'} earlier`}
                                disabled={i === 0}
                                onClick={() => move(i, i - 1)}
                              />
                              <MiniButton
                                icon="chevron-down"
                                label={`Move ${f?.label ?? 'field'} later`}
                                disabled={i === selectedIds.length - 1}
                                onClick={() => move(i, i + 1)}
                              />
                              <MiniButton
                                icon="x"
                                label={`Remove ${f?.label ?? 'field'}`}
                                onClick={() => onChange(selectedIds.filter((x) => x !== id))}
                              />
                            </span>
                          </>
                        )}
                      </SortableRow>
                    );
                  })}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* ---- everything else ---- */}
        <div className="min-w-0">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-ink-400">
            Available ({available.length})
          </p>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search label, key or tab…"
            className="w-full rounded border border-line px-2 py-1 text-[12.5px] outline-none focus-underline"
          />
          <ul className="mt-1.5 max-h-[280px] space-y-1 overflow-y-auto pr-0.5">
            {available.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onChange([...selectedIds, f.id])}
                  className="flex w-full items-center gap-2 rounded-md border border-line-soft px-2 py-1.5 text-left transition-colors hover:border-brand-600 hover:bg-brand-50"
                >
                  <Icon name="plus" size={12} className="shrink-0 text-ink-400" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink-800">{f.label}</span>
                  <OutlineChip>{f.subtabLabel ?? f.tabLabel}</OutlineChip>
                </button>
              </li>
            ))}
            {available.length === 0 ? (
              <li className="px-2 py-4 text-center text-[12.5px] text-ink-400">
                {search ? 'Nothing matches that.' : 'Every field is already selected.'}
              </li>
            ) : null}
          </ul>
        </div>
      </div>
    </div>
  );
}

type DragHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
};

/** Render-prop handle, same shape as `RealFieldGrid`'s sortable cell — the
 * grip belongs inline at the start of the row, not as an overlay that would
 * sit on top of the row's own buttons. */
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
  icon: 'chevron-up' | 'chevron-down' | 'x';
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
