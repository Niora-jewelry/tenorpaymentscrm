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

import { useMemo, useState, useTransition } from 'react';
import { Button, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { archiveFieldAction, restoreFieldAction, type PresetFormState } from './actions';
import { CreateFieldForm, EditFieldForm, type ModuleChoice } from './FieldForm';
import { ActionCell, ChipCell, FIELD_GRID, ListHeader, NameCell, PresetRow } from './PresetRow';
import { FIELD_TYPES } from '@/lib/records/adminSchemas';
import type { AdminFieldRow } from '@/lib/records/adminFields';
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
  checkbox: 'Checkbox (retired)',
  email: 'Email',
  phone: 'Phone',
  url: 'Website',
  address: 'Address',
  date: 'Date',
  datetime: 'Date and time',
  months: 'Multiple picker (months)',
  dropdown: 'Dropdown',
  status: 'Status',
  multi_select: 'Multiple picker',
  team_member: 'Team picker',
  identifier: 'Text — digits only',
  file: 'Files',
  percent_split: 'Percentage = 100%',
  grid: 'Grid (rows the user adds)',
  repeat_group: 'Repeating group',
  auto: 'Auto-populated (locked)',
};

export function FieldsSection({
  fields,
  tabs,
  subtabs,
  modules,
}: {
  fields: AdminFieldRow[];
  tabs: AdminTabRow[];
  subtabs: AdminSubtabRow[];
  /** For "Show as list column" — which modules' lists show it. */
  modules: ModuleChoice[];
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
          className="rounded border border-line bg-white px-2 py-1 text-[12.5px] outline-none focus-field"
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
          className="min-w-[180px] flex-1 rounded border border-line bg-white px-2 py-1 text-[12.5px] outline-none focus-field"
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
                ? 'Hide the hidden fields again'
                : 'List hidden fields so they can be shown again'
          }
          onClick={() => setShowArchived((v) => !v)}
        >
          Hidden ({archivedCount})
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
          wide
          title="New field"
          blurb="One definition, shown in every module. Set where it lives, how it behaves and where it shows."
          onClose={() => setCreating(false)}
        >
          <CreateFieldForm key={openCount} tabs={fieldTabs} subtabs={subtabs} fields={fields} modules={modules} onClose={() => setCreating(false)} />
        </Dialog>
      ) : null}

      {editing ? (
        <Dialog wide title={`Edit ${editing.label}`} onClose={() => setEditing(null)}>
          <EditFieldForm
            field={editing}
            tabs={fieldTabs}
            subtabs={subtabs}
            fields={fields}
            modules={modules}
            typeLabel={TYPE_LABELS[editing.type as FieldTypeName] ?? editing.type}
            onClose={() => setEditing(null)}
          />
        </Dialog>
      ) : null}
    </section>
  );
}

function Dialog({
  title,
  blurb,
  wide = false,
  onClose,
  children,
}: {
  title: string;
  blurb?: string;
  /** The field forms: two columns, the position preview on the right. */
  wide?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto p-4">
      <div className="fixed inset-0 animate-fade-in bg-brand-950/35" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={`relative my-8 w-full ${wide ? 'max-w-[960px]' : 'max-w-[520px]'} animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]`}
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
        {field.section ? <p className="mt-0.5 text-[11.5px] text-ink-400">Section: {field.section}</p> : null}
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
        {field.inVital ? <OutlineChip tone="brand">Vital Info</OutlineChip> : null}
        {field.columnModuleIds.length ? <OutlineChip>List column</OutlineChip> : null}
        {archived ? <OutlineChip tone="danger" icon="eye-off">Hidden</OutlineChip> : null}
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
          icon={archived ? 'eye' : 'eye-off'}
          disabled={pending}
          onClick={archived ? () => run(() => restoreFieldAction(field.id)) : () => setConfirming(true)}
          title={archived ? 'Show this field again, where it was' : 'Hide from every drawer and list; values are kept'}
        >
          {archived ? 'Show again' : 'Hide'}
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
    <Dialog title={`Hide ${field.label}?`} onClose={onClose}>
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
            You can show it again at any time from the{' '}
            <strong className="font-medium text-ink-900">Hidden</strong> button at the top of this list,
            and it returns with its values intact.
          </span>
        </li>
      </ul>

      <FormError message={error ?? undefined} />

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="danger" icon="eye-off" disabled={pending} onClick={onConfirm}>
          {pending ? 'Hiding…' : 'Hide field'}
        </Button>
      </div>
    </Dialog>
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
