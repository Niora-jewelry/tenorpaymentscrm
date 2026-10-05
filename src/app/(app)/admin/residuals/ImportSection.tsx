'use client';

/**
 * Importing a processor fee report.
 *
 * ── THE FILE LIVES IN REACT STATE, NOT IN A FORM ─────────────────────────
 * Two round trips need the same upload: one to read the headers, one to commit
 * the mapped rows. A `<form action={...}>` would lose the `File` between them,
 * so the input writes to state and each step builds its own FormData. That is
 * also what keeps the file out of the committed rows' provenance — the rows
 * are parsed from the bytes on the server both times, never sent down and
 * trusted back up.
 *
 * ── NOTHING HERE DOES ARITHMETIC ─────────────────────────────────────────
 * The sample cells and the import counts are printed as they arrive. The
 * module's standing rule: money crosses as text, the client formats, it never
 * computes. A total row on this screen would mean adding money in JavaScript.
 *
 * ── A SKIPPED MERCHANT IS NOT AN ERROR, AND IS NOT A SUCCESS EITHER ──────
 * The result panel says both things separately: the lines imported, and the
 * merchants the engine refused to cost because it has no rates for them.
 * Collapsing those into one verdict is how a month with a hole in it gets
 * trusted.
 */
import { useActionState, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, OutlineChip, StatusPill } from '@/proto/ui/kit';
import {
  POISONED_TARGETS,
  REQUIRED_TARGETS,
  TARGETS,
  TARGET_LABEL,
  type Target,
} from '@/lib/residuals/mapping';
import type { ComputeSummary, SheetPreview } from '@/lib/records/residualImport';
import { Panel, PanelHead } from './ResidualsTabs';
import {
  commitImportAction,
  previewImportAction,
  type CommitState,
  type PreviewState,
} from './importActions';

function monthLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** `2026-05-01` <-> the `YYYY-MM` an `<input type="month">` carries. */
const toInputMonth = (iso: string) => iso.slice(0, 7);
const fromInputMonth = (v: string) => (v === '' ? '' : `${v}-01`);

/**
 * ── WHY A KEYED INNER COMPONENT ──────────────────────────────────────────
 * "Import another" has to clear the chosen file, the mapping, AND both
 * `useActionState` results. There is no reset for an action state, so the
 * wizard is remounted under a new key instead — which is the one mechanism
 * that cannot leave a stale result behind. `router.refresh()` alongside it
 * re-reads the server data, so the Periods tab shows the month that was just
 * imported rather than the list from before it.
 */
export function ImportSection({ processors }: { processors: string[] }) {
  const [generation, setGeneration] = useState(0);
  const router = useRouter();

  return (
    <Wizard
      key={generation}
      processors={processors}
      onAnother={() => {
        router.refresh();
        setGeneration((n) => n + 1);
      }}
    />
  );
}

function Wizard({
  processors,
  onAnother,
}: {
  processors: string[];
  onAnother: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [processor, setProcessor] = useState(processors[0] ?? 'MAVERICK');
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [month, setMonth] = useState('');
  const [mapping, setMapping] = useState<Record<number, Target | ''>>({});
  const [saveTemplate, setSaveTemplate] = useState(true);

  const [preview, runPreview, previewing] = useActionState<PreviewState, FormData>(
    previewImportAction,
    { status: 'idle' },
  );
  const [commit, runCommit, committing] = useActionState<CommitState, FormData>(
    commitImportAction,
    { status: 'idle' },
  );
  const [, startTransition] = useTransition();

  const sheets = preview.status === 'ready' ? preview.preview.sheets : [];
  const sheet: SheetPreview | undefined =
    sheets.find((s) => s.name === sheetName) ?? sheets.find((s) => s.headers.length > 0) ?? sheets[0];

  /* The suggestion the server made, as the initial selection. */
  const suggested = useMemo(() => {
    if (preview.status !== 'ready') return {} as Record<number, Target | ''>;
    const out: Record<number, Target | ''> = {};
    for (const s of preview.preview.suggestions) out[s.index] = s.saved ?? s.suggested ?? '';
    return out;
  }, [preview]);

  /*
   * `mapping` starts empty and is only written by the selects, so an untouched
   * column reads from `suggested`. That keeps "what the server proposed" and
   * "what the operator changed" separable, which is what makes re-reading the
   * file not throw away their edits to the columns they did touch.
   */
  const effective = (index: number): Target | '' =>
    index in mapping ? mapping[index] : (suggested[index] ?? '');

  const chosenTargets = useMemo(() => {
    const out = new Map<number, Target>();
    if (!sheet) return out;
    sheet.headers.forEach((_, index) => {
      const t = effective(index);
      if (t !== '') out.set(index, t);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, mapping, suggested]);

  const duplicated = useMemo(() => {
    const seen = new Map<Target, number>();
    const dupes = new Set<Target>();
    for (const t of chosenTargets.values()) {
      seen.set(t, (seen.get(t) ?? 0) + 1);
      if ((seen.get(t) ?? 0) > 1) dupes.add(t);
    }
    return dupes;
  }, [chosenTargets]);

  const missingRequired = REQUIRED_TARGETS.filter(
    (t) => ![...chosenTargets.values()].includes(t),
  );

  const detected = sheet?.detectedMonths ?? [];
  const monthMismatch =
    month !== '' && detected.length === 1 && detected[0] !== month ? detected[0] : null;

  /* ── step 1 ─────────────────────────────────────────────────────────── */
  const read = (nextSheet?: string) => {
    if (!file) return;
    const fd = new FormData();
    fd.set('file', file);
    fd.set('processor', processor);
    if (nextSheet) fd.set('sheet', nextSheet);
    startTransition(() => runPreview(fd));
  };

  /* ── step 2 ─────────────────────────────────────────────────────────── */
  const send = (replaceExisting: boolean) => {
    if (!file || !sheet) return;
    const fd = new FormData();
    fd.set('file', file);
    fd.set('processor', processor);
    fd.set('sheet', sheet.name);
    fd.set('month', month);
    fd.set('mapping', JSON.stringify(Object.fromEntries(chosenTargets)));
    if (saveTemplate) fd.set('saveTemplate', 'on');
    if (replaceExisting) fd.set('replaceExisting', 'on');
    startTransition(() => runCommit(fd));
  };

  const busy = previewing || committing;

  /* ── the result, once there is one ──────────────────────────────────── */
  if (commit.status === 'done') {
    return <Done state={commit} onAnother={onAnother} />;
  }

  return (
    <div className="space-y-4">
      {/* ── choose a file ─────────────────────────────────────────────── */}
      <Panel>
        <PanelHead>
          <h2 className="text-[14px] font-semibold text-ink-900">The fee report</h2>
          {processors.length > 1 ? (
            <select
              value={processor}
              onChange={(e) => setProcessor(e.target.value)}
              aria-label="Processor"
              className="rounded-lg border border-line bg-white px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus-field"
            >
              {processors.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <OutlineChip tone="brand">{processor}</OutlineChip>
          )}
        </PanelHead>

        <div className="space-y-3 p-4">
          <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border border-dashed border-line px-4 py-4 transition-colors hover:border-ink-400 hover:bg-canvas">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-canvas text-ink-500">
              <Icon name="upload" size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-ink-900">
                {file ? file.name : 'Choose the processor’s fee report'}
              </span>
              <span className="block text-[12px] text-ink-400">
                {file
                  ? `${(file.size / 1024).toFixed(0)} KB — click to choose a different file`
                  : '.xlsx or .xls — not CSV, which would round the figures. Nothing is written until you confirm the columns.'}
              </span>
            </span>
            <input
              type="file"
              /*
                No CSV. The handoff is explicit and the reason is arithmetic: a
                CSV export writes the DISPLAYED text, so a merchant-rates cell
                holding 0.033816 exports as "3.38%" — "both a 100x scale error
                and silent precision loss". Reading the .xlsx takes the cell
                value instead.
              */
              accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                /* A new file means the old suggestions and the old sheet
                   choice describe a different workbook. */
                setMapping({});
                setSheetName(null);
              }}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              icon="search"
              disabled={!file || busy}
              loading={previewing}
              loadingLabel="Reading…"
              onClick={() => read()}
            >
              Read the file
            </Button>
            {preview.status === 'ready' ? (
              <span className="text-[12px] text-ink-400">
                {preview.preview.hasSavedTemplate
                  ? 'Columns pre-filled from the saved mapping for this processor.'
                  : 'Columns suggested from their names — check each one.'}
              </span>
            ) : null}
          </div>

          {preview.status === 'error' ? (
            <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-danger">
              <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
              {preview.message}
            </p>
          ) : null}
        </div>
      </Panel>

      {/* ── confirm sheet, month and columns ──────────────────────────── */}
      {preview.status === 'ready' && sheet ? (
        <>
          <Panel>
            <PanelHead>
              <h2 className="text-[14px] font-semibold text-ink-900">Which sheet, and which month</h2>
              {/* Which row it read as the header. The one fact that tells an
                  operator at a glance whether the parser found the real
                  header or a line of the title block. */}
              <span className="text-[12px] text-ink-400">
                header on row {sheet.headerRow} &middot; {sheet.rowCount} row
                {sheet.rowCount === 1 ? '' : 's'} below it
              </span>
            </PanelHead>

            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="residual-import-sheet"
                  className="block text-[12.5px] font-medium text-ink-700"
                >
                  Sheet
                </label>
                <select
                  id="residual-import-sheet"
                  value={sheet.name}
                  onChange={(e) => {
                    setSheetName(e.target.value);
                    setMapping({});
                    read(e.target.value);
                  }}
                  disabled={busy}
                  className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
                >
                  {sheets.map((s) => (
                    <option key={s.name} value={s.name} disabled={s.headers.length === 0}>
                      {s.name}
                      {s.headers.length === 0 ? ' — no header row found' : ` (${s.rowCount} rows)`}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="residual-import-month"
                  className="block text-[12.5px] font-medium text-ink-700"
                >
                  Statement month
                </label>
                <input
                  id="residual-import-month"
                  type="month"
                  value={toInputMonth(month)}
                  onChange={(e) => setMonth(fromInputMonth(e.target.value))}
                  disabled={busy}
                  className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
                />
                {/*
                  A cross-check, not the answer. No column in the file is
                  authoritative for the month — `period_id` is deliberately not
                  a mappable field — so this says what the file appears to hold
                  and leaves the decision stated rather than inferred.
                */}
                {detected.length > 0 ? (
                  <p className="mt-1.5 text-[11.5px] leading-snug text-ink-400">
                    Dates in this sheet fall in{' '}
                    {detected.map((m) => monthLabel(m)).join(' and ')}.
                    {month === '' ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          onClick={() => setMonth(detected[0])}
                          className="cursor-pointer font-medium text-brand-700 underline decoration-brand-700/30 hover:decoration-brand-700"
                        >
                          Use {monthLabel(detected[0])}
                        </button>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {monthMismatch ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-[#8a5a09]">
                    <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
                    The dates in this file are {monthLabel(monthMismatch)}, not{' '}
                    {monthLabel(month)}. Importing it anyway files the processor&rsquo;s{' '}
                    {monthLabel(monthMismatch)} figures under {monthLabel(month)}.
                  </p>
                ) : null}
              </div>
            </div>
          </Panel>

          <MappingPanel
            sheet={sheet}
            value={effective}
            onChange={(index, target) => setMapping((m) => ({ ...m, [index]: target }))}
            duplicated={duplicated}
            disabled={busy}
          />

          <Panel>
            <div className="space-y-3 p-4">
              <label className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-relaxed text-ink-700">
                <input
                  type="checkbox"
                  checked={saveTemplate}
                  onChange={(e) => setSaveTemplate(e.target.checked)}
                  className="mt-[3px] size-[14px] cursor-pointer accent-brand-600"
                />
                <span>
                  Remember these columns for {processor}
                  <span className="block text-[11.5px] text-ink-400">
                    Next month&rsquo;s file is pre-filled from this. Saved only if the import
                    succeeds.
                  </span>
                </span>
              </label>

              {missingRequired.length > 0 ? (
                <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-ink-500">
                  <Icon name="info" size={13} className="mt-[2px] shrink-0" />
                  {missingRequired.map((t) => TARGET_LABEL[t].label).join(' and ')}{' '}
                  {missingRequired.length === 1 ? 'is' : 'are'} not mapped yet. The engine matches
                  rules on the fee item and keys everything else on the MID, so rows without them
                  import and then sit uncalculated.
                </p>
              ) : null}

              {duplicated.size > 0 ? (
                <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-danger">
                  <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
                  {[...duplicated].map((t) => TARGET_LABEL[t].label).join(', ')} is mapped twice.
                  Each field takes one column.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  icon="check"
                  disabled={busy || month === '' || missingRequired.length > 0 || duplicated.size > 0}
                  loading={committing}
                  loadingLabel="Importing…"
                  onClick={() => send(false)}
                >
                  Import and compute
                </Button>
                <span className="text-[12px] text-ink-400">
                  {sheet.rowCount} row{sheet.rowCount === 1 ? '' : 's'}, then the engine runs over
                  the month.
                </span>
              </div>

              {commit.status === 'error' ? (
                <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-danger">
                  <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
                  {commit.message}
                </p>
              ) : null}

              {commit.status === 'blocked' ? (
                <Blocked state={commit} onReplace={() => send(true)} busy={busy} />
              ) : null}
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * The mapping grid
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One row per column in the file.
 *
 * The sample cells are here because a header alone does not settle it: two
 * columns called "Amount" and "Fee Amount" are told apart by what is in them,
 * and a column of MIDs that Excel stored as numbers looks wrong until you can
 * see it reads as digits.
 */
function MappingPanel({
  sheet,
  value,
  onChange,
  duplicated,
  disabled,
}: {
  sheet: SheetPreview;
  value: (index: number) => Target | '';
  onChange: (index: number, target: Target | '') => void;
  duplicated: ReadonlySet<Target>;
  disabled: boolean;
}) {
  const mappedCount = sheet.headers.filter((_, i) => value(i) !== '').length;

  return (
    <Panel>
      <PanelHead>
        <h2 className="text-[14px] font-semibold text-ink-900">
          Columns{' '}
          <span className="ml-1 font-normal text-ink-400">
            ({mappedCount} of {sheet.headers.length} mapped)
          </span>
        </h2>
        <span className="text-[12px] text-ink-400">Anything left unmapped is not imported.</span>
      </PanelHead>

      <div className="max-h-[520px] overflow-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-line-soft text-[11.5px] uppercase tracking-wide text-ink-400">
              <th className="px-4 py-2 font-semibold">Column in the file</th>
              <th className="px-4 py-2 font-semibold">First rows</th>
              <th className="px-4 py-2 font-semibold">Imports as</th>
            </tr>
          </thead>
          <tbody>
            {sheet.headers.map((header, index) => {
              const current = value(index);
              const isDupe = current !== '' && duplicated.has(current);
              return (
                <tr key={`${header}-${index}`}>
                  <td className="border-b border-line-faint px-4 py-2 align-top">
                    <span className="block text-[13px] font-medium text-ink-900">
                      {header.trim() === '' ? (
                        <span className="text-ink-300">(no name)</span>
                      ) : (
                        header
                      )}
                    </span>
                    {/* Said out loud when it matters: a header with edge
                        whitespace is stored verbatim, and that is how the
                        saved template keeps matching next month. */}
                    {header !== header.trim() && header.trim() !== '' ? (
                      <span className="text-[11px] text-ink-400">
                        stored with its surrounding spaces, exactly as the file has it
                      </span>
                    ) : null}
                  </td>
                  <td className="border-b border-line-faint px-4 py-2 align-top">
                    <span className="block max-w-[32ch] truncate text-[12.5px] tabular text-ink-500">
                      {sheet.sample
                        .map((r) => r[index])
                        .filter((v) => v !== null && v !== '')
                        .slice(0, 3)
                        .map((v) => String(v))
                        .join(' · ') || <span className="text-ink-300">empty</span>}
                    </span>
                  </td>
                  <td className="border-b border-line-faint px-4 py-2 align-top">
                    <select
                      value={current}
                      disabled={disabled}
                      aria-label={`What ${header || `column ${index + 1}`} imports as`}
                      onChange={(e) => onChange(index, e.target.value as Target | '')}
                      className={`w-full max-w-[260px] rounded-lg border bg-white px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus-field ${
                        isDupe ? 'border-[#e3989d]' : 'border-line'
                      }`}
                    >
                      <option value="">— not imported —</option>
                      {TARGETS.map((t) => (
                        <option key={t} value={t}>
                          {TARGET_LABEL[t].label}
                        </option>
                      ))}
                    </select>
                    {current !== '' ? (
                      <span className="mt-1 block max-w-[34ch] text-[11px] leading-snug text-ink-400">
                        {TARGET_LABEL[current].hint}
                      </span>
                    ) : null}
                    {/*
                      Shown on selection, not as a refusal. The column is
                      importable — it is attribution, and the engine costs from
                      the template schedule regardless — but a reader comparing
                      it to a template rate will find a variance that is not
                      there, which has happened three times.
                    */}
                    {current !== '' && POISONED_TARGETS[current] ? (
                      <span className="mt-1 flex max-w-[34ch] items-start gap-1 text-[11px] leading-snug text-[#8a5a09]">
                        <Icon name="alert-triangle" size={11} className="mt-[2px] shrink-0" />
                        {POISONED_TARGETS[current]}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Refusals
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Each refusal says what it found and what to do about it.
 *
 * `needs_replace` is the only one with a button, and it is deliberately not a
 * default: the partial unique index that makes a second completed import of
 * one month impossible exists so that replacing one is a decision somebody
 * states.
 */
function Blocked({
  state,
  onReplace,
  busy,
}: {
  state: Extract<CommitState, { status: 'blocked' }>;
  onReplace: () => void;
  busy: boolean;
}) {
  const r = state.result;

  if (r.reason === 'needs_replace') {
    return (
      <div className="rounded-xl border border-[#f7e0af] bg-[#fdf1d8] px-4 py-3.5 text-[#8a5a09]">
        <p className="flex items-center gap-1.5 text-[13.5px] font-semibold">
          <Icon name="alert-triangle" size={14} strokeWidth={2} />
          That month has already been imported
        </p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed">
          {r.existing.originalFilename ? `“${r.existing.originalFilename}”` : 'An earlier file'} is
          on file for this processor and month
          {r.existing.rowCount !== null ? `, with ${r.existing.rowCount} lines` : ''}
          {r.existing.processedAt
            ? `, imported ${new Date(r.existing.processedAt).toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}`
            : ''}
          . Replacing it retires those lines and the import record that wrote them — both are kept,
          soft-deleted, so the history of what was loaded when stays intact.
        </p>
        <div className="mt-2.5">
          <Button size="sm" variant="danger" icon="rotate-ccw" disabled={busy} onClick={onReplace}>
            Replace the previous import
          </Button>
        </div>
      </div>
    );
  }

  if (r.reason === 'row_errors') {
    return (
      <div className="overflow-hidden rounded-xl border border-[#f7cfd1]">
        <p className="flex items-center gap-1.5 border-b border-[#f7cfd1] bg-[#fce9ea] px-3.5 py-2.5 text-[13px] font-semibold text-[#b02a30]">
          <Icon name="alert-triangle" size={14} />
          {r.totalErrors} cell{r.totalErrors === 1 ? '' : 's'} could not be read as a number
        </p>
        <p className="px-3.5 py-2 text-[12px] leading-relaxed text-ink-500">
          Nothing was imported. A cell in a money or count column has to read as a number — the
          importer will not book an unreadable one as zero, because a cost of zero and a cost it
          could not read are not the same claim. Accounting formats are fine:{' '}
          <span className="tabular">$1,234.56</span> and <span className="tabular">(375.32)</span>{' '}
          both read.
        </p>
        <table className="w-full text-left">
          <thead>
            <tr className="border-y border-line-soft text-[11.5px] uppercase tracking-wide text-ink-400">
              <th className="px-3.5 py-1.5 font-semibold">Row</th>
              <th className="px-3.5 py-1.5 font-semibold">Column</th>
              <th className="px-3.5 py-1.5 font-semibold">Holds</th>
            </tr>
          </thead>
          <tbody>
            {r.errors.map((e, i) => (
              <tr key={`${e.sheetRow}-${e.target}-${i}`}>
                <td className="border-b border-line-faint px-3.5 py-1.5 text-[12.5px] tabular text-ink-700">
                  {e.sheetRow}
                </td>
                <td className="border-b border-line-faint px-3.5 py-1.5 text-[12.5px] text-ink-700">
                  {e.header}
                </td>
                <td className="border-b border-line-faint px-3.5 py-1.5 text-[12.5px] tabular text-danger">
                  {e.raw}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.totalErrors > r.errors.length ? (
          <p className="px-3.5 py-2 text-[11.5px] text-ink-400">
            {r.totalErrors - r.errors.length} more not listed.
          </p>
        ) : null}
      </div>
    );
  }

  const message =
    r.reason === 'no_rows'
      ? 'That sheet has no rows with a MID in them. Check the MID column is mapped to the right column.'
      : r.reason === 'too_many_rows'
        ? `That sheet has ${r.rowCount} rows, which is more than a fee report. Check it is the right file and the right sheet.`
        : r.reason === 'missing_targets'
          ? `${r.missing.map((t) => TARGET_LABEL[t].label).join(' and ')} must be mapped before anything can be imported.`
          : r.reason === 'no_sheet'
            ? 'That sheet is no longer in the file. Read the file again.'
            : r.message;

  return (
    <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-danger">
      <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
      {message}
    </p>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * The result
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What landed, and what the engine then made of it.
 *
 * The two are reported separately on purpose. "197 lines imported" and "the
 * month is not stamped because four merchants have no rates" are both true at
 * once, and a single green tick covering both is how a month with a hole in it
 * gets signed off.
 */
function Done({
  state,
  onAnother,
}: {
  state: Extract<CommitState, { status: 'done' }>;
  onAnother: () => void;
}) {
  const compute = state.compute;

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead>
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-900">
            <Icon name="check" size={14} strokeWidth={2.5} className="text-ok" />
            Imported
          </h2>
          <Button size="sm" variant="ghost" icon="upload" onClick={onAnother}>
            Import another
          </Button>
        </PanelHead>

        <ul className="divide-y divide-line-faint">
          <Fact
            label={`${state.inserted} line${state.inserted === 1 ? '' : 's'} written`}
            detail="One row per fee item per merchant, exactly as the file had them."
          />
          {state.swept > 0 ? (
            <Fact
              label={`${state.swept} earlier line${state.swept === 1 ? '' : 's'} retired`}
              detail="Soft-deleted in the same transaction, so the month holds one set of figures and the previous set is still recoverable."
            />
          ) : null}
          {state.skippedNoMid > 0 ? (
            <Fact
              label={`${state.skippedNoMid} row${state.skippedNoMid === 1 ? '' : 's'} skipped for having no MID`}
              detail="Usually the file's own total rows. Nothing keys on a blank MID, so they are not imported."
            />
          ) : null}
        </ul>
      </Panel>

      {compute === null ? null : !compute.ok ? (
        <div className="overflow-hidden rounded-xl border border-[#f7cfd1]">
          <p className="flex items-center gap-1.5 border-b border-[#f7cfd1] bg-[#fce9ea] px-4 py-2.5 text-[13px] font-semibold text-[#b02a30]">
            <Icon name="alert-triangle" size={14} />
            The lines are in, but the engine did not run
          </p>
          <p className="px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-500">
            {compute.message}
            <span className="mt-1 block text-ink-400">
              The import itself is committed and does not need repeating. Re-run the calculation
              from the Periods tab once the cause is fixed.
            </span>
          </p>
        </div>
      ) : (
        <ComputeResultPanel summary={compute.summary} />
      )}
    </div>
  );
}

function Fact({ label, detail }: { label: string; detail: string }) {
  return (
    <li className="px-4 py-2.5">
      <p className="text-[13px] font-medium text-ink-900">{label}</p>
      <p className="mt-0.5 max-w-[78ch] text-[12px] leading-relaxed text-ink-400">{detail}</p>
    </li>
  );
}

/** reason_code -> what it means to somebody who has to act on it. */
const REASON_LABEL: Record<string, string> = {
  no_merchant_rates: 'No rates on file for the merchant',
  no_registry: 'No calculation rules in force for that month',
  no_rule: 'The fee item matches no calculation rule',
  no_buy_rate: 'No buy rate on file for the fee item at that risk tier',
  no_rate: 'A rate the rule needs is blank on the merchant',
  no_volumes: 'The month has no volume figures for the merchant',
  no_tier: 'The merchant has no risk level set',
};

function ComputeResultPanel({ summary }: { summary: ComputeSummary }) {
  const reasons = Object.entries(summary.failuresByReason);

  return (
    <Panel>
      <PanelHead>
        <h2 className="text-[14px] font-semibold text-ink-900">Calculated</h2>
        {summary.stamped ? (
          <StatusPill label={`Version ${summary.calculationVersion}`} swatch="teal" dot={false} />
        ) : (
          <OutlineChip>Not stamped</OutlineChip>
        )}
      </PanelHead>

      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat n={summary.linesComputed} label="Lines computed" />
        <Stat n={summary.merchantsComputed} label="Merchants computed" />
        <Stat n={summary.linesFailed} label="Lines skipped" tone={summary.linesFailed > 0} />
        <Stat
          n={summary.merchantsFailed}
          label="Merchants skipped"
          tone={summary.merchantsFailed > 0}
        />
      </div>

      {summary.registry ? (
        <p className="border-t border-line-faint px-4 py-2 text-[11.5px] text-ink-400">
          Rules used: {summary.registry}
        </p>
      ) : null}

      {reasons.length > 0 ? (
        <div className="border-t border-line-faint px-4 py-3">
          <p className="text-[12.5px] font-semibold text-ink-700">Why those were skipped</p>
          <ul className="mt-1.5 space-y-1">
            {reasons.map(([code, n]) => (
              <li key={code} className="flex items-start gap-2 text-[12.5px] text-ink-500">
                <span className="tabular font-medium text-ink-700">{n}</span>
                <span>{REASON_LABEL[code] ?? code}</span>
              </li>
            ))}
          </ul>
          {/*
            The sentence that decides whether a reader trusts the month. A
            skipped merchant is not a bug and not a rounding difference — it is
            a figure the engine declined to invent.
          */}
          <p className="mt-2 max-w-[78ch] text-[11.5px] leading-relaxed text-ink-400">
            Those merchants are not costed at zero — they are left uncalculated and recorded, and
            the month stays unstamped until every one of them resolves. Fill in what is missing and
            re-run the calculation from the Periods tab.
          </p>
        </div>
      ) : (
        <p className="border-t border-line-faint px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-400">
          Every merchant and every line computed, so the month carries a calculation version. That
          version is what the rest of the module treats as a standing claim that these figures are
          current.
        </p>
      )}
    </Panel>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: boolean }) {
  return (
    <div className="rounded-xl border border-line-soft px-3.5 py-3">
      <p
        className={`text-[20px] font-semibold tabular leading-none ${
          tone ? 'text-[#8a5a09]' : 'text-ink-900'
        }`}
      >
        {n}
      </p>
      <p className="mt-1.5 text-[12.5px] font-medium text-ink-700">{label}</p>
    </div>
  );
}

/* Exported for the Periods tab, which needs the same vocabulary. */
export { REASON_LABEL };
