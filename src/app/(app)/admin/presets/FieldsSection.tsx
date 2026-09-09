'use client';

/**
 * Admin → Presets, sub-step 2: the field list, create dialog and edit dialog.
 *
 * Two things this UI is deliberately strict about, both because the database
 * is stricter and a form that lets you build an invalid field only moves the
 * error later:
 *
 *   1. The tab picker offers `acceptsFields` tabs only, and the subtab picker
 *      only ever shows the CHOSEN tab's own subtabs. Both are enforced by the
 *      `fields_placement_guard` trigger regardless; filtering here is what
 *      stops an admin composing a placement that can only fail.
 *   2. Key and type are absent from the edit dialog, not disabled in it. They
 *      are shown as locked with the reason, because "why can't I change this"
 *      is the first thing anyone asks.
 */

import { useEffect, useMemo, useRef, useState, useTransition, useActionState } from 'react';
import { Button, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import {
  createFieldAction,
  updateFieldAction,
  archiveFieldAction,
  restoreFieldAction,
  type PresetFormState,
} from './actions';
import { ActionCell, ChipCell, FIELD_GRID, ListHeader, NameCell, PresetRow } from './PresetRow';
import { FIELD_TYPES, GRID_COLUMN_TYPES, REPEAT_MEMBER_TYPES, CHOICE_FIELD_TYPES } from '@/lib/records/adminSchemas';
import type { AdminFieldRow, GridColumn, RepeatMember } from '@/lib/records/adminFields';
import type { AdminTabRow, AdminSubtabRow } from '@/lib/records/adminPresets';

type FieldTypeName = (typeof FIELD_TYPES)[number];

/** Exhaustive by construction — a `field_type` added to the enum without a
 * label here is a compile error, not an option that renders as a raw
 * snake_case string. */
const TYPE_LABELS: Record<FieldTypeName, string> = {
  text: 'Text',
  long_text: 'Long text',
  number: 'Number',
  currency: 'Currency',
  percentage: 'Percentage',
  checkbox: 'Checkbox',
  email: 'Email',
  phone: 'Phone',
  url: 'URL',
  address: 'Address (street/city/state/ZIP)',
  date: 'Date',
  datetime: 'Date and time',
  months: 'Months (multi-select)',
  dropdown: 'Dropdown',
  status: 'Status',
  multi_select: 'Multi-select',
  team_member: 'Team member',
  identifier: 'Identifier (digits, leading zeros kept)',
  file: 'File',
  percent_split: 'Percent split (must total 100%)',
  grid: 'Grid (rows the user adds)',
  repeat_group: 'Repeating group',
};

/** Shared with the choices editor and the data layer rather than restated —
 * this list decided which types the editor offers, so a local copy drifting
 * would mean a field promising options it can never be given (`percent_split`
 * was missing from the copy this replaced). */
const CHOICE_TYPES: readonly FieldTypeName[] = CHOICE_FIELD_TYPES;

const inputClass =
  'mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/20';
const labelClass = 'block text-[12px] font-semibold uppercase tracking-wide text-ink-400';

export function FieldsSection({
  fields,
  tabs,
  subtabs,
}: {
  fields: AdminFieldRow[];
  tabs: AdminTabRow[];
  subtabs: AdminSubtabRow[];
}) {
  const [creating, setCreating] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const [editing, setEditing] = useState<AdminFieldRow | null>(null);
  const [tabFilter, setTabFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  /** Collapsed tab groups, by tab id. Holds the exceptions rather than the
   * expanded set, so a tab that appears later (a new one, or one revealed by
   * changing a filter) starts open rather than mysteriously hidden. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleGroup = (tabId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(tabId)) next.add(tabId);
      return next;
    });

  const fieldTabs = useMemo(() => tabs.filter((t) => t.acceptsFields), [tabs]);
  const tabById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
  const subtabById = useMemo(() => new Map(subtabs.map((s) => [s.id, s])), [subtabs]);

  const live = fields.filter((f) => !f.archivedAt);
  const archivedCount = fields.length - live.length;

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return fields.filter((f) => {
      if (!showArchived && f.archivedAt) return false;
      if (tabFilter && f.tabId !== tabFilter) return false;
      if (!needle) return true;
      return f.label.toLowerCase().includes(needle) || f.key.toLowerCase().includes(needle);
    });
  }, [fields, search, showArchived, tabFilter]);

  /** Grouped tab → subtab, so the list reads the way the drawer is actually
   * laid out rather than as one flat 138-row wall. */
  const groups = useMemo(() => {
    const byTab = new Map<string, AdminFieldRow[]>();
    for (const f of visible) {
      const list = byTab.get(f.tabId);
      if (list) list.push(f);
      else byTab.set(f.tabId, [f]);
    }
    return [...byTab.entries()]
      .map(([tabId, rows]) => ({
        tabId,
        tabLabel: tabById.get(tabId)?.label ?? '(unknown tab)',
        rows: [...rows].sort((a, b) => {
          const sa = a.subtabId ? (subtabById.get(a.subtabId)?.label ?? '') : '';
          const sb = b.subtabId ? (subtabById.get(b.subtabId)?.label ?? '') : '';
          return sa.localeCompare(sb) || a.position - b.position;
        }),
      }))
      .sort((a, b) => a.tabLabel.localeCompare(b.tabLabel));
  }, [visible, tabById, subtabById]);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">
          Fields <span className="ml-1 font-normal text-ink-400">({live.length})</span>
        </h2>
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          disabled={fieldTabs.length === 0}
          title={fieldTabs.length === 0 ? 'Create a tab that holds fields first' : undefined}
          onClick={() => {
            setOpenCount((c) => c + 1);
            setCreating(true);
          }}
        >
          New field
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line-faint bg-canvas px-4 py-2">
        <select
          value={tabFilter}
          onChange={(e) => setTabFilter(e.target.value)}
          className="rounded border border-line bg-white px-2 py-1 text-[12.5px] outline-none focus:border-brand-600"
        >
          <option value="">All tabs</option>
          {fieldTabs.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search label or key…"
          className="min-w-[180px] flex-1 rounded border border-line bg-white px-2 py-1 text-[12.5px] outline-none focus:border-brand-600"
        />

        {/* A toggle rather than a checkbox, and it carries the count: an
            archived field is invisible everywhere else in the app, so this
            control is the ONLY route back to restoring one. A bare checkbox at
            the end of a filter row was not findable — the first person to
            archive a field could not work out how to get it back. */}
        <Button
          size="sm"
          variant={showArchived ? 'secondary' : 'ghost'}
          icon="archive"
          disabled={archivedCount === 0 && !showArchived}
          title={
            archivedCount === 0
              ? 'No archived fields'
              : showArchived
                ? 'Hide archived fields'
                : 'Show archived fields so they can be restored'
          }
          onClick={() => setShowArchived((v) => !v)}
        >
          Archived ({archivedCount})
        </Button>
      </div>

      {groups.length > 0 ? (
        <ListHeader grid={FIELD_GRID} columns={['Field', 'Type', 'Where / how it behaves', '']} />
      ) : null}

      <div>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.tabId);
          const archivedHere = g.rows.filter((r) => r.archivedAt).length;
          return (
            <div key={g.tabId}>
              <button
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() => toggleGroup(g.tabId)}
                /* Deliberately a shade past the row hover tint: with the rows
                   now striped and hovering brand-50, a group header at the same
                   value read as just another row. */
                className="flex w-full items-center gap-1.5 border-y border-brand-100 bg-brand-100 px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[.04em] text-brand-800 transition-colors hover:bg-brand-100/70"
              >
                <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} strokeWidth={2.5} />
                {g.tabLabel}
                <span className="font-normal normal-case tracking-normal">({g.rows.length})</span>
                {/* Surfaced on the header because a collapsed group would
                    otherwise hide the only route back to a retired field. */}
                {archivedHere > 0 ? (
                  <span className="font-normal normal-case tracking-normal text-bad">· {archivedHere} archived</span>
                ) : null}
              </button>
              {!isCollapsed ? (
                <div>
                  {g.rows.map((f, i) => (
                    <FieldRow
                      key={f.id}
                      field={f}
                      index={i}
                      subtabLabel={f.subtabId ? (subtabById.get(f.subtabId)?.label ?? null) : null}
                      onEdit={() => setEditing(f)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {groups.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-ink-400">
            {fields.length === 0 ? 'No fields yet.' : 'No fields match these filters.'}
          </p>
        ) : null}
      </div>

      {creating ? (
        <Dialog
          title="New field"
          blurb="A field lives in exactly one tab, the same one in every module. Key and type are permanent once created."
          onClose={() => setCreating(false)}
        >
          <CreateFieldForm key={openCount} tabs={fieldTabs} subtabs={subtabs} onClose={() => setCreating(false)} />
        </Dialog>
      ) : null}

      {editing ? (
        <Dialog title={`Edit ${editing.label}`} onClose={() => setEditing(null)}>
          <EditFieldForm field={editing} tabs={fieldTabs} subtabs={subtabs} onClose={() => setEditing(null)} />
        </Dialog>
      ) : null}
    </section>
  );
}

function Dialog({
  title,
  blurb,
  onClose,
  children,
}: {
  title: string;
  blurb?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-4">
      <div className="fixed inset-0 animate-fade-in bg-brand-950/35 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative my-8 w-full max-w-[520px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]"
      >
        <h2 className="text-[16px] font-semibold text-ink-900">{title}</h2>
        {blurb ? <p className="mt-0.5 text-[12.5px] text-ink-400">{blurb}</p> : null}
        {children}
      </div>
    </div>
  );
}

function FieldRow({
  field,
  index,
  subtabLabel,
  onEdit,
}: {
  field: AdminFieldRow;
  index: number;
  subtabLabel: string | null;
  onEdit: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Archiving asks first; restoring does not. Confirmation is worth a click
   * only where the action reaches outside this screen — archiving pulls the
   * field out of every module's drawer and dashboard at once, and the person
   * doing it is one row away from the field they meant. Restore puts things
   * back, so a dialog there would only be a step to dismiss. */
  const [confirming, setConfirming] = useState(false);
  const archived = Boolean(field.archivedAt);

  const run = (action: () => Promise<PresetFormState>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) setConfirming(false);
      else setError(result.message ?? 'That did not work.');
    });
  };

  return (
    <PresetRow grid={FIELD_GRID} index={index} tone={archived ? 'bg-bad-bg' : undefined}>
      <NameCell label={field.label} itemKey={field.key} retired={archived}>
        {field.hint ? <p className="mt-0.5 text-[12px] text-ink-500">{field.hint}</p> : null}
        {/* While the dialog is open it carries the failure itself — the row
            behind it is covered by the backdrop. */}
        {error && !confirming ? (
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-bad">
            <Icon name="alert-triangle" size={12} />
            {error}
          </p>
        ) : null}
      </NameCell>

      <ChipCell>
        <OutlineChip>{TYPE_LABELS[field.type as FieldTypeName] ?? field.type}</OutlineChip>
      </ChipCell>

      {/* Placement first, then the behaviour flags — the two questions asked of
          this column, in the order they are asked. */}
      <ChipCell>
        {subtabLabel ? <OutlineChip tone="brand">{subtabLabel}</OutlineChip> : null}
        {field.isSystem ? <OutlineChip>System</OutlineChip> : null}
        {field.readOnly ? <OutlineChip>Read only</OutlineChip> : null}
        {field.sensitive ? <OutlineChip>Sensitive</OutlineChip> : null}
        {field.required ? <OutlineChip>Required</OutlineChip> : null}
        {archived ? <OutlineChip tone="danger" icon="archive">Archived</OutlineChip> : null}
      </ChipCell>

      <ActionCell>
        {!archived ? (
          <Button size="sm" variant="ghost" icon="pencil" onClick={onEdit}>
            Edit
          </Button>
        ) : null}
        {/* Red for Archive, neutral for Restore — the same pairing the
            `danger` OutlineChip already uses for a retired field, so a row and
            its button say the same thing. Red here means "retires this from
            every module", NOT deleted: nothing on this screen deletes a field,
            and the title says so. Restore is the way back and must never wear
            the colour of the action it undoes. */}
        <Button
          size="sm"
          variant={archived ? 'secondary' : 'danger'}
          icon={archived ? 'rotate-ccw' : 'archive'}
          disabled={pending}
          onClick={archived ? () => run(() => restoreFieldAction(field.id)) : () => setConfirming(true)}
          title={archived ? 'Bring this field back where it was' : 'Remove from every drawer and dashboard; values are kept'}
        >
          {archived ? 'Restore' : 'Archive'}
        </Button>
      </ActionCell>

      {confirming ? (
        <ConfirmArchive
          field={field}
          pending={pending}
          error={error}
          onConfirm={() => run(() => archiveFieldAction(field.id))}
          onClose={() => {
            setConfirming(false);
            setError(null);
          }}
        />
      ) : null}
    </PresetRow>
  );
}

/**
 * The one thing this dialog has to get across is that Archive is not a delete.
 * "Are you sure?" would not have said it — what a person needs before pressing
 * red is where the field goes, what happens to what is already in it, and
 * whether it comes back. So it answers those three, in that order.
 */
function ConfirmArchive({
  field,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  field: AdminFieldRow;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={`Archive ${field.label}?`} onClose={onClose}>
      <ul className="mt-3 space-y-2 text-[13px] text-ink-700">
        <li className="flex gap-2">
          <Icon name="eye-off" size={14} className="mt-0.5 shrink-0 text-ink-400" />
          <span>
            It disappears from every module that shows it — the record drawer, the dashboard columns and
            the header strip.
          </span>
        </li>
        <li className="flex gap-2">
          <Icon name="database" size={14} className="mt-0.5 shrink-0 text-ink-400" />
          <span>
            <strong className="font-medium text-ink-900">Nothing is deleted.</strong> Every value already
            saved on a record stays exactly where it is.
          </span>
        </li>
        <li className="flex gap-2">
          <Icon name="rotate-ccw" size={14} className="mt-0.5 shrink-0 text-ink-400" />
          <span>
            You can bring it back at any time with the{' '}
            <strong className="font-medium text-ink-900">Archived</strong> button at the top of this list,
            and it returns with its values intact.
          </span>
        </li>
      </ul>

      <FormError message={error ?? undefined} />

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="danger" icon="archive" disabled={pending} onClick={onConfirm}>
          {pending ? 'Archiving…' : 'Archive field'}
        </Button>
      </div>
    </Dialog>
  );
}

const initial: PresetFormState = { ok: false };

/** Tab + subtab, kept together because the subtab list depends on the tab and
 * the two must never be submitted out of step — that combination is exactly
 * what `fields_placement_guard` rejects. */
function PlacementInputs({
  tabs,
  subtabs,
  defaultTabId,
  defaultSubtabId,
}: {
  tabs: AdminTabRow[];
  subtabs: AdminSubtabRow[];
  defaultTabId: string;
  defaultSubtabId: string | null;
}) {
  const [tabId, setTabId] = useState(defaultTabId);
  const available = subtabs.filter((s) => s.tabId === tabId);

  return (
    <>
      <label className={`mt-3 ${labelClass}`}>Tab</label>
      <select name="tabId" required value={tabId} onChange={(e) => setTabId(e.target.value)} className={inputClass}>
        {tabs.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>

      <label className={`mt-3 ${labelClass}`}>Subtab</label>
      <select
        name="subtabId"
        key={tabId}
        defaultValue={tabId === defaultTabId ? (defaultSubtabId ?? '') : ''}
        disabled={available.length === 0}
        className={inputClass}
      >
        <option value="">— none, directly on the tab —</option>
        {available.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>
      {available.length === 0 ? <p className="mt-1 text-[11.5px] text-ink-400">This tab has no subtabs.</p> : null}
    </>
  );
}

function FlagInputs({ field }: { field?: AdminFieldRow }) {
  const flags = [
    { name: 'required', label: 'Required', hint: 'Must be filled in before the record is complete.', on: field?.required },
    { name: 'wide', label: 'Full width', hint: 'Takes a whole row in the drawer instead of half.', on: field?.wide },
    { name: 'notesEnabled', label: 'Notes thread', hint: 'Adds a per-record notes thread to this field.', on: field?.notesEnabled },
    {
      name: 'sensitive',
      label: 'Sensitive',
      hint: 'Flags it for encryption at rest — SSN, EIN, account and routing numbers.',
      on: field?.sensitive,
    },
  ];

  return (
    <div className="mt-3 space-y-2 rounded-md border border-line p-2.5">
      {flags.map((f) => (
        <label key={f.name} className="flex gap-2 text-[13px] text-ink-700">
          <input type="checkbox" name={f.name} defaultChecked={f.on} className="mt-0.5 size-3.5 accent-[#1d4ed8]" />
          <span>
            {f.label}
            <span className="block text-[11.5px] text-ink-400">{f.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad">
      <Icon name="alert-triangle" size={12} />
      {message}
    </p>
  );
}

function Done({ what, onClose }: { what: string; onClose: () => void }) {
  return (
    <div className="mt-4">
      <p className="flex items-center gap-1.5 text-[13px] text-ok">
        <Icon name="check" size={14} strokeWidth={2.5} />
        {what}
      </p>
      <div className="mt-5 flex justify-end">
        <Button type="button" variant="primary" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function CreateFieldForm({
  tabs,
  subtabs,
  onClose,
}: {
  tabs: AdminTabRow[];
  subtabs: AdminSubtabRow[];
  onClose: () => void;
}) {
  const [state, action] = useActionState(createFieldAction, initial);
  const [type, setType] = useState<FieldTypeName>('text');
  const [gridColumns, setGridColumns] = useState<GridColumn[]>([{ label: '', type: 'text' }]);
  const [repeatSchema, setRepeatSchema] = useState<RepeatMember[]>([{ key: '', label: '', type: 'text' }]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (state.ok) return <Done what="Field created." onClose={onClose} />;

  return (
    <form action={action} className="mt-4">
      <label className={labelClass}>Label</label>
      <input ref={inputRef} name="label" required placeholder="e.g. Gateway Provider" className={inputClass} />

      <label className={`mt-3 ${labelClass}`}>Key</label>
      <input name="key" required placeholder="e.g. gateway_provider" className={inputClass} />
      <p className="mt-1 text-[11.5px] text-ink-400">
        Permanent — every record&apos;s stored value is filed under it, so it can never be renamed.
      </p>

      <label className={`mt-3 ${labelClass}`}>Type</label>
      <select
        name="type"
        required
        value={type}
        onChange={(e) => setType(e.target.value as FieldTypeName)}
        className={inputClass}
      >
        {FIELD_TYPES.map((t) => (
          <option key={t} value={t}>{TYPE_LABELS[t]}</option>
        ))}
      </select>
      <p className="mt-1 text-[11.5px] text-ink-400">
        Also permanent — changing it would reinterpret every value already stored. To change a type, archive this field
        and create a new one.
      </p>
      {CHOICE_TYPES.includes(type) ? (
        <p className="mt-1 text-[11.5px] text-ink-500">
          Its options are added separately, in the choices editor — it will have none until then.
        </p>
      ) : null}

      {type === 'grid' ? <GridColumnsEditor columns={gridColumns} onChange={setGridColumns} /> : null}
      {type === 'repeat_group' ? <RepeatSchemaEditor members={repeatSchema} onChange={setRepeatSchema} /> : null}

      {/* Only the active one is submitted; the other stays '[]' so the server
          writes NULL, which is what `grid_shape` / `repeat_group_shape` require
          for every other type. */}
      <input type="hidden" name="gridColumns" value={type === 'grid' ? JSON.stringify(gridColumns) : '[]'} />
      <input
        type="hidden"
        name="repeatSchema"
        value={type === 'repeat_group' ? JSON.stringify(repeatSchema) : '[]'}
      />

      <PlacementInputs tabs={tabs} subtabs={subtabs} defaultTabId={tabs[0]?.id ?? ''} defaultSubtabId={null} />

      <label className={`mt-3 ${labelClass}`}>
        Hint <span className="font-normal normal-case text-ink-400">(optional)</span>
      </label>
      <input name="hint" placeholder="Shown under the field in the drawer." className={inputClass} />

      <FlagInputs />

      <FormError message={state.message} />

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon="check">Create field</Button>
      </div>
    </form>
  );
}

function EditFieldForm({
  field,
  tabs,
  subtabs,
  onClose,
}: {
  field: AdminFieldRow;
  tabs: AdminTabRow[];
  subtabs: AdminSubtabRow[];
  onClose: () => void;
}) {
  const [state, action] = useActionState(updateFieldAction, initial);

  if (state.ok) return <Done what="Field updated." onClose={onClose} />;

  return (
    <form action={action} className="mt-4">
      <input type="hidden" name="fieldId" value={field.id} />

      <div className="rounded-md border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink-500">
        <p className="flex items-center gap-1.5 font-medium text-ink-700">
          <Icon name="lock" size={12} />
          {field.key} · {TYPE_LABELS[field.type as FieldTypeName] ?? field.type}
        </p>
        <p className="mt-0.5">
          Key and type are permanent. Records store their values under the key and interpret them by the type, so
          changing either would silently reinterpret data already saved on every record.
          {field.type === 'grid' || field.type === 'repeat_group'
            ? ' Its columns are fixed for the same reason — existing rows are stored under the column labels.'
            : ''}
        </p>
      </div>

      <label className={`mt-3 ${labelClass}`}>Label</label>
      <input name="label" required defaultValue={field.label} className={inputClass} />

      <PlacementInputs tabs={tabs} subtabs={subtabs} defaultTabId={field.tabId} defaultSubtabId={field.subtabId} />
      <p className="mt-1 text-[11.5px] text-ink-400">
        Moving a field puts it at the end of its new tab or subtab.
      </p>

      <label className={`mt-3 ${labelClass}`}>
        Hint <span className="font-normal normal-case text-ink-400">(optional)</span>
      </label>
      <input name="hint" defaultValue={field.hint ?? ''} className={inputClass} />

      <FlagInputs field={field} />

      <FormError message={state.message} />

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon="check">Save changes</Button>
      </div>
    </form>
  );
}

function GridColumnsEditor({
  columns,
  onChange,
}: {
  columns: GridColumn[];
  onChange: (next: GridColumn[]) => void;
}) {
  const set = (i: number, patch: Partial<GridColumn>) =>
    onChange(columns.map((c, k) => (k === i ? { ...c, ...patch } : c)));

  return (
    <div className="mt-3 rounded-md border border-line p-2.5">
      <p className={labelClass}>Columns</p>
      <p className="mt-0.5 text-[11.5px] text-ink-400">
        Users add rows themselves. Only these three types render differently — everything else is a text box.
      </p>

      <div className="mt-2 space-y-1.5">
        {columns.map((c, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              value={c.label}
              onChange={(e) => set(i, { label: e.target.value })}
              placeholder="Column name"
              className="flex-1 rounded border border-line px-2 py-1 text-[13px] outline-none focus:border-brand-600"
            />
            <select
              value={c.type}
              onChange={(e) => set(i, { type: e.target.value as GridColumn['type'] })}
              className="rounded border border-line px-2 py-1 text-[12.5px] outline-none focus:border-brand-600"
            >
              {GRID_COLUMN_TYPES.map((t) => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon="trash"
              disabled={columns.length === 1}
              onClick={() => onChange(columns.filter((_, k) => k !== i))}
            />
          </div>
        ))}
      </div>

      <div className="mt-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={columns.length >= 12}
          onClick={() => onChange([...columns, { label: '', type: 'text' }])}
        >
          Add a column
        </Button>
      </div>
    </div>
  );
}

function RepeatSchemaEditor({
  members,
  onChange,
}: {
  members: RepeatMember[];
  onChange: (next: RepeatMember[]) => void;
}) {
  const set = (i: number, patch: Partial<RepeatMember>) =>
    onChange(members.map((m, k) => (k === i ? { ...m, ...patch } : m)));

  return (
    <div className="mt-3 rounded-md border border-line p-2.5">
      <p className={labelClass}>Member fields</p>
      <p className="mt-0.5 text-[11.5px] text-ink-400">
        One set of these per instance — the shape the client means by &ldquo;add up to 5 owners&rdquo;.
      </p>

      <div className="mt-2 space-y-1.5">
        {members.map((m, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              value={m.label}
              onChange={(e) => set(i, { label: e.target.value })}
              placeholder="Label"
              className="flex-1 rounded border border-line px-2 py-1 text-[13px] outline-none focus:border-brand-600"
            />
            <input
              value={m.key}
              onChange={(e) => set(i, { key: e.target.value })}
              placeholder="key"
              className="w-[92px] rounded border border-line px-2 py-1 text-[13px] outline-none focus:border-brand-600"
            />
            <select
              value={m.type}
              onChange={(e) => set(i, { type: e.target.value as RepeatMember['type'] })}
              className="rounded border border-line px-2 py-1 text-[12.5px] outline-none focus:border-brand-600"
            >
              {REPEAT_MEMBER_TYPES.map((t) => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon="trash"
              disabled={members.length === 1}
              onClick={() => onChange(members.filter((_, k) => k !== i))}
            />
          </div>
        ))}
      </div>

      <div className="mt-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={members.length >= 20}
          onClick={() => onChange([...members, { key: '', label: '', type: 'text' }])}
        >
          Add a member field
        </Button>
      </div>

      <label className={`mt-3 ${labelClass}`}>Maximum instances</label>
      <input name="repeatMax" type="number" min={1} max={20} defaultValue={5} className={inputClass} />

      <label className={`mt-3 ${labelClass}`}>
        Group key <span className="font-normal normal-case text-ink-400">(optional)</span>
      </label>
      <input name="repeatGroupKey" placeholder="defaults to this field's own key" className={inputClass} />
      <p className="mt-1 text-[11.5px] text-ink-400">
        Only needed when one set of instances is split across two tabs — the way Owners keeps SSN on Application →
        Private and everything else on Application → Ownership. Give both fields the same group key and they stay one
        set of people.
      </p>
    </div>
  );
}
