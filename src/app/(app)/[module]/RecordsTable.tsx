'use client';

/**
 * The real dashboard grid — the prototype's `DataTable`/`BulkBar`/
 * `SkipReportPanel` (`src/proto/ui/DataTable.tsx`), reused verbatim per
 * Stage 4's own framing ("evolve, don't restart"), now driven by real
 * network calls instead of the in-memory store. `page.tsx` (a Server
 * Component) does the initial authorized fetch and adapts the data into the
 * prototype's `Field`/`RecordRow` contract (`lib/records/adapter.ts`); every
 * interaction from here on — column reorder, filter, bulk edit/archive/
 * delete — calls a real server action, which revalidates itself
 * (`revalidatePath`) as part of its own response, so a fresh RSC payload for
 * this route arrives the moment the awaited action resolves. No separate
 * `router.refresh()` follows any of them — that used to be a fully
 * redundant second round trip (confirmed live: a distinct `_rsc=` GET firing
 * well after the action's own POST had already resolved), the same pattern
 * `RealFieldGrid.tsx` found and fixed for its own reorder/repeat-group
 * actions.
 *
 * That server round trip is still not instant — a cold Turbopack dev
 * compile can visibly take several seconds, and even warm it's a full
 * server round trip. A bulk archive/remove/delete that only waited on that
 * round trip left the row sitting on screen looking untouched but for a
 * toast, which reads as "the button did nothing" long before the
 * revalidation lands. `localRows` mirrors the server `rows` prop but is
 * updated synchronously the moment a bulk action's own result comes back —
 * the affected rows disappear (remove/delete) or pick up the "Archived" chip
 * (archive) immediately — and is resynced from `rows` whenever a fresh
 * server render actually arrives, so the optimistic view never permanently
 * drifts from the database.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, BulkBar, SkipReportPanel, type SkipReport as ProtoSkipReport } from '@/proto/ui/DataTable';
import { Dialog, Button, NumberInput, SpecNote } from '@/proto/ui/kit';
import { PersonAvatar, resolvePerson, usePeople, usePeopleById } from '@/proto/ui/people';
import { Icon } from '@/proto/ui/icons';
import type { Field, RecordRow, Filter, FieldValue, Swatch } from '@/proto/schema';
import { PipelineFilter, type PipelineFilterOption } from './PipelineFilter';
import { choicesFor, choiceKey } from '@/proto/fields';
import { VISIBILITY_FIELD_KEY } from '@/lib/records/grantRules';
import {
  reorderColumnsAction, resetColumnOrderAction, setFiltersAction, clearFiltersAction,
  setValueAction,
  setPipelineStepAction,
  bulkEditAction, bulkArchiveAction, bulkRemoveFromModuleAction, bulkDeleteAction, bulkRestoreToModuleAction,
} from './actions';

type Grant = 'hidden' | 'view' | 'edit';

function toProtoReport(r: { applied: string[]; skipped: { id: string; reason: string }[] }, rows: RecordRow[]): ProtoSkipReport {
  const byId = new Map(rows.map((row) => [row.id, row.dealName]));
  return {
    done: r.applied.length,
    skipped: r.skipped.map((s) => ({ name: byId.get(s.id) ?? s.id, reason: s.reason })),
  };
}

export function RecordsTable({
  moduleSlug,
  moduleId,
  rows,
  columns,
  grantByKey,
  displayModules,
  hasCustomColumnOrder,
  filters,
  pipelines,
  pipelineStatusFields,
  canEdit,
  page,
  pageCount,
  total,
}: {
  moduleSlug: string;
  moduleId: string;
  rows: RecordRow[];
  columns: Field[];
  grantByKey: Record<string, Grant>;
  /** Records List only: the target list for the bulk "Restore to module"
   * action on already-archived rows. */
  displayModules: { id: string; slug: string; label: string }[];
  hasCustomColumnOrder: boolean;
  filters: Record<string, Filter>;
  /** This module's pipelines, for the toolbar's pipeline/step filter —
   * Admin §3.6. Empty for a module with none, which hides the control. */
  pipelines: PipelineFilterOption[];
  /** The synced Status fields those pipelines own, so an active pipeline
   * filter's chip can be labelled even though the field is not a column.
   * Labelling only; see `DataTable`'s `filterOnlyFields`. */
  pipelineStatusFields: Field[];
  canEdit: boolean;
  /** Server paging — `DataTable` is handed one page at a time, so it cannot
   * work these out for itself. See its `serverPaging` prop. */
  page: number;
  pageCount: number;
  total: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkEditing, setBulkEditing] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<null | 'archive' | 'delete' | 'restore'>(null);
  const [report, setReport] = useState<ProtoSkipReport>(null);
  const [pending, setPending] = useState(false);
  /*
   * View preferences (filters, column order) persist in the background. These
   * were bare `await someAction(...)` calls, so a failed save was invisible:
   * the table had already applied the change locally and it silently reverted
   * on the next load, reading as the CRM forgetting your view at random.
   * Quieter than a refused write, but not silent.
   */
  const [prefError, setPrefError] = useState<string | null>(null);

  // Optimistic mirror of the server `rows` prop — see file header. Resynced
  // whenever a fresh server render actually supplies new `rows` (a real
  // `router.refresh()` landing, a filter change, pagination, etc.). Adjusted
  // during render (React's own pattern for "reset state when a prop
  // changes" — react.dev, "you might not need an effect") rather than in a
  // `useEffect`, matching `DataTable`'s own `lastResultKey`/`setPage` reset
  // just below in the same file family: `rows` is a fresh array identity
  // every time a real server render supplies new data, and the SAME
  // reference across purely client-side re-renders (typing a filter,
  // toggling a checkbox), so reference equality is exactly the right signal.
  const [localRows, setLocalRows] = useState(rows);
  const [rowsSnapshot, setRowsSnapshot] = useState(rows);
  if (rows !== rowsSnapshot) {
    setRowsSnapshot(rows);
    setLocalRows(rows);
  }

  // Same reasoning, for column order. `DataTable` renders both the header
  // AND every row's cell for a column from this one `columns` array/order —
  // they were never two independently-iterated sources — but without this,
  // a drag-drop only updated `columns` after `reorderColumnsAction` +
  // `router.refresh()` came back, which dnd-kit's own drop animation and the
  // several-second server round trip made read as "only the header text
  // slid over, the data didn't move": dnd-kit resets its drag transform the
  // instant the drop happens, so the header visibly snaps back to the OLD
  // order for the whole gap before the round trip lands. Reordering
  // `localColumns` synchronously on drop moves the header label AND every
  // row's cell together, in the same paint — no snap-back, no wait.
  const [localColumns, setLocalColumns] = useState(columns);
  const [columnsSnapshot, setColumnsSnapshot] = useState(columns);
  if (columns !== columnsSnapshot) {
    setColumnsSnapshot(columns);
    setLocalColumns(columns);
  }

  const grantFor = (field: Field): Grant => grantByKey[field.id] ?? 'edit';

  const allSelectedArchived =
    moduleSlug === 'records' &&
    selected.size > 0 &&
    [...selected].every((id) => localRows.find((r) => r.id === id)?.memberships.length === 0);

  /**
   * Open a record's drawer.
   *
   * Wrapped in a transition so React can tell us the navigation is still in
   * flight (`opening`), which is the ONLY per-row feedback there is: the
   * drawer is server-rendered, so between the click and the sheet appearing
   * nothing about this table changes on its own. Without it a click looked
   * ignored for as long as the fetch took, and people clicked again.
   *
   * `openingId` is cleared by the render that lands with the drawer, since
   * `isPending` goes false when the navigation commits.
   */
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [opening, startOpenTransition] = useTransition();

  /**
   * Paging is a real navigation, so it survives a reload and can be linked
   * and shared. `useTransition` gives the same "this click registered"
   * feedback the row click gets — a page change is a full server render.
   */
  const [paging, startPageTransition] = useTransition();
  const goToPage = (p: number) => {
    const params = new URLSearchParams(window.location.search);
    if (p <= 0) params.delete('page');
    else params.set('page', String(p));
    // Leaving `record` in place would reopen the drawer over the new page.
    params.delete('record');
    startPageTransition(() => {
      router.push(`/${moduleSlug}${params.toString() ? `?${params}` : ''}`);
    });
  };

  /** Drops `page` from the URL without touching anything else on it. Used
   *  whenever the result set changes underneath the current page. */
  const resetToFirstPage = () => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('page')) return;
    params.delete('page');
    router.replace(`/${moduleSlug}${params.toString() ? `?${params}` : ''}`);
  };

  const openRecord = (id: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('record', id);
    setOpeningId(id);
    startOpenTransition(() => {
      router.push(`/${moduleSlug}?${params.toString()}`);
    });
  };

  /** Puts a row the server reports as skipped back the way it actually is —
   * looked up from the server `rows` prop (the last known-good truth) —
   * undoing the optimistic guess for that one row. The common case (nothing
   * skipped) never runs this at all. */
  const restoreSkipped = (skippedIds: Set<string>, current: RecordRow[]): RecordRow[] => {
    if (!skippedIds.size) return current;
    const byOriginalId = new Map(rows.map((r) => [r.id, r]));
    const present = new Set(current.map((r) => r.id));
    const restored = rows.filter((r) => skippedIds.has(r.id) && !present.has(r.id));
    if (!restored.length) return current.map((r) => (skippedIds.has(r.id) ? (byOriginalId.get(r.id) ?? r) : r));
    // A skipped row that was optimistically removed needs to come back —
    // rebuilt in the server's own order so it reappears where it belongs
    // rather than tacked on at the end.
    const byId = new Map([...current, ...restored].map((r) => [r.id, r]));
    return rows.map((r) => byId.get(r.id)).filter((r): r is RecordRow => Boolean(r));
  };

  /**
   * What to do when a bulk action does not come back at all.
   *
   * Every `runBulk*` below applies its effect optimistically and then awaits
   * the server. None of them used to guard that await, and the consequences of
   * a dropped request were two separate silent failures at once:
   *
   *   1. `setPending(false)` never ran, so `pending` stayed true and EVERY
   *      bulk control on the page stayed disabled until a full reload. Nothing
   *      said why.
   *   2. The optimistic change was never undone, so rows sat there looking
   *      archived, restored or deleted when the database had done none of it.
   *      Reloading later made them reappear with no explanation.
   *
   * This restores the last server-rendered truth and says plainly that nothing
   * was applied. It reuses the skip-report panel the successful path already
   * uses, so there is one place failures are reported rather than a second
   * mechanism to notice.
   */
  const bulkFailed = (what: string, ids: string[]) => {
    setLocalRows(rows);
    setSelected(new Set());
    setReport({
      done: 0,
      skipped: ids.map((id) => ({
        name: rows.find((r) => r.id === id)?.dealName ?? id,
        reason: `Could not reach the server — nothing was ${what}. Check your connection and try again.`,
      })),
    });
  };

  const runBulkArchive = async () => {
    setPending(true);
    const ids = [...selected];
    const idSet = new Set(ids);
    const isRecordsListArchive = moduleSlug === 'records';
    // Optimistic: apply the intended effect immediately, assuming every
    // selected row succeeds (the common case), rather than waiting on the
    // server round trip to find out — see the file header. Skipped rows
    // (a permission edge case, or a row changed since selection) are
    // reconciled back below once the server's own report comes back.
    setLocalRows((prev) =>
      isRecordsListArchive
        // Records List's own "Archive" clears every membership but the
        // record stays listed here — just picks up the "Archived" chip.
        ? prev.map((r) => (idSet.has(r.id) ? { ...r, memberships: [] } : r))
        // Removing from a display module drops the row from THIS module's
        // view right away, whether or not it also became fully archived.
        : prev.filter((r) => !idSet.has(r.id)),
    );
    setSelected(new Set());
    setConfirmBulk(null);

    try {
      const result =
        moduleSlug === 'records'
          ? await bulkArchiveAction(moduleSlug, ids)
          : await bulkRemoveFromModuleAction(moduleSlug, moduleId, ids);
      setReport(toProtoReport(result, rows));
      if (result.skipped.length) {
        const skippedIds = new Set(result.skipped.map((s) => s.id));
        setLocalRows((prev) => restoreSkipped(skippedIds, prev));
      }
    } catch {
      bulkFailed('archived', ids);
    } finally {
      setPending(false);
    }
  };

  const runBulkRestore = async (targetModuleId: string, targetModuleSlug: string) => {
    setPending(true);
    const ids = [...selected];
    const idSet = new Set(ids);
    // `RecordRow.memberships` (the client-adapted shape) holds module SLUGS,
    // not the uuid the server-side membership tables key on — see
    // `adaptRecordRow` in lib/records/adapter.ts.
    setLocalRows((prev) =>
      prev.map((r) =>
        idSet.has(r.id) ? { ...r, memberships: [...r.memberships, targetModuleSlug as RecordRow['memberships'][number]] } : r,
      ),
    );
    setSelected(new Set());
    setConfirmBulk(null);

    try {
      const result = await bulkRestoreToModuleAction(targetModuleId, ids);
      setReport(toProtoReport(result, rows));
      if (result.skipped.length) {
        const skippedIds = new Set(result.skipped.map((s) => s.id));
        setLocalRows((prev) => restoreSkipped(skippedIds, prev));
      }
    } catch {
      bulkFailed('restored', ids);
    } finally {
      setPending(false);
    }
  };

  const runBulkDelete = async () => {
    setPending(true);
    const ids = [...selected];
    const idSet = new Set(ids);
    setLocalRows((prev) => prev.filter((r) => !idSet.has(r.id)));
    setSelected(new Set());
    setConfirmBulk(null);

    try {
      const result = await bulkDeleteAction(ids);
      setReport(toProtoReport(result, rows));
      if (result.skipped.length) {
        const skippedIds = new Set(result.skipped.map((s) => s.id));
        setLocalRows((prev) => restoreSkipped(skippedIds, prev));
      }
    } catch {
      bulkFailed('deleted', ids);
    } finally {
      setPending(false);
    }
  };

  const runBulkEdit = async (fieldKey: string, value: unknown) => {
    setPending(true);
    const ids = [...selected];
    const idSet = new Set(ids);
    setLocalRows((prev) =>
      prev.map((r) => (idSet.has(r.id) ? { ...r, values: { ...r.values, [fieldKey]: value as FieldValue } } : r)),
    );
    setSelected(new Set());
    setBulkEditing(false);

    try {
      const result = await bulkEditAction(moduleSlug, ids, fieldKey, value);
      setReport(toProtoReport(result, rows));
      if (result.skipped.length) {
        const skippedIds = new Set(result.skipped.map((s) => s.id));
        const byOriginalId = new Map(rows.map((r) => [r.id, r]));
        setLocalRows((prev) => prev.map((r) => (skippedIds.has(r.id) ? (byOriginalId.get(r.id) ?? r) : r)));
      }
    } catch {
      bulkFailed('changed', ids);
    } finally {
      setPending(false);
    }
  };

  /**
   * Commit one cell edited straight from the table.
   *
   * ── IT REUSES THE DRAWER'S WRITE PATH EXACTLY ────────────────────────────
   * `setValueAction` already carries the whole permission chain (module → tab →
   * subtab → field), the compare-and-swap, the activity-log row and the
   * duplicate rules. Adding a second server path for "the same edit, from a
   * different screen" would be a second place for those to drift, which is the
   * failure CLAUDE.md rule 2 exists to prevent. There is no new action here.
   *
   * ── OPTIMISTIC, AND THE TOKEN IS THE REASON IT CAN BE ────────────────────
   * The value paints before the round trip and the row's `updatedAt` advances
   * from what the server returns, so a second edit on the same row carries a
   * fresh token instead of a stale one. Without adopting that token back, the
   * next edit would lose its compare-and-swap against a write this table made
   * itself — which is precisely the bug `recordVersion.ts` exists to solve for
   * the drawer.
   *
   * A refusal rolls the cell back to the value it held. Nothing is left on
   * screen that the database did not accept.
   */
  const commitCell = async (
    recordId: string,
    field: Field,
    next: FieldValue,
  ): Promise<{ ok: boolean; message?: string }> => {
    const before = localRows.find((r) => r.id === recordId);
    if (!before?.updatedAt) {
      return { ok: false, message: 'This row is out of date — reload and try again.' };
    }
    const previous = before.values[field.id];

    // Paint first.
    setLocalRows((rows) =>
      rows.map((r) => (r.id === recordId ? { ...r, values: { ...r.values, [field.id]: next } } : r)),
    );

    const formData = new FormData();
    // Same encoding the drawer uses: objects and arrays as JSON, everything
    // else as a string, and `null` as the empty string meaning "clear it".
    formData.set(
      'value',
      next == null ? '' : typeof next === 'object' ? JSON.stringify(next) : String(next),
    );
    formData.set('expectedUpdatedAt', before.updatedAt);

    try {
      const result = await setValueAction(moduleSlug, recordId, field.id, formData);
      if (!result.ok) {
        setLocalRows((rows) =>
          rows.map((r) => (r.id === recordId ? { ...r, values: { ...r.values, [field.id]: previous } } : r)),
        );
        return { ok: false, message: result.message };
      }
      // Adopt the new token, or the next edit on this row fights this one.
      setLocalRows((rows) =>
        rows.map((r) => (r.id === recordId ? { ...r, updatedAt: result.updatedAt } : r)),
      );
      return { ok: true };
    } catch {
      setLocalRows((rows) =>
        rows.map((r) => (r.id === recordId ? { ...r, values: { ...r.values, [field.id]: previous } } : r)),
      );
      return { ok: false, message: 'Could not save. Nothing was changed.' };
    }
  };

  /**
   * Move one record to one pipeline step, straight from the table.
   *
   * ── IT DOES NOT GO THROUGH `commitCell`, AND MUST NOT ────────────────────
   * The pipeline's synced Status field is a column like any other to look at
   * and nothing like one to write. Its value is a projection of
   * `record_pipelines`; the field is marked read-only; `assertWritable` and
   * the database both refuse a direct write to it. That is deliberate — a
   * projection with two writers drifts, and nothing would report it.
   *
   * So this calls the pipeline's own writer, which is the same action the
   * drawer's step bar uses. The rule that protects the field is untouched;
   * what changed is that the table can now reach the one writer that was
   * always allowed to move a record along.
   *
   * Optimistic for the same reason `commitCell` is, with one difference: the
   * step is not a `values` write, so there is no compare-and-swap token to
   * adopt back. `set_pipeline_step` is an upsert keyed on (record, module) —
   * last write wins, exactly as it does from the drawer.
   */
  const commitPipelineStep = async (
    recordId: string,
    pipelineId: string,
    stepId: string,
  ): Promise<{ ok: boolean; message?: string }> => {
    /* The column this pipeline feeds, so the optimistic paint lands on the
       right cell. A pipeline with no synced field has no column to paint. */
    const key = pipelines.find((p) => p.id === pipelineId)?.statusFieldKey;
    const before = localRows.find((r) => r.id === recordId);
    /* Kept as a one-key patch rather than a value: a step the record did not
       have is an ABSENT key, and writing `undefined` back would leave the
       key present and holding nothing, which reads differently everywhere
       downstream (see `present` in the filter list). */
    const restore = (row: RecordRow): RecordRow => {
      const values = { ...row.values };
      if (!key) return row;
      if (before && key in before.values) values[key] = before.values[key];
      else delete values[key];
      return { ...row, values };
    };

    if (key) {
      setLocalRows((rows) =>
        rows.map((r) => (r.id === recordId ? { ...r, values: { ...r.values, [key]: stepId } } : r)),
      );
    }

    try {
      await setPipelineStepAction(moduleSlug, recordId, moduleId, pipelineId, stepId);
      return { ok: true };
    } catch {
      if (key) {
        setLocalRows((rows) => rows.map((r) => (r.id === recordId ? restore(r) : r)));
      }
      return { ok: false, message: 'Could not move that. Nothing was changed.' };
    }
  };

  /*
   * Which columns hold a pipeline step, keyed by the field key the table
   * renders them under. Built from the pipelines this module already passes
   * in for the toolbar filter, so the step picker and the step filter can
   * never disagree about what the steps are — and no module is named here
   * (CLAUDE.md rule 1).
   */
  const pipelineColumns = useMemo(() => {
    const out: Record<
      string,
      { pipelineId: string; steps: { id: string; label: string; swatch: Swatch }[] }
    > = {};
    for (const p of pipelines) out[p.statusFieldKey] = { pipelineId: p.id, steps: p.steps };
    return out;
  }, [pipelines]);

  /** One place that saves a filter change, shared by the pipeline control and
   * DataTable's own column filters, so both reset to page 1 the same way. */
  const commitFilters = (f: Record<string, Filter>) => {
    startTransition(async () => {
      try {
        setPrefError(null);
        await setFiltersAction(moduleSlug, f);
      } catch {
        setPrefError('Your filters could not be saved and will reset on reload.');
      }
      // Back to page 1: the result set just changed size, and staying on
      // page 5 of a set that now has two pages shows an empty table with
      // no explanation.
      resetToFirstPage();
    });
  };

  return (
    <>
      {pipelines.length ? (
        <div className="mb-2.5 flex shrink-0 flex-wrap items-center gap-2">
          <PipelineFilter pipelines={pipelines} filters={filters} onSetFilters={commitFilters} />
        </div>
      ) : null}

      {prefError ? (
        <p role="status" className="mb-1.5 shrink-0 text-[11px] text-ink-500">
          {prefError}
        </p>
      ) : null}

      <DataTable
        // Dimmed while a page change is in flight — a paging click is a full
        // server render, and without this the old page just sits there.
        tableBusy={paging}
        moduleSlug={moduleSlug}
        rows={localRows}
        columns={localColumns}
        onOpen={openRecord}
        openingId={opening ? openingId : null}
        serverPaging={{ page, pageCount, total, onPage: goToPage }}
        selected={selected}
        onSelectedChange={setSelected}
        grantFor={grantFor}
        pipelineColumns={
          /* Withheld outright without module Edit. That is the step picker's
             only permission gate, because the synced Status field's own grant
             is always View — see the note beside `stepEditable`. */
          canEdit ? pipelineColumns : undefined
        }
        onPipelineStep={commitPipelineStep}
        hasCustomColumnOrder={hasCustomColumnOrder}
        onReorderColumns={(ids) => {
          // Reorder the actual `Field` objects synchronously — header label,
          // width, and body-cell mapping are all read from this one array,
          // so this single state update moves the whole column, in one
          // paint, well before the server round trip below resolves.
          const byId = new Map(localColumns.map((c) => [c.id, c]));
          const reordered = ids.map((id) => byId.get(id)).filter((c): c is Field => Boolean(c));
          setLocalColumns(reordered);
          // No follow-up router.refresh(): reorderColumnsAction already
          // calls revalidatePath, and a Server Action invoked inside a
          // transition already carries a fresh RSC payload for this route as
          // part of its own response — a second router.refresh() here would
          // just be another full round trip for data already on its way,
          // same redundant-double-fetch pattern already fixed in
          // RealFieldGrid.tsx's reorder/repeat-group actions.
          startTransition(async () => {
            try {
              setPrefError(null);
              await reorderColumnsAction(moduleSlug, ids);
            } catch {
              setPrefError('Your column order could not be saved and will reset on reload.');
            }
          });
        }}
        onResetColumnOrder={() => {
          startTransition(async () => {
            try {
              setPrefError(null);
              await resetColumnOrderAction(moduleSlug);
            } catch {
              setPrefError('Could not reset the column order.');
            }
          });
        }}
        filters={filters}
        filterOnlyFields={pipelineStatusFields}
        onCellEdit={canEdit ? commitCell : undefined}
        onSetFilters={commitFilters}
        onClearFilters={() => {
          startTransition(async () => {
            try {
              setPrefError(null);
              await clearFiltersAction(moduleSlug);
            } catch {
              setPrefError('Could not clear your saved filters.');
            }
            resetToFirstPage();
          });
        }}
      />

      {canEdit ? (
        <BulkBar
          count={selected.size}
          moduleSlug={moduleSlug}
          onClear={() => setSelected(new Set())}
          onBulkEdit={() => setBulkEditing(true)}
          onArchive={() => setConfirmBulk(allSelectedArchived ? 'restore' : 'archive')}
          onDelete={moduleSlug === 'records' ? () => setConfirmBulk('delete') : undefined}
          allSelectedArchived={allSelectedArchived}
        />
      ) : null}

      <SkipReportPanel report={report} onClose={() => setReport(null)} />

      {bulkEditing ? (
        <BulkEditDialog
          count={selected.size}
          columns={localColumns.filter((c) => grantFor(c) === 'edit')}
          moduleSlug={moduleSlug}
          pending={pending}
          onApply={runBulkEdit}
          onClose={() => setBulkEditing(false)}
        />
      ) : null}

      {confirmBulk === 'archive' ? (
        <Dialog
          title={
            moduleSlug === 'records'
              ? `Archive ${selected.size} records?`
              : `Remove ${selected.size} records from this module?`
          }
          confirmLabel={moduleSlug === 'records' ? 'Archive' : 'Remove'}
          confirmIcon="archive"
          onClose={() => setConfirmBulk(null)}
          onConfirm={runBulkArchive}
        >
          <p>
            {moduleSlug === 'records'
              ? 'These records will no longer appear in any display module. They stay stored here with everything intact.'
              : 'They stop appearing in this module. Any record whose last display membership this clears is archived — it stays in the Records List.'}
          </p>
          <p className="mt-2 text-ink-400">Rows you cannot modify are skipped and listed back to you.</p>
        </Dialog>
      ) : null}

      {confirmBulk === 'delete' ? (
        /*
         * ── WHY THIS DIALOG COUNTS BEFORE IT ASKS ──────────────────────────
         * Delete only ever applies to an ARCHIVED record — `delete_record`
         * refuses anything still in a module with "Archive this record before
         * deleting it". That rule is right and is not what changed here.
         *
         * What changed is when you find out. Every record in the database is
         * currently in at least one module, so every attempt was refused, and
         * the refusal only arrived AFTER confirming a red "Delete" button —
         * which is indistinguishable from the button being broken, and is
         * exactly how it was reported.
         *
         * The rows already carry their memberships (`membershipsForMany` is
         * loaded for the list anyway), so the count is free: say it up front,
         * refuse to arm the button when nothing in the selection can go, and
         * point at Archive, which is the step that was missing.
         */
        (() => {
          const chosen = localRows.filter((r) => selected.has(r.id));
          const stillShown = chosen.filter((r) => (r.memberships?.length ?? 0) > 0);
          const deletable = chosen.length - stillShown.length;

          return (
            <Dialog
              title={
                deletable === 0
                  ? 'Archive these records first'
                  : `Delete ${deletable} record${deletable === 1 ? '' : 's'}?`
              }
              tone="danger"
              confirmLabel={deletable === 0 ? undefined : 'Delete to Recycle Bin'}
              confirmIcon="trash"
              onClose={() => setConfirmBulk(null)}
              onConfirm={deletable === 0 ? undefined : runBulkDelete}
            >
              {deletable === 0 ? (
                <>
                  <p>
                    {stillShown.length === 1
                      ? 'That record is still displayed in a module, so it cannot be deleted yet.'
                      : `All ${stillShown.length} selected records are still displayed in a module, so none of them can be deleted yet.`}
                  </p>
                  <p className="mt-2">
                    Deleting is only ever available on an <strong>archived</strong> record — one that
                    has been removed from every display module and is left stored here. Archive them
                    first, then delete.
                  </p>
                  <p className="mt-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="archive"
                      onClick={() => setConfirmBulk('archive')}
                    >
                      Archive {stillShown.length} instead
                    </Button>
                  </p>
                </>
              ) : (
                <>
                  <p>
                    {deletable === 1 ? 'This record is' : `These ${deletable} records are`} archived and
                    will go to the Recycle Bin.
                  </p>
                  {stillShown.length > 0 ? (
                    <p className="mt-2 text-ink-400">
                      {stillShown.length === 1
                        ? 'One other selected record is'
                        : `${stillShown.length} other selected records are`}{' '}
                      still displayed in a module and will be skipped — archive{' '}
                      {stillShown.length === 1 ? 'it' : 'them'} first.
                    </p>
                  ) : null}
                </>
              )}
            </Dialog>
          );
        })()
      ) : null}

      {confirmBulk === 'restore' ? (
        <RestoreDialog
          count={selected.size}
          displayModules={displayModules}
          pending={pending}
          onApply={runBulkRestore}
          onClose={() => setConfirmBulk(null)}
        />
      ) : null}
    </>
  );
}

function RestoreDialog({
  count,
  displayModules,
  pending,
  onApply,
  onClose,
}: {
  count: number;
  displayModules: { id: string; slug: string; label: string }[];
  pending: boolean;
  onApply: (moduleId: string, moduleSlug: string) => void;
  onClose: () => void;
}) {
  const [moduleId, setModuleId] = useState(displayModules[0]?.id ?? '');
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={onClose} />
      <div className="relative w-full max-w-[440px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]">
        <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink-900">
          <Icon name="rotate-ccw" size={16} className="text-ink-400" />
          Restore {count} record{count === 1 ? '' : 's'}
        </h2>
        <SpecNote>
          These records are fully archived — no display module currently shows them. Pick which
          module to add them back into.
        </SpecNote>

        <label className="mt-4 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
          Add to module
        </label>
        <select
          value={moduleId}
          onChange={(e) => setModuleId(e.target.value)}
          className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
        >
          {displayModules.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            icon="rotate-ccw"
            loading={pending}
            loadingLabel="Restoring…"
            disabled={!moduleId}
            onClick={() => onApply(moduleId, displayModules.find((m) => m.id === moduleId)?.slug ?? '')}
          >
            Restore
          </Button>
        </div>
      </div>
    </div>
  );
}

function BulkEditDialog({
  count,
  columns,
  moduleSlug,
  pending,
  onApply,
  onClose,
}: {
  count: number;
  columns: Field[];
  /** Needed for the same reason the drawer needs it: a field's options can
   * differ per module ("different statuses per module"). Reading `field.choices`
   * directly, as this did, offered the GLOBAL set in a module that has its own
   * override — so a bulk edit in Leads listed Urgent/High/Mid/Low, none of
   * which are Leads statuses. */
  moduleSlug: string;
  pending: boolean;
  onApply: (fieldKey: string, value: unknown) => void;
  onClose: () => void;
}) {
  const [fieldId, setFieldId] = useState(columns[0]?.id ?? '');
  const [value, setValue] = useState('');
  /** `team_member` only — its value is a list of ids, not a scalar, so it needs
   * its own state rather than a parse of `value`. */
  const [members, setMembers] = useState<string[]>([]);
  const people = usePeople();
  const byId = usePeopleById();
  const field = columns.find((c) => c.id === fieldId);
  const options = field ? choicesFor(field, moduleSlug) : [];
  const numeric = field?.type === 'currency' || field?.type === 'number' || field?.type === 'percentage';
  const teamMember = field?.type === 'team_member';
  /* `multi_select` and `months` store an ARRAY of choice keys. This dialog was
   * writing a bare string into them: the choice picker below stores one key,
   * and `months` has no `field_choices` rows at all so it fell through to the
   * free-text box. `CellValue` then called `.slice(...).map(...)` on a string
   * and threw — in the records table, which sits above every error boundary,
   * so it took the whole module page down. The value was already saved by
   * then, so the page crashed again on every later visit with no way to undo
   * it from the UI.
   *
   * The renderers are now defensive too (`asChoiceArray`), but writing the
   * right shape is the actual fix; tolerating the wrong one is the safety net.
   */
  const multi = field?.type === 'multi_select' || field?.type === 'months';
  const checkbox = field?.type === 'checkbox';
  const dateLike = field?.type === 'date' || field?.type === 'datetime';

  /** The stored shape for the chosen field, built from whichever control was
   * shown. One place, so the button below cannot disagree with the input. */
  const valueToApply = (): unknown => {
    if (teamMember) return members;
    if (multi) return value ? [value] : [];
    if (checkbox) return value === 'true';
    if (numeric) return Math.max(0, Number(value));
    return value;
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={onClose} />
      <div className="relative w-full max-w-[480px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]">
        <h2 className="flex items-center gap-2 text-[16px] font-semibold text-ink-900">
          <Icon name="pencil" size={16} className="text-ink-400" />
          Bulk edit {count} records
        </h2>
        <SpecNote>
          Only fields you hold <strong>Edit</strong> on appear in this list. Fields at View or Hidden
          are absent entirely, not disabled.
        </SpecNote>

        <label className="mt-4 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Field</label>
        <select
          value={fieldId}
          onChange={(e) => {
            setFieldId(e.target.value);
            setValue('');
            setMembers([]);
          }}
          className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>

        <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Set to</label>
        {teamMember ? (
          /*
           * A bulk edit of the team-member field REPLACES each record's team —
           * `bulk_set_values` sets the key, it does not merge — so this is the
           * single largest permission change the app can make in one click, and
           * the panel says exactly that rather than looking like any other bulk
           * edit. The old plain text input here wrote a bare string, which
           * `sync_record_team_members()` then failed to iterate as an array.
           */
          <div className="mt-1">
            <div className="max-h-[180px] space-y-px overflow-y-auto rounded-md border border-line p-1">
              {people
                .filter((p) => !p.suspended)
                .map((p) => {
                  const on = members.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] transition-colors ${
                        on ? 'bg-brand-50' : 'hover:bg-canvas'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setMembers((prev) => (on ? prev.filter((x) => x !== p.id) : [...prev, p.id]))
                        }
                        className="size-3.5 accent-[#1d4ed8]"
                      />
                      <PersonAvatar person={resolvePerson(p.id, byId)} size={20} />
                      <span className="truncate font-medium text-ink-900">{p.name}</span>
                      {p.email && p.email !== p.name ? (
                        <span className="ml-auto shrink-0 truncate text-[11px] text-ink-400">{p.email}</span>
                      ) : null}
                    </label>
                  );
                })}
            </div>
            {/* Only the field that actually grants visibility gets the
                visibility warning — `relationship_manager` is the same type and
                is informational, so the same sentence there would be a scare
                about a consequence that does not exist. */}
            {field?.id === VISIBILITY_FIELD_KEY ? (
              <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-[#8a5a09]">
                <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
                <span>
                  This <strong>replaces</strong> the team on all {count} records — anyone currently
                  assigned and not ticked here loses sight of them.
                  {members.length === 0
                    ? ' With nobody ticked, only admins will be able to see them.'
                    : ''}
                </span>
              </p>
            ) : (
              <p className="mt-1.5 text-[11.5px] text-ink-400">
                Replaces this field on all {count} records.
              </p>
            )}
          </div>
        ) : checkbox ? (
          /* A checkbox column is a boolean. The free-text box wrote the STRING
             "true", which reads back as a checked box no matter what it says. */
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
          >
            <option value="">— choose —</option>
            <option value="true">Checked</option>
            <option value="false">Unchecked</option>
          </select>
        ) : dateLike ? (
          <input
            type={field?.type === 'datetime' ? 'datetime-local' : 'date'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
          />
        ) : options.length ? (
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
          >
            <option value="">— choose —</option>
            {/* Stores the choice key, shows the label — same contract as the
                drawer's own picker. */}
            {options.map((c) => (
              <option key={choiceKey(c)} value={choiceKey(c)}>{c.value}</option>
            ))}
          </select>
        ) : multi ? (
          /* No configured choices (which is the normal state for `months`)
             means there is nothing safe to offer — a typed value would not
             match any key the column renders. Say so rather than accepting
             input that cannot be right. */
          <p className="mt-1 rounded-md border border-line bg-canvas px-3 py-2 text-[12.5px] text-ink-400">
            This column has no configured options, so it cannot be set in bulk.
            Edit it on each record instead.
          </p>
        ) : numeric ? (
          <NumberInput
            value={value}
            max={field?.type === 'percentage' ? 100 : undefined}
            onLiveChange={(n) => setValue(n == null ? '' : String(n))}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
          />
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            icon="check"
            // An empty team is a legitimate thing to set (it is what every
            // record reaches when its last member leaves), so this control is
            // not disabled on an empty selection the way an empty text value is
            // — the warning above says what it means.
            loading={pending}
            disabled={!fieldId || (!teamMember && value === '')}
            onClick={() => onApply(fieldId, valueToApply())}
          >
            {pending ? 'Applying…' : `Apply to ${count} records`}
          </Button>
        </div>
      </div>
    </div>
  );
}
