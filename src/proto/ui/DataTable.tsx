'use client';

/**
 * PROTOTYPE — the dashboard table.
 *
 * The single biggest piece of the shared chassis, and the one every display
 * module reuses. Four behaviours here are specified exactly and are the reason
 * this is not just "a table":
 *
 *   1. Deal Name is the first column and is FROZEN. It stays put while the
 *      other 25 columns scroll past it, and grows a right-edge shadow the
 *      moment the grid is scrolled.
 *
 *   2. The horizontal scrollbar is STICKY to the bottom of the viewport
 *      (Monday.com behaviour). The native one sits at the bottom of the
 *      content, which would make a user scroll down 50 rows to reach it.
 *      This one is an overlay synced to the grid's scrollLeft.
 *
 *   3. Per-user columns. A field the viewer cannot see produces an ABSENT
 *      column, never a blank cell. Switch the viewer in the top bar and columns
 *      disappear entirely.
 *
 *   4. Bulk actions SKIP AND REPORT. Rows the user cannot modify are listed
 *      back to them with a reason — never silently ignored.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Field, FieldValue, Filter, RecordRow, Swatch } from '../schema';
import { choicesFor, choiceLabel, choiceKey } from '../fields';
import { CellValue, FieldRenderer, isNumeric } from './value';
import { MenuSurface } from './MenuSurface';
import {
  BarAction,
  BarCount,
  Button,
  FloatingBar,
  NumberInput,
  OutlineChip,
  Popover,
  Spinner,
  StatusPill,
} from './kit';
import { Icon, type IconName } from './icons';
import { PersonAvatar, resolvePerson, usePeopleById } from './people';
import { formatDate } from './tokens';

const ROWS_PER_PAGE = 50;
const DEAL_NAME_WIDTH = 250;
const CHECKBOX_WIDTH = 44;

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

export type { Filter };

/** The control a field type gets, per the spec's filtering matrix. */
export function filterKindFor(type: Field['type']): Filter['kind'] | null {
  switch (type) {
    case 'text':
    case 'long_text':
    case 'email':
    case 'phone':
    case 'url':
    case 'address':
      return 'contains';
    case 'dropdown':
    case 'status':
    case 'multi_select':
    case 'team_member':
    case 'months':
      return 'values';
    case 'number':
    case 'currency':
    case 'percentage':
      return 'range';
    case 'date':
    case 'datetime':
      return 'dates';
    case 'checkbox':
      return 'bool';
    default:
      return null;
  }
}

function matches(record: RecordRow, filter: Filter, field: Field): boolean {
  const raw = filter.fieldId === 'deal_name' ? record.dealName : record.values[filter.fieldId];

  switch (filter.kind) {
    case 'contains':
      if (!filter.text) return true;
      return String(raw ?? '').toLowerCase().includes(filter.text.toLowerCase());
    case 'values': {
      if (!filter.values.length) return true;
      // Multi-select and team-member values are arrays of strings; a grid field
      // is also an array but of row objects, and is never filterable this way.
      if (Array.isArray(raw)) {
        return raw.some((v) => typeof v === 'string' && filter.values.includes(v));
      }
      return filter.values.includes(String(raw ?? ''));
    }
    case 'range': {
      const n = Number(raw);
      if (raw == null || Number.isNaN(n)) return false;
      if (filter.min != null && n < filter.min) return false;
      if (filter.max != null && n > filter.max) return false;
      return true;
    }
    case 'dates': {
      const s = String(raw ?? '').slice(0, 10);
      if (!s) return false;
      if (filter.from && s < filter.from) return false;
      if (filter.to && s > filter.to) return false;
      return true;
    }
    case 'bool':
      return Boolean(raw) === filter.checked;
    case 'present':
      return raw != null && raw !== '';
    default:
      void field;
      return true;
  }
}

function filterSummary(filter: Filter, field: Field, moduleSlug: string): string {
  switch (filter.kind) {
    case 'contains':
      return `${field.label}: "${filter.text}"`;
    case 'values': {
      // A 'values' filter holds what records store — choice keys — so the chip
      // has to label them or it reads "Current Status: new_lead, working".
      const options = choicesFor(field, moduleSlug);
      const shown = filter.values.slice(0, 2).map((v) => choiceLabel(options, v));
      return `${field.label}: ${shown.join(', ')}${
        filter.values.length > 2 ? ` +${filter.values.length - 2}` : ''
      }`;
    }
    case 'range':
      return `${field.label}: ${filter.min ?? '−∞'} – ${filter.max ?? '∞'}`;
    case 'dates':
      return `${field.label}: ${filter.from ?? '…'} → ${filter.to ?? '…'}`;
    case 'bool':
      return `${field.label}: ${filter.checked ? 'checked' : 'unchecked'}`;
    case 'present':
      // The only field that carries a 'present' filter today is a pipeline's
      // synced Status field, whose label already reads "<Pipeline> Status".
      return `On ${field.label.replace(/ Status$/, '')}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Column header with its filter control                                       */
/* -------------------------------------------------------------------------- */

function ColumnHeader({
  field,
  rows,
  moduleSlug,
  filter,
  onChange,
}: {
  field: Field;
  rows: RecordRow[];
  /** The filter list is built from the values records actually hold, which
   * for a choice field are KEYS. Labelling them needs the module's own option
   * set, since a field's choices can differ per module. */
  moduleSlug: string;
  filter?: Filter;
  onChange: (f: Filter | undefined) => void;
}) {
  const kind = filterKindFor(field.type);
  const active = Boolean(filter);
  const options = choicesFor(field, moduleSlug);
  /* A `team_member` value is a real user id. The list used to render it with
   * `v.replace(/^u_/,'').replace(/^\w/, …)` — prototype logic for its fake
   * `u_alex` ids, which on a real uuid does nothing but capitalise the first
   * hex digit. So the filter offered a column of raw uuids that nobody could
   * pick from. The people directory is already in context for the avatars. */
  const peopleById = usePeopleById();

  const distinct = useMemo(() => {
    if (kind !== 'values') return [];
    const set = new Set<string>();

    /*
     * Three sources, and the last two are what make this usable.
     *
     * 1. The values present on the rows in front of you.
     * 2. Every configured choice, or every person for a `team_member` field.
     *    Building the list from the loaded page alone meant a column whose
     *    values all sit on page 2 offered "No values on this page", and there
     *    was no way to filter FOR something absent from the current page —
     *    which is most of the reason to filter at all.
     * 3. Whatever is already selected. Without this the list is rebuilt from
     *    the FILTERED rows, so the moment a filter matched nothing the option
     *    you had just ticked vanished and could not be unticked. That was a
     *    dead end reachable in one click.
     */
    for (const r of rows) {
      const v = r.values[field.id];
      if (Array.isArray(v)) v.forEach((x) => set.add(String(x)));
      else if (v != null && v !== '') set.add(String(v));
    }
    if (field.type === 'team_member') {
      for (const person of peopleById.values()) if (!person.suspended) set.add(person.id);
    } else {
      for (const c of options) set.add(choiceKey(c));
    }
    if (filter?.kind === 'values') filter.values.forEach((v) => set.add(v));

    // Sorted by what the reader actually sees, not by the stored key — a
    // column of uuids sorted as uuids is in no order at all.
    const labelOf = (v: string) =>
      field.type === 'team_member' ? resolvePerson(v, peopleById).name : choiceLabel(options, v);
    return [...set].sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  }, [rows, field.id, field.type, kind, options, peopleById, filter]);

  const label = (
    <span
      className={`flex items-center gap-1 text-[12px] font-semibold uppercase tracking-[.04em] transition-colors ${
        active ? 'text-brand-700' : 'text-ink-400 hover:text-ink-700'
      }`}
    >
      <span className="truncate">{field.label}</span>
      {/* Filled funnel when a filter is active, hollow when not. */}
      {kind ? (
        <Icon
          name="filter"
          size={11}
          strokeWidth={active ? 2 : 1.6}
          className={active ? 'fill-current text-brand-700' : 'text-ink-400/50'}
        />
      ) : null}
    </span>
  );

  if (!kind) return <div className="px-3 py-2">{label}</div>;

  return (
    <div className="px-3 py-2">
      <Popover trigger={() => label} width={kind === 'values' ? 230 : 250}>
        {(close) => (
          <div className="p-1">
            {kind === 'contains' ? (
              <input
                autoFocus
                type="text"
                placeholder={`${field.label} contains…`}
                defaultValue={filter?.kind === 'contains' ? filter.text : ''}
                className="w-full rounded-md border border-line px-2 py-1.5 text-[13px] outline-none focus-field"
                onChange={(e) =>
                  onChange(
                    e.currentTarget.value
                      ? { fieldId: field.id, kind: 'contains', text: e.currentTarget.value }
                      : undefined,
                  )
                }
              />
            ) : null}

            {kind === 'values' ? (
              <div className="max-h-64 overflow-y-auto">
                {distinct.length === 0 ? (
                  <p className="px-1 py-2 text-[12.5px] text-ink-400">No values on this page.</p>
                ) : null}
                {distinct.map((v) => {
                  const chosen = filter?.kind === 'values' && filter.values.includes(v);
                  return (
                    <label
                      key={v}
                      className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-canvas"
                    >
                      <input
                        type="checkbox"
                        checked={chosen}
                        className="size-3.5 accent-[#1d4ed8]"
                        onChange={() => {
                          const cur = filter?.kind === 'values' ? filter.values : [];
                          const next = chosen ? cur.filter((x) => x !== v) : [...cur, v];
                          onChange(next.length ? { fieldId: field.id, kind: 'values', values: next } : undefined);
                        }}
                      />
                      {field.type === 'team_member' ? (
                        (() => {
                          const person = resolvePerson(v, peopleById);
                          return (
                            <>
                              <PersonAvatar person={person} size={18} />
                              <span className="min-w-0 flex-1 truncate" title={person.email || person.name}>
                                {person.name}
                              </span>
                            </>
                          );
                        })()
                      ) : (
                        <span className="truncate">{choiceLabel(options, v)}</span>
                      )}
                    </label>
                  );
                })}
              </div>
            ) : null}

            {kind === 'range' ? (
              <div className="flex items-center gap-2">
                <NumberInput
                  placeholder="min"
                  defaultValue={filter?.kind === 'range' ? (filter.min ?? '') : ''}
                  className="w-full rounded-md border border-line px-2 py-1.5 text-[13px] outline-none focus-field"
                  onLiveChange={(n) => {
                    const min = n ?? undefined;
                    const max = filter?.kind === 'range' ? filter.max : undefined;
                    onChange(
                      min == null && max == null
                        ? undefined
                        : { fieldId: field.id, kind: 'range', min, max },
                    );
                  }}
                />
                <span className="text-ink-400">–</span>
                <NumberInput
                  placeholder="max"
                  defaultValue={filter?.kind === 'range' ? (filter.max ?? '') : ''}
                  className="w-full rounded-md border border-line px-2 py-1.5 text-[13px] outline-none focus-field"
                  onLiveChange={(n) => {
                    const max = n ?? undefined;
                    const min = filter?.kind === 'range' ? filter.min : undefined;
                    onChange(
                      min == null && max == null
                        ? undefined
                        : { fieldId: field.id, kind: 'range', min, max },
                    );
                  }}
                />
              </div>
            ) : null}

            {kind === 'dates' ? (
              <div className="flex flex-col gap-2">
                <label className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
                  Between
                </label>
                <input
                  type="date"
                  defaultValue={filter?.kind === 'dates' ? (filter.from ?? '') : ''}
                  className="rounded-md border border-line px-2 py-1.5 text-[13px] outline-none focus-field"
                  onChange={(e) => {
                    const from = e.currentTarget.value || undefined;
                    const to = filter?.kind === 'dates' ? filter.to : undefined;
                    onChange(!from && !to ? undefined : { fieldId: field.id, kind: 'dates', from, to });
                  }}
                />
                <input
                  type="date"
                  defaultValue={filter?.kind === 'dates' ? (filter.to ?? '') : ''}
                  className="rounded-md border border-line px-2 py-1.5 text-[13px] outline-none focus-field"
                  onChange={(e) => {
                    const to = e.currentTarget.value || undefined;
                    const from = filter?.kind === 'dates' ? filter.from : undefined;
                    onChange(!from && !to ? undefined : { fieldId: field.id, kind: 'dates', from, to });
                  }}
                />
              </div>
            ) : null}

            {kind === 'bool' ? (
              <div className="flex gap-2">
                {[true, false].map((b) => (
                  <button
                    key={String(b)}
                    type="button"
                    onClick={() => {
                      onChange(
                        filter?.kind === 'bool' && filter.checked === b
                          ? undefined
                          : { fieldId: field.id, kind: 'bool', checked: b },
                      );
                      close();
                    }}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-[13px] font-medium ${
                      filter?.kind === 'bool' && filter.checked === b
                        ? 'border-brand-600 bg-brand-50 text-brand-700'
                        : 'border-line text-ink-500 hover:bg-canvas'
                    }`}
                  >
                    {b ? 'Checked' : 'Unchecked'}
                  </button>
                ))}
              </div>
            ) : null}

            {active ? (
              <button
                type="button"
                onClick={() => {
                  onChange(undefined);
                  close();
                }}
                className="mt-2 w-full rounded-md px-2 py-1.5 text-[12.5px] font-semibold text-ink-500 hover:bg-canvas"
              >
                Clear this filter
              </button>
            ) : null}
          </div>
        )}
      </Popover>
    </div>
  );
}

type DragHandleProps = { attributes: ReturnType<typeof useSortable>['attributes']; listeners: ReturnType<typeof useSortable>['listeners'] };

/** One draggable column header. `children` is a render prop so the drag
 * activation props land on a dedicated handle icon, never on the `<th>`
 * itself — `<th>` is an ancestor of the filter popover's "contains" text
 * input, and `KeyboardSensor`'s Space activator would otherwise swallow
 * every spacebar keystroke typed into that filter (the same bug class fixed
 * in `RealFieldGrid.tsx`'s field cells). The move-left/right buttons remain
 * the keyboard-reachable fallback; the handle is the pointer-drag affordance. */
function SortableColumnHeader({
  id,
  width,
  children,
}: {
  id: string;
  width: number;
  children: (handle: DragHandleProps) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <th
      ref={setNodeRef}
      className={`group sticky top-0 z-20 border-b border-line bg-canvas text-left align-bottom transition-opacity ${
        isDragging ? 'z-40 opacity-40' : ''
      }`}
      style={{
        width,
        minWidth: width,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      {children({ attributes, listeners })}
    </th>
  );
}

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

export type SkipReport = { done: number; skipped: { name: string; reason: string }[] } | null;

type DataTableProps = {
  moduleSlug: string;
  rows: RecordRow[];
  columns: Field[];
  onOpen: (id: string) => void;
  /** Opens the record straight at the viewer's oldest unread mention. */
  onOpenMention?: (id: string) => void;
  /**
   * Server-side paging, when the caller has it.
   *
   * Without this the component pages the rows it was HANDED. The real app
   * hands it one server page (50 rows), so `pageCount` computed to 1 and every
   * pagination control was dead: a module with 312 records showed "312
   * records" in the header, "50 per page" in the footer, and no way to reach
   * records 51 and up from any screen. The prototype has its whole dataset in
   * memory and still wants the local behaviour, so this is optional and the
   * local path is unchanged when it is absent.
   */
  serverPaging?: { page: number; pageCount: number; total: number; onPage: (p: number) => void };
  /** A page change is in flight. Dims the grid so a click that takes a server
   *  round trip does not look like a click that did nothing. */
  tableBusy?: boolean;
  /** The row whose drawer is currently being fetched, if any.
   *
   * Opening a record is a server navigation, and on the live database it takes
   * long enough that a click with no feedback reads as a click that did not
   * register — so people click a second row, and then a third. Marking the row
   * says "this one, right now" for the whole wait. Optional: the prototype's
   * own `ModuleView` opens from an in-memory store with nothing to wait for. */
  openingId?: string | null;
  selected: Set<string>;
  onSelectedChange: (s: Set<string>) => void;
  /** The Tickets module's hardcoded "Open case managers" column. */
  extraColumn?: { label: string; width: number; render: (r: RecordRow) => React.ReactNode };
  /** Decoupled from `useStore()` so this component works against either the
   * prototype's in-memory store or the real app's server-backed data —
   * "evolve, don't restart" (MODULE-2-PLAN's own build-order framing). */
  grantFor: (field: Field) => 'hidden' | 'view' | 'edit';
  hasCustomColumnOrder: boolean;
  onReorderColumns: (orderedFieldIds: string[]) => void;
  onResetColumnOrder: () => void;
  /** Durable per user per module — 19 Aug amendment §4. */
  filters: Record<string, Filter>;
  /**
   * Fields a filter may name that are NOT columns.
   *
   * A pipeline's synced Status field is a real field with real choices, but it
   * is not on the dashboard unless an admin adds it, while the pipeline filter
   * can set a filter on it from the toolbar. Without this the chip for that
   * filter fell through to "Filter on a hidden column", which is the wording
   * for a filter the viewer has lost access to — a different and alarming
   * thing. Used only to LABEL a chip; it adds no column and grants nothing.
   */
  filterOnlyFields?: Field[];
  onSetFilters: (filters: Record<string, Filter>) => void;
  onClearFilters: () => void;
  /**
   * Commit one edited cell. OMITTED = the table is read-only exactly as it has
   * always been, which is what keeps the prototype (no server, no CAS token)
   * rendering unchanged.
   *
   * Resolves `{ ok: false, message }` on a refusal — a lost compare-and-swap,
   * or a permission the server disagreed with — and the cell rolls back.
   */
  onCellEdit?: (
    recordId: string,
    field: Field,
    value: FieldValue,
  ) => Promise<{ ok: boolean; message?: string }>;
  /**
   * The columns whose value is a PIPELINE STEP, keyed by the field's key.
   *
   * ── WHY THESE CANNOT GO THROUGH `onCellEdit` ────────────────────────────
   * A pipeline's synced Status field looks like any other status column and
   * is not one. Its value is a projection of `record_pipelines`, it is marked
   * read-only, and both `assertWritable` and the database refuse a direct
   * write to it — deliberately, because a projection with two writers drifts.
   * So the column was excluded from cell editing altogether and the step could
   * only be changed by opening the record and using the pipeline bar.
   *
   * It is editable from the table now, through the pipeline's OWN writer
   * (`set_pipeline_step`) rather than by relaxing the rule that protects it.
   * That is why this is a separate prop and a separate handler: the thing
   * being written is genuinely different, and saying so here is what stops
   * someone later "simplifying" it into the value path.
   *
   * Keyed by field key and supplied by the caller, so no module is named in
   * code (CLAUDE.md rule 1) — a seventh module with a pipeline needs nothing
   * here.
   */
  pipelineColumns?: Record<
    string,
    { pipelineId: string; steps: { id: string; label: string; swatch: Swatch }[] }
  >;
  /** Move one record to one step. Resolves `{ ok: false, message }` on a
   *  refusal, and the cell rolls back. Omitted = the column stays read-only. */
  onPipelineStep?: (
    recordId: string,
    pipelineId: string,
    stepId: string,
  ) => Promise<{ ok: boolean; message?: string }>;
};

/**
 * One dashboard cell whose value is picked from a short, closed list.
 *
 * Used by the two columns people change most from the dashboard: the pipeline
 * step and Current Status. They write through completely different paths —
 * the step through the pipeline's own writer, a status through the ordinary
 * value path — so the WRITER is a prop and everything else is shared. Two
 * copies of this would be two chances for the two columns to start behaving
 * differently for no reason anyone chose.
 *
 * ── OPENED ON A SINGLE CLICK, UNLIKE `EditableCell` ──────────────────────
 * `EditableCell` needs a pencil or a double-click because it holds free text
 * a stray click could overwrite. This offers a closed list with the current
 * value already ticked, so an accidental open costs one Escape. These are
 * also the most repeated edits on the screen, and the client asked for both
 * by name.
 *
 * ⚠️ EVERY HANDLER STOPS PROPAGATION, for the reason `EditableCell` gives:
 * this sits inside the `<tr>` that opens the drawer, so without it a click on
 * an option would also open the record on the way past.
 */
function PillMenu({
  field,
  value,
  moduleSlug,
  options,
  title,
  onPick,
}: {
  field: Field;
  value: FieldValue;
  moduleSlug: string;
  /** In the order they should be offered. `key` is what gets stored. */
  options: { key: string; label: string; swatch?: Swatch }[];
  /** What the trigger says it does, e.g. "Change the pipeline step". */
  title: string;
  onPick: (key: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentKey = typeof value === 'string' ? value : null;

  const choose = async (key: string) => {
    setOpen(false);
    if (key === currentKey) return;
    setBusy(true);
    setError(null);
    const result = await onPick(key);
    setBusy(false);
    if (!result.ok) setError(result.message ?? 'Could not save that.');
  };

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        title={error ?? title}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`group/pill flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-canvas ${
          error ? 'ring-1 ring-bad/40' : ''
        }`}
      >
        <span className="min-w-0 truncate">
          <CellValue field={field} value={value} moduleSlug={moduleSlug} />
        </span>
        {busy ? (
          <span aria-hidden className="inline-block shrink-0 text-[10px] leading-none">
            <Spinner />
          </span>
        ) : error ? (
          <Icon name="alert-triangle" size={11} className="shrink-0 text-bad" />
        ) : (
          /* Visible on hover and on keyboard focus, so the column does not
             carry a chevron on every row of every page. */
          <span
            aria-hidden
            className="shrink-0 text-ink-300 opacity-0 transition-opacity group-hover/pill:opacity-100 group-focus-visible/pill:opacity-100"
          >
            <Icon name="chevron-down" size={11} />
          </span>
        )}
      </button>

      <MenuSurface
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        align="left"
        width={240}
        label={title}
      >
        <div onClick={(e) => e.stopPropagation()}>
          {options.map((o) => {
            const on = o.key === currentKey;
            return (
              <button
                key={o.key}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                onClick={(e) => {
                  e.stopPropagation();
                  void choose(o.key);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-canvas ${
                  on ? 'bg-canvas' : ''
                }`}
              >
                <span className="w-3.5 shrink-0 text-brand-700">
                  {on ? <Icon name="check" size={12} strokeWidth={3} /> : null}
                </span>
                <StatusPill label={o.label} swatch={o.swatch} />
              </button>
            );
          })}
        </div>
      </MenuSurface>
    </span>
  );
}

/**
 * One dashboard cell that can be edited in place.
 *
 * ── HOW IT IS OPENED, AND WHY NOT ON A SINGLE CLICK ──────────────────────
 * A single click on a row already opens the record drawer, and has since this
 * table existed. Making a single click on a cell edit it instead would either
 * take the drawer away from twelve of the thirteen columns or leave the two
 * gestures fighting over the same event. So editing is deliberately a SECOND,
 * more specific gesture: the pencil that appears on hover, or a double-click on
 * the cell. Everyone's existing muscle memory for opening a record is untouched.
 *
 * ⚠️ EVERY HANDLER IN HERE STOPS PROPAGATION. The editor lives inside the `<tr>`
 * that carries `onClick={() => onOpen(r.id)}`, so without that a click on a
 * dropdown option, or on the pencil itself, would open the drawer on the way
 * past and unmount the editor mid-edit.
 *
 * ── WHY IT IS FAST ───────────────────────────────────────────────────────
 * The commit is optimistic: the new value paints immediately, the row's token
 * advances from what the server returns, and nothing waits on a page
 * revalidation. A rejected write rolls the cell back and says why. This is the
 * same bargain `RealFieldGrid` already makes in the drawer, for the same
 * reason — a value the user just typed should not take a round trip to appear.
 */
function EditableCell({
  row,
  field,
  value,
  moduleSlug,
  editable,
  onCommit,
}: {
  row: RecordRow;
  field: Field;
  value: FieldValue;
  moduleSlug: string;
  /** False renders exactly what a read-only cell has always rendered. */
  editable: boolean;
  onCommit: NonNullable<DataTableProps['onCellEdit']>;
}) {
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  if (!editable) {
    return (
      <span className="min-w-0 truncate">
        <CellValue field={field} value={value} moduleSlug={moduleSlug} />
      </span>
    );
  }

  /**
   * Commit, shared by the three shapes below. Identical in each; written once
   * so a change to the optimistic bargain cannot reach only two of them.
   */
  const commit = (next: FieldValue) => {
    setError(null);
    // Unchanged value, no round trip. Re-opening a cell and tabbing straight
    // out is the commonest way to touch one by accident.
    if (JSON.stringify(next ?? null) === JSON.stringify(value ?? null)) {
      return Promise.resolve({ ok: true } as { ok: boolean; message?: string });
    }
    setState('saving');
    return onCommit(row.id, field, next).then((result) => {
      if (result.ok) {
        setState('saved');
        window.setTimeout(() => setState('idle'), 900);
      } else {
        setState('idle');
        setError(result.message ?? 'Could not save.');
      }
      return result;
    });
  };

  /*
   * ── A STATUS IS PICKED, NOT TYPED ───────────────────────────────────────
   * It was a pencil, then a <select> opened inside the cell. A status is a
   * short closed list and the single most changed column on the screen after
   * the pipeline step, so it gets the same one-click pill menu the step got,
   * which is what the client asked for — "add same dropdown as deal status
   * dropdown in current status dropdown".
   *
   * Only when there ARE options: a status field whose choices an admin has
   * not configured yet would otherwise open an empty menu, and the pencil at
   * least lets someone see the raw value.
   */
  const statusOptions =
    field.type === 'status'
      ? choicesFor(field, moduleSlug).map((c) => ({
          key: choiceKey(c),
          /* `Choice.value` IS the display label; `key` is what is stored.
             See `choiceKey` on why the two are deliberately separate. */
          label: c.value,
          swatch: c.swatch,
        }))
      : [];

  if (statusOptions.length) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className={`flex min-w-0 flex-1 ${state === 'saving' ? 'opacity-45' : ''}`}>
          <PillMenu
            field={field}
            value={value}
            moduleSlug={moduleSlug}
            options={statusOptions}
            title={`Change ${field.label}`}
            onPick={(key) => commit(key)}
          />
        </span>
        <StateSlot state={state} error={error} onRetry={() => setError(null)} />
      </span>
    );
  }

  /*
   * ── TEAM MEMBERS NEVER EXPAND IN PLACE ──────────────────────────────────
   * `FieldRenderer`'s team control wraps its chips onto as many rows as the
   * team needs. That is right in a drawer and impossible in a 40px cell: with
   * three people assigned, opening the editor pushed three stacked chips and
   * the add control out of the row and over the records underneath. Reported
   * with a screenshot of exactly that.
   *
   * `compact` renders the same control as one avatar stack that opens its
   * panel, and the panel is a checklist of the whole roster — so adding,
   * removing and seeing who is on all still work, in a cell that cannot
   * change height. There is no `editing` state here at all: the panel IS the
   * editor, so a pencil would just be a second click before the same thing.
   */
  if (field.type === 'team_member') {
    return (
      <span
        className="flex min-w-0 flex-1 items-center gap-1"
        onClick={stop}
        onDoubleClick={stop}
        onKeyDown={stop}
      >
        <span className={`flex min-w-0 flex-1 ${state === 'saving' ? 'opacity-45' : ''}`}>
          <FieldRenderer
            field={field}
            value={value}
            grant="edit"
            moduleSlug={moduleSlug}
            compact
            onChange={(next) => void commit(next)}
          />
        </span>
        <StateSlot state={state} error={error} onRetry={() => setError(null)} />
      </span>
    );
  }

  if (editing) {
    return (
      <span
        className="relative block w-full"
        onClick={stop}
        onDoubleClick={stop}
        onKeyDown={stop}
      >
        {/*
          ⚠️ `autoEdit` is what makes the pencil a ONE-click gesture.

          Without it `FieldRenderer` opens in its read state — a button showing
          the current value — so the click that said "edit this" only got you a
          control you then had to click again. It also selects the existing
          text, so typing replaces the old value instead of appending to it.

          Enter commits and Escape abandons; both live in `FieldRenderer` so the
          drawer gets them too.
        */}
        <FieldRenderer
          field={field}
          value={value}
          grant="edit"
          moduleSlug={moduleSlug}
          autoEdit
          onCancel={() => setEditing(false)}
          onChange={(next) => {
            setEditing(false);
            void commit(next);
          }}
        />
      </span>
    );
  }

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <span
        className={`min-w-0 flex-1 truncate transition-opacity ${state === 'saving' ? 'opacity-45' : ''}`}
        onDoubleClick={(e) => {
          stop(e);
          setError(null);
          setEditing(true);
        }}
        title={error ?? 'Double-click to edit'}
      >
        <CellValue field={field} value={value} moduleSlug={moduleSlug} />
      </span>

      <StateSlot
        state={state}
        error={error}
        onRetry={() => {
          setError(null);
          setEditing(true);
        }}
      />
      {state === 'idle' && !error ? (
        <button
          type="button"
          aria-label={`Edit ${field.label}`}
          title={`Edit ${field.label}`}
          tabIndex={-1}
          onClick={(e) => {
            stop(e);
            setEditing(true);
          }}
          onDoubleClick={stop}
          className="grid size-5 shrink-0 place-items-center rounded text-ink-300 opacity-0 transition-[opacity,color] hover:bg-white hover:text-brand-700 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Icon name="pencil" size={11} />
        </button>
      ) : null}
    </span>
  );
}

/**
 * One slot, three states, fixed width — so a row does not reflow as a value
 * saves. Saving and saved are transient; an error persists until the cell is
 * touched again, because a failed write is the one outcome the user has to be
 * able to come back to.
 *
 * Shared by all three cell shapes. It used to be written inline in the only
 * one that existed; a second and third copy would be three places to keep the
 * same three states looking the same.
 */
function StateSlot({
  state,
  error,
  onRetry,
}: {
  state: 'idle' | 'saving' | 'saved';
  error: string | null;
  onRetry: () => void;
}) {
  if (state === 'saving') return <Spinner className="shrink-0" />;
  if (state === 'saved') {
    return <Icon name="check" size={12} strokeWidth={2.6} className="shrink-0 animate-settle text-ok" />;
  }
  if (error) {
    return (
      <button
        type="button"
        title={`${error} — click to try again`}
        aria-label={`${error}. Try again`}
        onClick={(e) => {
          e.stopPropagation();
          onRetry();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="grid size-5 shrink-0 place-items-center rounded text-bad transition-colors hover:bg-white"
      >
        <Icon name="alert-triangle" size={12} />
      </button>
    );
  }
  return null;
}

export function DataTable({
  moduleSlug,
  rows,
  columns,
  onOpen,
  onOpenMention,
  serverPaging,
  tableBusy,
  openingId,
  selected,
  onSelectedChange,
  extraColumn,
  grantFor,
  hasCustomColumnOrder,
  onReorderColumns,
  onResetColumnOrder,
  filters,
  filterOnlyFields,
  onSetFilters,
  onClearFilters,
  onCellEdit,
  pipelineColumns,
  onPipelineStep,
}: DataTableProps) {

  const [page, setPage] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  /*
   * Column drag — 19 Aug amendment, "order only." @dnd-kit (per MODULE-2-PLAN
   * Stage 4: "accessible — keyboard reorder, screen-reader announcements —
   * actively maintained, no legacy-React baggage"). The arrow-button fallback
   * on each header is kept alongside it — dragging is never the ONLY way to
   * reorder, and dnd-kit's own keyboard mode (Tab to focus, Space to lift,
   * arrows to move, Space to drop) needs Tab-focus first, which is less
   * discoverable than an always-visible button.
   */
  const moveColumn = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = columns.map((c) => c.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    onReorderColumns(ids);
  };

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleColumnDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) moveColumn(String(active.id), String(over.id));
  };

  const gridRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const barInnerRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  /*
   * Filters change the result set, so page 5 may no longer exist. Reset during
   * render rather than in an effect — React re-runs this component before
   * touching the DOM, so there is no flash of the wrong page and no second
   * commit. (react.dev: "adjusting state when props change".)
   */
  const resultKey = `${moduleSlug}|${JSON.stringify(filters)}`;
  const [lastResultKey, setLastResultKey] = useState(resultKey);
  if (resultKey !== lastResultKey) {
    setLastResultKey(resultKey);
    setPage(0);
  }

  const filtered = useMemo(() => {
    // With server paging the rows handed in are ALREADY the filtered page —
    // re-applying the predicate here could only disagree with the server and
    // blank out rows it deliberately returned.
    if (serverPaging) return rows;
    const active = Object.values(filters);
    if (!active.length) return rows;
    return rows.filter((r) =>
      active.every((fl) => {
        const field = columns.find((c) => c.id === fl.fieldId);
        return field ? matches(r, fl, field) : true;
      }),
    );
  }, [rows, filters, columns, serverPaging]);

  const pageCount = serverPaging
    ? Math.max(1, serverPaging.pageCount)
    : Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE));
  // Clamped in BOTH modes. A hand-edited `?page=99`, or a page that outlives
  // the filter change that shrank the result set, must not leave the pager
  // pointing past the end with every control disabled.
  const safePage = Math.min(serverPaging ? serverPaging.page : page, pageCount - 1);
  const pageRows = serverPaging
    ? filtered
    : filtered.slice(safePage * ROWS_PER_PAGE, (safePage + 1) * ROWS_PER_PAGE);

  /* --- the sticky horizontal scrollbar ---------------------------------- */

  const totalWidth =
    CHECKBOX_WIDTH +
    DEAL_NAME_WIDTH +
    columns.reduce((sum, c) => sum + (c.width ?? 160), 0) +
    (extraColumn?.width ?? 0);

  /**
   * The overlay bar is as wide as the grid REALLY is, measured.
   *
   * ⚠️ THIS USED `totalWidth`, AND THAT IS WHY THE BAR STOPPED SHORT.
   *
   * `totalWidth` is a sum of DECLARED widths — `c.width ?? 160` per column
   * plus two constants. The rendered grid is wider than that sum: cells carry
   * horizontal padding and borders, and a column whose content will not fit
   * in its declared width is stretched by the layout. So the bar's track was
   * consistently shorter than the grid's `scrollWidth`, and dragging it to
   * its own end left the grid several columns short of its end — the last
   * column could not be reached at all, which is exactly what it looked like.
   *
   * Measuring removes the guess. `scrollWidth` is the number the browser
   * actually scrolls to, so the two cannot disagree by construction, and it
   * keeps working when a column is resized, added, filtered away, or when
   * content changes the layout — none of which `totalWidth` could see.
   *
   * The observer watches the grid's CHILD as well as the grid: resizing the
   * viewport changes the grid's own box, but changing the columns changes
   * only the content inside it.
   */
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const inner = barInnerRef.current;
    if (!grid || !inner) return;

    const sync = () => {
      /* Fall back to the declared sum only if measurement is unavailable,
         which keeps a server-rendered first paint sane. */
      inner.style.width = `${grid.scrollWidth || totalWidth}px`;
    };
    sync();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(grid);
    const content = grid.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [totalWidth, columns.length, pageRows.length]);

  const onGridScroll = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    setScrolled(grid.scrollLeft > 0);
    if (syncing.current) return;
    syncing.current = true;
    if (barRef.current) barRef.current.scrollLeft = grid.scrollLeft;
    syncing.current = false;
  }, [setScrolled]);

  const onBarScroll = useCallback(() => {
    if (syncing.current) return;
    syncing.current = true;
    if (gridRef.current && barRef.current) gridRef.current.scrollLeft = barRef.current.scrollLeft;
    syncing.current = false;
  }, []);

  /* --- selection -------------------------------------------------------- */

  const allOnPageSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const toggleAll = () => {
    const next = new Set(selected);
    if (allOnPageSelected) pageRows.forEach((r) => next.delete(r.id));
    else pageRows.forEach((r) => next.add(r.id));
    onSelectedChange(next);
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  const activeFilters = Object.values(filters);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05),0_8px_24px_-16px_rgba(8,32,47,.18)]">
      {/* Personalized column order — 19 Aug amendment: order only, per user,
          reset re-adopts the admin's order (live). */}
      {hasCustomColumnOrder ? (
        <div className="flex items-center gap-2 border-b border-line bg-brand-50/60 px-4 py-1.5">
          <Icon name="shuffle" size={12} className="text-brand-600" />
          <span className="text-[12px] text-brand-700">
            You&rsquo;ve reordered these columns — only you see this order.
          </span>
          <button
            type="button"
            onClick={onResetColumnOrder}
            className="ml-auto text-[12px] font-semibold text-brand-700 hover:underline"
          >
            Reset to default
          </button>
        </div>
      ) : null}

      {/* Active filter chips */}
      {activeFilters.length ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-white px-4 py-2">
          {activeFilters.map((fl) => {
            /*
             * ⚠️ NOT `columns.find(...)!`. Filters are saved server-side and
             * outlive the column list they were made against: an admin can drop
             * the column from the module, or this viewer's grant on that field
             * can fall to Hidden, and `columns` has been through both the admin
             * list and the per-viewer grant strip. The non-null assertion made
             * `filterSummary` dereference `undefined` and throw on RENDER — so
             * the module page crashed on every load, and the two controls that
             * could have cleared the filter ("Clear all" and this chip) were
             * both inside the subtree that crashed. The filter lives on the
             * server, so reloading did not help either. It was unrecoverable
             * without a database edit.
             *
             * A filter whose field is gone still applies server-side, so it is
             * shown as a removable chip rather than hidden — a silently dropped
             * chip would leave the list quietly filtered with nothing on screen
             * saying so.
             */
            const field =
              columns.find((c) => c.id === fl.fieldId) ??
              filterOnlyFields?.find((c) => c.id === fl.fieldId);
            return (
              <button
                key={fl.fieldId}
                type="button"
                title={field ? undefined : 'This column is no longer available to you. Remove the filter to see every record again.'}
                onClick={() => {
                  const next = { ...filters };
                  delete next[fl.fieldId];
                  onSetFilters(next);
                }}
                className="inline-flex items-center gap-1.5 rounded-full border border-brand-100 bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700 transition-colors hover:bg-brand-100"
              >
                {field ? filterSummary(fl, field, moduleSlug) : <span className="italic">Filter on a hidden column</span>}
                <Icon name="x" size={11} strokeWidth={2.2} className="text-brand-700/60" />
              </button>
            );
          })}
          <button
            type="button"
            onClick={onClearFilters}
            className="ml-1 text-[12.5px] font-semibold text-ink-500 hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {/* The grid */}
      <div
        ref={gridRef}
        onScroll={onGridScroll}
        aria-busy={tableBusy || undefined}
        className={`min-h-0 flex-1 overflow-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${
          tableBusy ? 'pointer-events-none opacity-55 transition-opacity duration-150' : 'transition-opacity duration-150'
        }`}
      >
        <DndContext
          id={`col-dnd-${moduleSlug}`}
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleColumnDragEnd}
        >
        <table
          className="border-separate border-spacing-0 text-[13.5px]"
          style={{ width: totalWidth, minWidth: '100%' }}
        >
          <thead>
            <tr>
              <th
                className="sticky left-0 top-0 z-30 border-b border-line bg-canvas px-3 py-2.5"
                style={{ width: CHECKBOX_WIDTH, minWidth: CHECKBOX_WIDTH }}
              >
                <input
                  type="checkbox"
                  aria-label="Select all rows on this page"
                  checked={allOnPageSelected}
                  onChange={toggleAll}
                  className="size-3.5 accent-[#1d4ed8]"
                />
              </th>

              {/* Deal Name — frozen, and the only hardcoded column */}
              <th
                className={`sticky top-0 z-30 border-b border-line bg-canvas text-left ${
                  scrolled ? 'shadow-[4px_0_8px_-4px_rgba(8,32,47,.16)]' : ''
                }`}
                style={{
                  left: CHECKBOX_WIDTH,
                  width: DEAL_NAME_WIDTH,
                  minWidth: DEAL_NAME_WIDTH,
                }}
              >
                <div className="px-3 py-2.5 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-500">
                  Deal Name
                </div>
              </th>

              {/* DndContext itself lives OUTSIDE the table (see below) — it
                  injects an accessibility live-region div as a sibling of
                  wherever it's rendered, which is invalid HTML directly
                  inside a <tr>. SortableContext has no such DOM output of
                  its own, so it stays here, right where the sortable items
                  are. */}
              <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
                  {columns.map((col, i) => (
                    <SortableColumnHeader key={col.id} id={col.id} width={col.width ?? 160}>
                      {(handle) => (
                      <div className="flex items-start">
                        {/* Keyboard-reachable fallback — dragging is never the
                            only way to move a column. */}
                        <span className="flex shrink-0 flex-col pt-2">
                          <button
                            type="button"
                            disabled={i === 0}
                            title="Move column left"
                            aria-label={`Move ${col.label} earlier`}
                            onClick={() => moveColumn(col.id, columns[i - 1]!.id)}
                            className="grid size-4 cursor-grab place-items-center rounded text-ink-300 opacity-0 transition-opacity hover:bg-canvas hover:text-ink-500 focus-visible:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 active:cursor-grabbing"
                          >
                            <Icon name="chevron-left" size={10} />
                          </button>
                          <button
                            type="button"
                            title="Drag to reorder"
                            aria-label={`Reorder ${col.label}`}
                            {...handle.attributes}
                            {...handle.listeners}
                            className="grid size-4 cursor-grab place-items-center rounded text-ink-300 opacity-0 transition-opacity hover:bg-canvas hover:text-ink-500 group-hover:opacity-100 active:cursor-grabbing"
                          >
                            <Icon name="shuffle" size={10} />
                          </button>
                        </span>
                        <div className="min-w-0 flex-1">
                          <ColumnHeader
                            field={col}
                            rows={rows}
                            moduleSlug={moduleSlug}
                            filter={filters[col.id]}
                            onChange={(f) => {
                              const next = { ...filters };
                              if (f) next[col.id] = f;
                              else delete next[col.id];
                              onSetFilters(next);
                            }}
                          />
                        </div>
                        <span className="flex shrink-0 flex-col pt-2">
                          <button
                            type="button"
                            disabled={i === columns.length - 1}
                            title="Move column right"
                            aria-label={`Move ${col.label} later`}
                            onClick={() => moveColumn(col.id, columns[i + 1]!.id)}
                            className="grid size-4 cursor-grab place-items-center rounded text-ink-300 opacity-0 transition-opacity hover:bg-canvas hover:text-ink-500 focus-visible:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 active:cursor-grabbing"
                          >
                            <Icon name="chevron-right" size={10} />
                          </button>
                        </span>
                      </div>
                      )}
                    </SortableColumnHeader>
                  ))}
              </SortableContext>

              {extraColumn ? (
                <th
                  className="sticky top-0 z-20 border-b border-line bg-canvas text-left"
                  style={{ width: extraColumn.width, minWidth: extraColumn.width }}
                >
                  <div className="flex items-center gap-1.5 px-3 py-2.5 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-500">
                    {extraColumn.label}
                    <Icon
                      name="lock"
                      size={11}
                      aria-label="System column — auto-populated, not configurable"
                    />
                  </div>
                </th>
              ) : null}
            </tr>
          </thead>

          <tbody>
            {pageRows.map((r, rowIndex) => {
              const isSelected = selected.has(r.id);
              const archived = r.memberships.length === 0;
              // Fully opaque, never translucent — the checkbox and Deal Name
              // cells are `sticky` (other rows' content scrolls underneath
              // them horizontally), so any alpha here lets that content
              // bleed through on hover/selection instead of looking solid.
              const opening = openingId === r.id;
              // The opening row gets the selected tone for the whole wait, so
              // the feedback is a visible change of state rather than only a
              // subtle pulse.
              const cellTone = isSelected || opening ? 'bg-brand-100' : 'bg-white group-hover:bg-brand-50';
              return (
                <tr
                  key={r.id}
                  aria-busy={opening || undefined}
                  /* The stagger index. Capped in CSS at ten steps, so a
                     fifty-row page still finishes settling in under a fifth of
                     a second rather than dealing itself out past the fold. */
                  style={{ '--row-index': rowIndex } as React.CSSProperties}
                  className={`group animate-row-in cursor-pointer outline-none transition-colors focus-visible:bg-brand-50 ${
                    opening ? 'animate-pulse' : ''
                  }`}
                  tabIndex={0}
                  onClick={() => onOpen(r.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(r.id);
                    }
                  }}
                >
                  <td
                    className={`relative sticky left-0 z-10 border-b border-line-faint px-3 py-0 transition-colors ${cellTone}`}
                    style={{ width: CHECKBOX_WIDTH }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* The same left marker the sidebar uses for its active
                        item. On a table this wide, a background tint alone is
                        easy to lose track of once you have scrolled sideways
                        away from the frozen columns. */}
                    <span
                      aria-hidden
                      className={`absolute inset-y-0 left-0 w-[3px] origin-top scale-y-0 bg-brand-600 transition-transform duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-y-100 ${
                        isSelected || opening ? 'scale-y-100' : ''
                      }`}
                    />
                    <div className="flex h-11 items-center">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.dealName}`}
                        checked={isSelected}
                        onChange={() => toggleOne(r.id)}
                        className="size-3.5 accent-[#1d4ed8]"
                      />
                    </div>
                  </td>

                  {/* Frozen primary column. Opaque background so rows scrolling
                      beneath it never bleed through. */}
                  <td
                    className={`sticky z-10 border-b border-line-faint p-0 ${cellTone} ${scrolled ? 'shadow-[4px_0_8px_-4px_rgba(8,32,47,.16)]' : ''}`}
                    style={{ left: CHECKBOX_WIDTH, width: DEAL_NAME_WIDTH }}
                  >
                    <div className="relative flex h-10 items-center gap-2 px-3">
                      {isSelected ? (
                        <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-brand-600" />
                      ) : null}
                      <span className="truncate font-semibold text-ink-900 group-hover:text-brand-700 group-hover:underline">
                        {r.dealName}
                      </span>
                      {archived && moduleSlug === 'records' ? (
                        <OutlineChip icon="archive">Archived</OutlineChip>
                      ) : null}
                      {r.mentions ? (
                        /* Only the viewer's own unread mentions — the count
                           came from a query keyed on them. Clicking lands on
                           the oldest one. */
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            (onOpenMention ?? onOpen)(r.id);
                          }}
                          title={`${r.mentions} unread mention${r.mentions === 1 ? '' : 's'} for you — open`}
                          aria-label={`${r.mentions} unread mention${r.mentions === 1 ? '' : 's'} for you — open`}
                          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-brand-600 px-1.5 py-px text-[10.5px] font-bold tabular text-white hover:bg-brand-700"
                        >
                          <Icon name="at-sign" size={9} strokeWidth={2.5} />
                          {r.mentions}
                        </button>
                      ) : null}
                    </div>
                  </td>

                  {columns.map((col) => {
                    const readOnly = grantFor(col) === 'view';
                    /*
                     * A cell is editable only when EVERY one of these holds.
                     * Each exclusion is a real rule, not caution:
                     *
                     *   * a handler exists — absent in the prototype, which has
                     *     no server and no token to swap against;
                     *   * the row carries `updatedAt` — no token, no safe write;
                     *   * the viewer holds Edit on this field;
                     *   * the field is not marked read-only. That covers the
                     *     pipeline-synced Status fields, whose value is a
                     *     projection of `record_pipelines` and which the
                     *     database refuses to be written directly anyway;
                     *   * it is not Deal Name. That is the duplicate-blocking
                     *     key with its own refusal rules, it lives outside
                     *     `values`, and it is rendered by the frozen column
                     *     above rather than here.
                     */
                    const cellEditable = Boolean(
                      onCellEdit
                        && r.updatedAt
                        && !readOnly
                        && !col.readOnly
                        && col.id !== 'deal_name',
                    );
                    /*
                     * A pipeline-backed Status column is editable on its own
                     * terms: `cellEditable` is false for it (the field is
                     * read-only, and rightly so), but the STEP can still be
                     * changed through the pipeline's own writer. See
                     * `pipelineColumns` on the props above for why that is a
                     * separate path and not a relaxation of this one.
                     */
                    const pipe = pipelineColumns?.[col.id];
                    /*
                     * ⚠️ `readOnly` IS DELIBERATELY NOT PART OF THIS TEST.
                     *
                     * It is `grantFor(col) === 'view'`, and for this column it
                     * is ALWAYS true: `grantRules.ts` caps a read-only field's
                     * grant to View (`if (caps.readOnly) return g === 'edit' ?
                     * 'view' : g`), and the pipeline's synced Status field is
                     * read-only for everyone including admins. Including it
                     * here means the picker never appears for anybody, which
                     * is exactly what the first version of this did.
                     *
                     * The field grant is the wrong question regardless. It
                     * governs writing the FIELD, which nobody may do. What is
                     * being written is the pipeline assignment, and the
                     * permission for that is the module's — which the caller
                     * applies by withholding `pipelineColumns` entirely. That
                     * matches the drawer's pipeline bar, which carries no
                     * field gate either, and the real boundary is unchanged
                     * in both cases: `set_pipeline_step` and RLS.
                     */
                    const stepEditable = Boolean(pipe && onPipelineStep && r.updatedAt);

                    return (
                      <td
                        key={col.id}
                        className={`border-b border-line-faint ${cellTone}`}
                        style={{ width: col.width ?? 160 }}
                      >
                        <div
                          className={`flex h-10 items-center px-3 ${
                            isNumeric(col.type) ? 'justify-end' : ''
                          } ${readOnly ? 'text-ink-400' : 'text-ink-700'}`}
                        >
                          {stepEditable ? (
                            <PillMenu
                              field={col}
                              value={r.values[col.id]}
                              moduleSlug={moduleSlug}
                              options={pipe!.steps.map((st) => ({
                                key: st.id,
                                label: st.label,
                                swatch: st.swatch,
                              }))}
                              title="Change the pipeline step"
                              onPick={(stepId) => onPipelineStep!(r.id, pipe!.pipelineId, stepId)}
                            />
                          ) : cellEditable ? (
                            <EditableCell
                              row={r}
                              field={col}
                              value={col.id === 'deal_name' ? r.dealName : r.values[col.id]}
                              moduleSlug={moduleSlug}
                              editable
                              onCommit={onCellEdit!}
                            />
                          ) : (
                          <span className="min-w-0 truncate">
                            {/* `moduleSlug` is not optional in practice: without
                                it `CellValue` resolves choices against the
                                GLOBAL set, so any module with its own options
                                (Leads' statuses, say) matches nothing — every
                                status and dropdown cell falls back to printing
                                its raw stored key with a neutral dot. The
                                drawer and header strip always passed it; this
                                table did not. */}
                            <CellValue
                              field={col}
                              value={col.id === 'deal_name' ? r.dealName : r.values[col.id]}
                              moduleSlug={moduleSlug}
                            />
                          </span>
                          )}
                        </div>
                      </td>
                    );
                  })}

                  {extraColumn ? (
                    <td className={`border-b border-line-faint ${cellTone}`} style={{ width: extraColumn.width }}>
                      <div className="flex h-10 items-center px-3" onClick={(e) => e.stopPropagation()}>
                        {extraColumn.render(r)}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}

            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 2} className="px-4 py-16">
                  {/* An empty result is a dead end unless it offers the way
                      out. When filters are the cause, the fix is one click
                      away and belongs here rather than back up in the chip
                      row the reader has already scrolled past. */}
                  <div className="animate-settle mx-auto max-w-xs text-center">
                    <div className="mx-auto grid size-11 place-items-center rounded-full bg-canvas text-ink-300">
                      <Icon name={activeFilters.length ? 'filter' : 'database'} size={20} />
                    </div>
                    <p className="mt-3 text-[14px] font-semibold text-ink-700">
                      {activeFilters.length ? 'No records match these filters' : 'Nothing here yet'}
                    </p>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink-400">
                      {activeFilters.length
                        ? `${activeFilters.length} filter${activeFilters.length === 1 ? ' is' : 's are'} narrowing this list.`
                        : 'This module has no records you can see.'}
                    </p>
                    {activeFilters.length ? (
                      <button
                        type="button"
                        onClick={onClearFilters}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink-700 transition-colors hover:border-brand-600/50 hover:text-brand-700"
                      >
                        <Icon name="x" size={12} />
                        Clear all filters
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        </DndContext>
      </div>

      {/* Sticky horizontal scrollbar — pinned here, not at the bottom of 50 rows */}
      <div
        ref={barRef}
        onScroll={onBarScroll}
        className="h-3 shrink-0 overflow-x-auto overflow-y-hidden border-t border-line bg-white"
      >
        <div ref={barInnerRef} className="h-px" />
      </div>

      {/* Pagination */}
      <Pagination
        page={safePage}
        pageCount={pageCount}
        total={serverPaging ? serverPaging.total : filtered.length}
        onPage={serverPaging ? serverPaging.onPage : setPage}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination — 1 2 3 4 5 … 26, with the middle collapsed                       */
/* -------------------------------------------------------------------------- */

function Pagination({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = useMemo(() => {
    if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);
    const out: (number | '…')[] = [0];
    const from = Math.max(1, page - 1);
    const to = Math.min(pageCount - 2, page + 1);
    if (from > 1) out.push('…');
    for (let i = from; i <= to; i++) out.push(i);
    if (to < pageCount - 2) out.push('…');
    out.push(pageCount - 1);
    return out;
  }, [page, pageCount]);

  return (
    <div className="flex shrink-0 items-center justify-between gap-4 border-t border-line bg-canvas/70 px-4 py-2.5">
      <p className="text-[12.5px] text-ink-500 tabular">
        <span className="font-semibold text-ink-700">{total.toLocaleString()}</span> {total === 1 ? 'record' : 'records'}
        <span className="mx-1.5 text-line">·</span>
        50 per page
      </p>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          icon="chevron-left"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          Prev
        </Button>
        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`gap${i}`} className="px-1 text-ink-400">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPage(p)}
              className={`min-w-[28px] rounded-md px-2 py-1 text-[12.5px] font-semibold tabular transition-colors duration-150 ${
                p === page ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-canvas'
              }`}
            >
              {p + 1}
            </button>
          ),
        )}
        <Button
          size="sm"
          variant="ghost"
          iconRight="chevron-right"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Bulk action bar + skip report                                               */
/* -------------------------------------------------------------------------- */

export function BulkBar({
  count,
  moduleSlug,
  onClear,
  onBulkEdit,
  onArchive,
  onDelete,
  /** Records List only: every selected row is already archived (zero display
   * memberships) — "Archive" again would be a no-op, so the same button slot
   * offers restoring them into a module instead. */
  allSelectedArchived,
  removeAs,
}: {
  count: number;
  moduleSlug: string;
  onClear: () => void;
  onBulkEdit: () => void;
  /** Absent when the viewer may not add records to / remove them from this
   *  module (the `membership` permission): the action is not offered, rather
   *  than offered and refused. */
  onArchive?: () => void;
  onDelete?: () => void;
  allSelectedArchived?: boolean;
  /** A module where membership is automatic (a record is there while a case
   *  is open) offers "Close cases" in the Remove slot; the caller names it. */
  removeAs?: { label: string; title: string; icon: IconName };
}) {
  const isStore = moduleSlug === 'records';
  const showRestore = isStore && allSelectedArchived;
  return (
    <FloatingBar
      open={count > 0}
      onClose={onClear}
      lead={<BarCount n={count} label={count === 1 ? 'record selected' : 'records selected'} />}
    >
      <BarAction icon="pencil" label="Edit" trailing="chevron-down" onClick={onBulkEdit} />
      {/* "Delete" appears in exactly one module. Everywhere else it is Archive. */}
      {onArchive ? (
        <BarAction
          icon={showRestore ? 'rotate-ccw' : removeAs && !isStore ? removeAs.icon : 'archive'}
          label={showRestore ? 'Restore to module' : isStore ? 'Archive' : (removeAs?.label ?? 'Remove')}
          trailing={showRestore ? 'chevron-down' : undefined}
          title={
            showRestore
              ? 'Add these archived records back into a display module.'
              : isStore
                ? 'Clear every display membership. The records stay in the Records List.'
                : (removeAs?.title ?? 'Remove from this module only. Clearing a record’s last membership archives it.')
          }
          onClick={onArchive}
        />
      ) : null}
      {isStore && onDelete ? (
        <BarAction
          icon="trash"
          label="Delete"
          tone="danger"
          title="Only archived records can be deleted"
          onClick={onDelete}
        />
      ) : null}
    </FloatingBar>
  );
}

/**
 * The result of a bulk action.
 *
 * Rows the user could not modify are ALWAYS listed back with a reason. The spec
 * is explicit that they are "reported back to the user, never silently
 * ignored", so the skipped list cannot be dismissed without being seen — the
 * count is on the bar itself, not hidden behind the expander.
 */
export function SkipReportPanel({ report, onClose }: { report: SkipReport; onClose: () => void }) {
  const [expanded, setExpanded] = useState(false);

  // Collapse the detail whenever a new report arrives, so a stale open list
  // never gets mistaken for the new result.
  const key = report ? `${report.done}-${report.skipped.length}` : '';
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setExpanded(false);
  }

  return (
    <FloatingBar
      open={Boolean(report)}
      align="stack"
      onClose={onClose}
      lead={
        <span className="relative flex items-center gap-2 pr-1">
          <StatusPill
            label={`${report?.done ?? 0} updated`}
            swatch={report?.done ? 'teal' : 'slate'}
            dot={false}
          />
          {report?.skipped.length ? (
            <button
              type="button"
              onClick={() => setExpanded((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-full border border-[#f7e0af] bg-[#fdf1d8] px-2.5 py-1 text-[12px] font-semibold text-[#8a5a09] transition-colors hover:bg-[#fbe9c6]"
            >
              <Icon name="alert-triangle" size={11} strokeWidth={2} />
              {report.skipped.length} skipped
              <Icon
                name="chevron-down"
                size={11}
                className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
          ) : null}

          {expanded && report?.skipped.length ? (
            <span className="absolute bottom-[calc(100%+8px)] left-0 right-0 animate-pop-in rounded-xl border border-line bg-white p-3 shadow-[0_16px_40px_-12px_rgba(8,32,47,.35)]">
              <span className="mb-1.5 block text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
                Skipped, and why
              </span>
              <span className="block max-h-48 space-y-1 overflow-y-auto">
                {report.skipped.map((s, i) => (
                  <span key={i} className="flex gap-2 py-0.5 text-[12.5px]">
                    <span className="w-40 shrink-0 truncate font-medium text-ink-700">{s.name}</span>
                    <span className="text-ink-400">{s.reason}</span>
                  </span>
                ))}
              </span>
            </span>
          ) : null}
        </span>
      }
    />
  );
}

export { formatDate };
