'use client';

/**
 * PROTOTYPE — one module screen.
 *
 * This ONE component renders all six modules. It never names a module: it reads
 * the configuration, asks the store which columns and rows this viewer may see,
 * and draws them. That is the whole point of the architecture, and it is why
 * adding a seventh module later is a database row rather than a sprint.
 */
import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Field, FieldValue, ModuleSlug } from '../schema';
import { moduleBySlug } from '../modules';
import { columnsFor } from '../fields';
import { useStore } from '../store';
import { DataTable, BulkBar, SkipReportPanel, type SkipReport } from './DataTable';
import { RecordDrawer } from './Drawer';
import {
  Avatar,
  Button,
  Dialog,
  EmptyState,
  NumberInput,
  OutlineChip,
  SpecNote,
  StatusPill,
} from './kit';
import { Icon, MODULE_ICON } from './icons';
import { USER_BY_ID } from '../data';

export function ModuleView({ slug }: { slug: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const store = useStore();
  const {
    viewer,
    columnsForViewer,
    rowsFor,
    records,
    cases,
    grantFor,
    setValue,
    setMemberships,
    deleteRecord,
    setColumnOrder,
    resetColumnOrder,
    hasCustomColumnOrder,
    filtersFor,
    setFilters,
    clearFilters,
  } = store;

  const mod = moduleBySlug(slug);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEditing, setBulkEditing] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<null | 'archive' | 'delete'>(null);
  const [report, setReport] = useState<SkipReport>(null);

  const openId = search.get('record');

  const columns = useMemo(
    () => (mod ? columnsForViewer(mod.slug) : []),
    [mod, columnsForViewer],
  );
  const rows = useMemo(() => (mod ? rowsFor(mod.slug) : []), [mod, rowsFor]);

  if (!mod) {
    return (
      <div className="p-8">
        <EmptyState title="No such module" body={`"${slug}" is not in the modules table.`} />
      </div>
    );
  }

  if (!viewer.modules.includes(mod.slug)) {
    return (
      <div className="p-8">
        <EmptyState
          title={`${mod.label} is not available to ${viewer.label}`}
          body="Module access is a permission like any other. A module a user cannot access is absent from their navigation entirely — this screen exists only because you typed the URL."
        />
      </div>
    );
  }

  const openRecord = records.find((r) => r.id === openId && !r.deleted);
  const setOpen = (id: string | null) => {
    const params = new URLSearchParams(search.toString());
    if (id) params.set('record', id);
    else params.delete('record');
    router.replace(`/prototype/${mod.slug}${params.toString() ? `?${params}` : ''}`, {
      scroll: false,
    });
  };

  /* --- the Tickets module's one hardcoded system column ------------------ */
  const extraColumn =
    mod.slug === 'tickets'
      ? {
          label: 'Open case managers',
          width: 200,
          render: (r: import('../schema').RecordRow) => {
            // Auto-populated: every manager on any OPEN case on this record.
            const ids = [
              ...new Set(
                cases
                  .filter((c) => c.recordId === r.id && c.state === 'open')
                  .flatMap((c) => c.managerIds),
              ),
            ];
            if (!ids.length) return <span className="text-ink-400/70">—</span>;
            return (
              <span className="flex -space-x-1.5">
                {ids.map((id) => {
                  const u = USER_BY_ID.get(id);
                  return u ? <Avatar key={id} user={u} /> : null;
                })}
              </span>
            );
          },
        }
      : undefined;

  /* --- bulk actions, always skip-and-report ------------------------------ */

  const runBulkArchive = () => {
    const skipped: { name: string; reason: string }[] = [];
    let done = 0;
    for (const id of selected) {
      const r = records.find((x) => x.id === id);
      if (!r) continue;
      // Archive and remove both require Edit on the primary field.
      if (grantFor({ id: 'deal_name' } as Field) !== 'edit') {
        skipped.push({ name: r.dealName, reason: 'you do not have edit access to Deal Name' });
        continue;
      }
      if (mod.slug === 'records') {
        if (r.memberships.length === 0) {
          skipped.push({ name: r.dealName, reason: 'already archived' });
          continue;
        }
        setMemberships(id, []);
      } else {
        setMemberships(
          id,
          r.memberships.filter((m) => m !== (mod.slug as ModuleSlug)),
        );
      }
      done++;
    }
    setReport({ done, skipped });
    setSelected(new Set());
    setConfirmBulk(null);
  };

  const runBulkDelete = () => {
    const skipped: { name: string; reason: string }[] = [];
    let done = 0;
    for (const id of selected) {
      const r = records.find((x) => x.id === id);
      if (!r) continue;
      // The archive-before-delete rule, enforced per row and reported back.
      if (r.memberships.length > 0) {
        skipped.push({
          name: r.dealName,
          reason: `still displayed in ${r.memberships.length} module${r.memberships.length > 1 ? 's' : ''} — archive it first`,
        });
        continue;
      }
      deleteRecord(id);
      done++;
    }
    setReport({ done, skipped });
    setSelected(new Set());
    setConfirmBulk(null);
  };

  const runBulkEdit = (fieldId: string, value: FieldValue) => {
    const skipped: { name: string; reason: string }[] = [];
    let done = 0;
    for (const id of selected) {
      const r = records.find((x) => x.id === id);
      if (!r) continue;
      const team = (r.values.team_member as string[] | undefined) ?? [];
      if (viewer.ownRecordsOnly && !team.includes(viewer.userId)) {
        skipped.push({ name: r.dealName, reason: 'you are not a team member on this record' });
        continue;
      }
      setValue(id, fieldId, value);
      done++;
    }
    setReport({ done, skipped });
    setSelected(new Set());
    setBulkEditing(false);
  };

  const archivedCount = rows.filter((r) => r.memberships.length === 0).length;

  return (
    <>
      {/* --- page header --- */}
      <div className="shrink-0 border-b border-line bg-white px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-[18px] font-semibold tracking-[-.01em] text-ink-900">
            <span className="grid size-7 place-items-center rounded-lg bg-brand-50 text-brand-700">
              <Icon name={MODULE_ICON[mod.slug] ?? 'database'} size={15} strokeWidth={2} />
            </span>
            {mod.label}
          </h1>
          {mod.kind === 'storage' ? (
            <OutlineChip tone="brand" icon="database">
              Master store
            </OutlineChip>
          ) : (
            <OutlineChip>Display module</OutlineChip>
          )}
          <span className="text-[13px] text-ink-400 tabular">
            {rows.length.toLocaleString()} records
            {archivedCount && mod.slug === 'records' ? ` · ${archivedCount} archived` : ''}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <span className="hidden text-[12px] text-ink-400 lg:inline">
              {/* Configured column count vs. what this viewer may see. The gap
                  is the permission system, visible at a glance. */}
              {columns.length} of {columnsFor(mod.slug).length} columns visible to you
            </span>
            <Button variant="primary" size="sm" icon="plus">
              New record
            </Button>
          </span>
        </div>
        <p className="mt-1.5 max-w-[110ch] text-[12.5px] leading-relaxed text-ink-400">
          {mod.blurb}
        </p>
      </div>

      <DataTable
        moduleSlug={mod.slug}
        rows={rows}
        columns={columns}
        onOpen={setOpen}
        selected={selected}
        onSelectedChange={setSelected}
        extraColumn={extraColumn}
        grantFor={grantFor}
        hasCustomColumnOrder={hasCustomColumnOrder(mod.slug)}
        onReorderColumns={(ids) => setColumnOrder(mod.slug, ids)}
        onResetColumnOrder={() => resetColumnOrder(mod.slug)}
        filters={filtersFor(mod.slug)}
        onSetFilters={(f) => setFilters(mod.slug, f)}
        onClearFilters={() => clearFilters(mod.slug)}
      />

      <BulkBar
        count={selected.size}
        moduleSlug={mod.slug}
        onClear={() => setSelected(new Set())}
        onBulkEdit={() => setBulkEditing(true)}
        onArchive={() => setConfirmBulk('archive')}
        onDelete={() => setConfirmBulk('delete')}
      />

      <SkipReportPanel report={report} onClose={() => setReport(null)} />

      {openRecord ? (
        <RecordDrawer record={openRecord} module={mod} onClose={() => setOpen(null)} />
      ) : null}

      {bulkEditing ? (
        <BulkEditDialog
          count={selected.size}
          columns={columns.filter((c) => grantFor(c) === 'edit')}
          onApply={runBulkEdit}
          onClose={() => setBulkEditing(false)}
        />
      ) : null}

      {confirmBulk === 'archive' ? (
        <Dialog
          title={
            mod.slug === 'records'
              ? `Archive ${selected.size} records?`
              : `Remove ${selected.size} records from ${mod.label}?`
          }
          confirmLabel={mod.slug === 'records' ? 'Archive' : 'Remove'}
          confirmIcon="archive"
          onClose={() => setConfirmBulk(null)}
          onConfirm={runBulkArchive}
        >
          <p>
            {mod.slug === 'records'
              ? 'These records will no longer appear in any display mod. They stay stored here with everything intact.'
              : `They will stop appearing in ${mod.label}. Any record whose LAST display membership this clears is archived — it stays in the Records List.`}
          </p>
          <p className="mt-2 text-ink-400">
            Rows you cannot modify are skipped and listed back to you.
          </p>
        </Dialog>
      ) : null}

      {confirmBulk === 'delete' ? (
        <Dialog
          title={`Delete ${selected.size} records?`}
          tone="danger"
          confirmLabel="Delete to Recycle Bin"
          confirmIcon="trash"
          onClose={() => setConfirmBulk(null)}
          onConfirm={runBulkDelete}
        >
          <p>
            Only <strong>archived</strong> records can be deleted. Any selected record still
            displayed in a module is refused and reported back to you.
          </p>
        </Dialog>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Bulk edit — only fields the user holds EDIT on appear at all                */
/* -------------------------------------------------------------------------- */

function BulkEditDialog({
  count,
  columns,
  onApply,
  onClose,
}: {
  count: number;
  columns: Field[];
  onApply: (fieldId: string, value: FieldValue) => void;
  onClose: () => void;
}) {
  const [fieldId, setFieldId] = useState(columns[0]?.id ?? '');
  const [value, setValue] = useState('');
  const field = columns.find((c) => c.id === fieldId);
  const numeric =
    field?.type === 'currency' || field?.type === 'number' || field?.type === 'percentage';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 animate-fade-in bg-brand-950/35 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div className="relative w-full max-w-[480px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]">
        <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink-900">
          <Icon name="pencil" size={16} className="text-ink-400" />
          Bulk edit {count} records
        </h2>
        <SpecNote>
          Only fields you hold <strong>Edit</strong> on appear in this list. Fields at View or Hidden
          are absent entirely, not disabled.
        </SpecNote>

        <label className="mt-4 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
          Field
        </label>
        <select
          value={fieldId}
          onChange={(e) => {
            setFieldId(e.target.value);
            setValue('');
          }}
          className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-underline"
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>

        <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
          Set to
        </label>
        {field?.choices ? (
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-underline"
          >
            <option value="">— choose —</option>
            {field.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.value}
              </option>
            ))}
          </select>
        ) : numeric ? (
          // Bulk edit writes the same value to many records at once, so a
          // negative slipping through here is the most expensive place for it.
          <NumberInput
            value={value}
            max={field?.type === 'percentage' ? 100 : undefined}
            onLiveChange={(n) => setValue(n == null ? '' : String(n))}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-underline"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-underline"
          />
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="check"
            disabled={!fieldId || value === ''}
            onClick={() => onApply(fieldId, numeric ? Math.max(0, Number(value)) : value)}
          >
            Apply to {count} records
          </Button>
        </div>
      </div>
    </div>
  );
}

export { StatusPill };
