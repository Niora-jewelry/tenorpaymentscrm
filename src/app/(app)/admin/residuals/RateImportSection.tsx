'use client';

/**
 * Importing a sheet of merchant rates.
 *
 * ── THE DRY RUN IS A STEP, NOT A PREVIEW PANE ────────────────────────────
 * `residual_preview_merchant_rates_import` runs the REAL commit in a
 * subtransaction and throws the writes away. So the numbers it reports —
 * inserted, unchanged, closed — are the numbers the commit will produce, and
 * every refusal arrives with the RPC's own message before anything is written.
 *
 * That is worth a deliberate step rather than hiding behind the commit button.
 * This sheet reprices up to 34 merchants at once and can close a rate version
 * a signed-off month depends on; "check, then commit" is the shape of the
 * operation, so it is the shape of the screen.
 *
 * ── THREE OUTCOMES, NOT TWO ──────────────────────────────────────────────
 * `inserted` is a new dated version. `unchanged` is a merchant whose rates
 * already match — no successor opened, which is why re-importing the same
 * sheet is safe and says so. `closed` is a predecessor ended so a successor
 * could begin. Collapsing them into "34 rows imported" would hide that
 * nothing happened, or that thirty histories just forked.
 *
 * ── NOTHING HERE PARSES A RATE ───────────────────────────────────────────
 * Values cross as text and PostgreSQL casts them. A rate is multiplied by a
 * count, so a float round trip is real money on a busy merchant.
 */
import { useActionState, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, StatusPill } from '@/proto/ui/kit';
import {
  RATE_IMPORT_FIELD,
  RATE_IMPORT_GROUPS,
  RATE_IMPORT_REQUIRED,
  RATES_SHEET_HINT,
  splitRejection,
} from '@/lib/residuals/rateImport';
import { Panel, PanelHead } from './ResidualsTabs';
import {
  commitRateImportAction,
  dryRunRateImportAction,
  previewRateSheetAction,
  type RateCommitState,
  type RatePreviewState,
  type RateSheetPreview,
} from './rateImportActions';

const toInputMonth = (iso: string) => iso.slice(0, 7);
const fromInputMonth = (v: string) => (v === '' ? '' : `${v}-01`);

function monthLabel(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function RateImportSection() {
  const [generation, setGeneration] = useState(0);
  const router = useRouter();

  return (
    <Wizard
      key={generation}
      onAnother={() => {
        router.refresh();
        setGeneration((n) => n + 1);
      }}
    />
  );
}

function Wizard({ onAnother }: { onAnother: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [month, setMonth] = useState('');
  const [mapping, setMapping] = useState<Record<number, string | ''>>({});

  const [preview, runPreview, previewing] = useActionState<RatePreviewState, FormData>(
    previewRateSheetAction,
    { status: 'idle' },
  );
  const [outcome, runCommit, committing] = useActionState<RateCommitState, FormData>(
    /*
     * One state for both the dry run and the commit, because they are two
     * attempts at one decision and the screen should never show a stale dry
     * run beside a fresh refusal. Which action ran is carried by the result's
     * own status.
     */
    async (prev, fd) =>
      fd.get('intent') === 'commit'
        ? commitRateImportAction(prev, fd)
        : dryRunRateImportAction(prev, fd),
    { status: 'idle' },
  );
  const [, startTransition] = useTransition();

  const sheets = preview.status === 'ready' ? preview.sheets : [];
  const sheet: RateSheetPreview | undefined =
    sheets.find((s) => s.name === sheetName) ??
    sheets.find((s) => s.isRatesSheet && s.headers.length > 0) ??
    sheets.find((s) => s.headers.length > 0) ??
    sheets[0];

  const suggested = useMemo(() => {
    if (preview.status !== 'ready') return {} as Record<number, string | ''>;
    const out: Record<number, string | ''> = {};
    for (const s of preview.suggestions) out[s.index] = s.suggested ?? '';
    return out;
  }, [preview]);

  const effective = (index: number): string | '' =>
    index in mapping ? mapping[index] : (suggested[index] ?? '');

  const chosen = useMemo(() => {
    const out = new Map<number, string>();
    if (!sheet) return out;
    sheet.headers.forEach((_, index) => {
      const t = effective(index);
      if (t !== '') out.set(index, t);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, mapping, suggested]);

  const duplicated = useMemo(() => {
    const seen = new Map<string, number>();
    const dupes = new Set<string>();
    for (const t of chosen.values()) {
      seen.set(t, (seen.get(t) ?? 0) + 1);
      if ((seen.get(t) ?? 0) > 1) dupes.add(t);
    }
    return dupes;
  }, [chosen]);

  const missingRequired = RATE_IMPORT_REQUIRED.filter((t) => ![...chosen.values()].includes(t));
  const mapsMonthlyFee = [...chosen.values()].includes('monthly_fee_tapdash');

  const busy = previewing || committing;

  const read = (nextSheet?: string) => {
    if (!file) return;
    const fd = new FormData();
    fd.set('file', file);
    if (nextSheet) fd.set('sheet', nextSheet);
    startTransition(() => runPreview(fd));
  };

  const send = (intent: 'dry' | 'commit') => {
    if (!file || !sheet) return;
    const fd = new FormData();
    fd.set('file', file);
    fd.set('sheet', sheet.name);
    fd.set('month', month);
    fd.set('mapping', JSON.stringify(Object.fromEntries(chosen)));
    fd.set('intent', intent);
    startTransition(() => runCommit(fd));
  };

  if (outcome.status === 'done') {
    return <Done result={outcome.outcome} onAnother={onAnother} />;
  }

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead>
          <h2 className="text-[14px] font-semibold text-ink-900">The rates sheet</h2>
          <span className="text-[12px] text-ink-400">
            usually the &ldquo;{RATES_SHEET_HINT}&rdquo; tab
          </span>
        </PanelHead>

        <div className="space-y-3 p-4">
          <label className="flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border border-dashed border-line px-4 py-4 transition-colors hover:border-ink-400 hover:bg-canvas">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-canvas text-ink-500">
              <Icon name="upload" size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-ink-900">
                {file ? file.name : 'Choose the workbook holding the merchant rates'}
              </span>
              <span className="block text-[12px] text-ink-400">
                {file
                  ? `${(file.size / 1024).toFixed(0)} KB — click to choose a different file`
                  : '.xlsx or .xls. Not CSV: a rate held as 0.033816 exports as “3.38%”.'}
              </span>
            </span>
            <input
              type="file"
              accept=".xlsx,.xlsm,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              className="sr-only"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setMapping({});
                setSheetName(null);
              }}
            />
          </label>

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

          {preview.status === 'error' ? (
            <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-danger">
              <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
              {preview.message}
            </p>
          ) : null}
        </div>
      </Panel>

      {preview.status === 'ready' && sheet ? (
        <>
          <Panel>
            <PanelHead>
              <h2 className="text-[14px] font-semibold text-ink-900">Which sheet, and from when</h2>
              <span className="text-[12px] text-ink-400">
                header on row {sheet.headerRow} &middot; {sheet.rowCount} merchant
                {sheet.rowCount === 1 ? '' : 's'} below it
              </span>
            </PanelHead>

            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div>
                <label htmlFor="rate-sheet" className="block text-[12.5px] font-medium text-ink-700">
                  Sheet
                </label>
                <select
                  id="rate-sheet"
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
                      {s.headers.length === 0 ? ' — no header row' : ` (${s.rowCount} rows)`}
                      {s.isRatesSheet ? ' ·  looks like the rates tab' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="rate-month" className="block text-[12.5px] font-medium text-ink-700">
                  In effect from
                </label>
                <input
                  id="rate-month"
                  type="month"
                  value={toInputMonth(month)}
                  onChange={(e) => setMonth(fromInputMonth(e.target.value))}
                  disabled={busy}
                  className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
                />
                {/*
                  The one field with no sensible default. These rates apply from
                  a date somebody decides, and guessing "this month" would
                  quietly price the month in progress rather than the statement
                  being worked on.
                */}
                <p className="mt-1 max-w-[46ch] text-[11px] leading-snug text-ink-400">
                  Every merchant in the sheet gets a version starting this month. Earlier months
                  keep the rates they already had.
                </p>
              </div>
            </div>
          </Panel>

          <MappingGrid
            sheet={sheet}
            value={effective}
            onChange={(i, k) => setMapping((m) => ({ ...m, [i]: k }))}
            duplicated={duplicated}
            disabled={busy}
          />

          <Panel>
            <div className="space-y-3 p-4">
              {missingRequired.length > 0 ? (
                <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-ink-500">
                  <Icon name="info" size={13} className="mt-[2px] shrink-0" />
                  {missingRequired
                    .map((k) => RATE_IMPORT_FIELD[k]?.label ?? k)
                    .join(' and ')}{' '}
                  {missingRequired.length === 1 ? 'is' : 'are'} not mapped. A row cannot be placed
                  against a merchant or a tier without them.
                </p>
              ) : null}

              {duplicated.size > 0 ? (
                <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-danger">
                  <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
                  {[...duplicated].map((k) => RATE_IMPORT_FIELD[k]?.label ?? k).join(', ')} is
                  mapped twice. Each field takes one column.
                </p>
              ) : null}

              {/*
                Said while it is still fixable. monthly_fee_tapdash is empty for
                every merchant today and rule #2 raises without it, so a sheet
                imported without that column leaves the month exactly as
                uncomputable as before.
              */}
              {!mapsMonthlyFee && missingRequired.length === 0 ? (
                <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-[#8a5a09]">
                  <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
                  Monthly fee (TapDash) is not mapped. It is blank for every merchant today and one
                  rule cannot compute without it &mdash; importing without that column leaves the
                  month as uncomputable as it is now.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  icon="search"
                  disabled={busy || month === '' || missingRequired.length > 0 || duplicated.size > 0}
                  loading={committing && outcome.status !== 'previewed'}
                  loadingLabel="Checking…"
                  onClick={() => send('dry')}
                >
                  Check without saving
                </Button>

                {outcome.status === 'previewed' ? (
                  <Button
                    variant="primary"
                    icon="check"
                    disabled={busy}
                    loading={committing}
                    loadingLabel="Importing…"
                    onClick={() => send('commit')}
                  >
                    Import these rates
                  </Button>
                ) : null}

                <span className="text-[12px] text-ink-400">
                  {outcome.status === 'previewed'
                    ? 'Checked against the real import. Nothing has been written yet.'
                    : 'Runs the real import and discards it, so you see exactly what would happen.'}
                </span>
              </div>

              <Outcome state={outcome} month={month} />
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

function MappingGrid({
  sheet,
  value,
  onChange,
  duplicated,
  disabled,
}: {
  sheet: RateSheetPreview;
  value: (index: number) => string | '';
  onChange: (index: number, key: string | '') => void;
  duplicated: ReadonlySet<string>;
  disabled: boolean;
}) {
  const mapped = sheet.headers.filter((_, i) => value(i) !== '').length;

  return (
    <Panel>
      <PanelHead>
        <h2 className="text-[14px] font-semibold text-ink-900">
          Columns{' '}
          <span className="ml-1 font-normal text-ink-400">
            ({mapped} of {sheet.headers.length} mapped)
          </span>
        </h2>
        <span className="text-[12px] text-ink-400">Anything left unmapped is not imported.</span>
      </PanelHead>

      <div className="max-h-[540px] overflow-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-line-soft text-[11.5px] uppercase tracking-wide text-ink-400">
              <th className="px-4 py-2 font-semibold">Column in the sheet</th>
              <th className="px-4 py-2 font-semibold">First rows</th>
              <th className="px-4 py-2 font-semibold">Imports as</th>
            </tr>
          </thead>
          <tbody>
            {sheet.headers.map((header, index) => {
              const current = value(index);
              const isDupe = current !== '' && duplicated.has(current);
              const field = current === '' ? undefined : RATE_IMPORT_FIELD[current];
              return (
                <tr key={`${header}-${index}`}>
                  <td className="border-b border-line-faint px-4 py-2 align-top text-[13px] font-medium text-ink-900">
                    {header.trim() === '' ? <span className="text-ink-300">(no name)</span> : header}
                  </td>
                  <td className="border-b border-line-faint px-4 py-2 align-top">
                    <span className="block max-w-[26ch] truncate text-[12.5px] tabular text-ink-500">
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
                      onChange={(e) => onChange(index, e.target.value)}
                      className={`w-full max-w-[260px] rounded-lg border bg-white px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus-field ${
                        isDupe ? 'border-[#e3989d]' : 'border-line'
                      }`}
                    >
                      <option value="">— not imported —</option>
                      {RATE_IMPORT_GROUPS.map((g) => (
                        <optgroup key={g.title} label={g.title}>
                          {g.fields.map((f) => (
                            <option key={f.key} value={f.key}>
                              {f.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {field?.hint ? (
                      <span className="mt-1 block max-w-[34ch] text-[11px] leading-snug text-ink-400">
                        {field.hint}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-line-faint px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-400">
        A rate at or above <span className="tabular">0.10</span> is refused as percent-scaled. Real
        volume rates run from <span className="tabular">0.001</span> to{' '}
        <span className="tabular">0.047619</span>, and the same figures written as percentages start
        at <span className="tabular">0.1</span> &mdash; two populations that cannot overlap, which
        is what makes the check safe rather than a guess.
      </p>
    </Panel>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Results
 * ──────────────────────────────────────────────────────────────────────── */

function Outcome({ state, month }: { state: RateCommitState; month: string }) {
  if (state.status === 'error') {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-danger">
        <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
        {state.message}
      </p>
    );
  }

  if (state.status === 'row_errors') {
    return (
      <div className="overflow-hidden rounded-xl border border-[#f7cfd1]">
        <p className="flex items-center gap-1.5 border-b border-[#f7cfd1] bg-[#fce9ea] px-3.5 py-2.5 text-[13px] font-semibold text-[#b02a30]">
          <Icon name="alert-triangle" size={14} />
          {state.total} cell{state.total === 1 ? '' : 's'} could not be read
        </p>
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line-soft text-[11px] uppercase tracking-wide text-ink-400">
              <th className="px-3.5 py-1.5 font-semibold">Row</th>
              <th className="px-3.5 py-1.5 font-semibold">Column</th>
              <th className="px-3.5 py-1.5 font-semibold">Holds</th>
            </tr>
          </thead>
          <tbody>
            {state.errors.map((e, i) => (
              <tr key={`${e.sheetRow}-${e.key}-${i}`}>
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
        {state.total > state.errors.length ? (
          <p className="px-3.5 py-2 text-[11.5px] text-ink-400">
            {state.total - state.errors.length} more not listed.
          </p>
        ) : null}
      </div>
    );
  }

  if (state.status === 'rejected') {
    /*
     * The separator is part of the RPC's contract, not formatting: "Summary
     * first, then at most c_max_shown problems joined with ' | '. The client
     * splits on that separator to render them in a scrollable list."
     */
    const { summary, problems } = splitRejection(state.message);
    return (
      <div className="overflow-hidden rounded-xl border border-[#f7cfd1]">
        <p className="flex items-start gap-1.5 border-b border-[#f7cfd1] bg-[#fce9ea] px-3.5 py-2.5 text-[13px] font-semibold text-[#b02a30]">
          <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" />
          {summary}
        </p>
        {problems.length > 0 ? (
          <ul className="max-h-[260px] divide-y divide-line-faint overflow-auto">
            {problems.map((p, i) => (
              <li key={`${i}-${p}`} className="px-3.5 py-1.5 text-[12.5px] leading-relaxed text-ink-700">
                {p}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="border-t border-line-faint px-3.5 py-2 text-[11.5px] leading-relaxed text-ink-400">
          Nothing was written. A rate at or above <span className="tabular">0.10</span> is almost
          certainly percent-scaled &mdash; check the sheet was saved as .xlsx rather than exported
          through CSV, which turns <span className="tabular">0.033816</span> into{' '}
          <span className="tabular">3.38%</span>.
        </p>
      </div>
    );
  }

  if (state.status === 'previewed') {
    return <Summary result={state.outcome} month={month} dryRun />;
  }

  return null;
}

function Stat({ n, label, hint, tone }: { n: number; label: string; hint: string; tone?: boolean }) {
  return (
    <div className="rounded-xl border border-line-soft px-3.5 py-3">
      <p className={`text-[20px] font-semibold tabular leading-none ${tone ? 'text-[#8a5a09]' : 'text-ink-900'}`}>
        {n}
      </p>
      <p className="mt-1.5 text-[12.5px] font-medium text-ink-700">{label}</p>
      <p className="mt-0.5 max-w-[34ch] text-[11px] leading-snug text-ink-400">{hint}</p>
    </div>
  );
}

function Summary({
  result,
  month,
  dryRun,
}: {
  result: Extract<RateCommitState, { status: 'previewed' }>['outcome'];
  month: string;
  dryRun: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-line-soft">
        <p className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft bg-canvas px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-900">
            <Icon name={dryRun ? 'search' : 'check'} size={14} className={dryRun ? '' : 'text-ok'} />
            {dryRun ? 'What this would do' : 'Imported'}
          </span>
          <span className="text-[12px] text-ink-500">
            effective {monthLabel(result.effectiveFrom || month)}
          </span>
        </p>

        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat n={result.rowsRead} label="Merchants read" hint="Rows in the sheet with a MID." />
          <Stat
            n={result.inserted}
            label="New versions"
            hint="A dated rate row starting this month."
          />
          <Stat
            n={result.unchanged}
            label="Unchanged"
            hint="Rates already match. No successor opened, so re-importing is safe."
          />
          <Stat
            n={result.closed}
            label="Predecessors closed"
            hint="Ended on this date so a successor could begin. Earlier months still read them."
          />
        </div>
      </div>

      {/*
        The consequential case, and it is legal rather than forbidden — this is
        how a merchant whose month is already signed off gets repriced. Shown
        because superseding a version a computed month read changes what a
        future recompute of LATER months will find.
      */}
      {result.lockedVersions.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[#f7e0af]">
          <p className="flex items-start gap-1.5 border-b border-[#f7e0af] bg-[#fdf1d8] px-3.5 py-2.5 text-[13px] font-semibold text-[#8a5a09]">
            <Icon name="lock" size={14} className="mt-[2px] shrink-0" />
            {result.lockedVersions.length} merchant
            {result.lockedVersions.length === 1 ? '' : 's'} already priced a calculated month
          </p>
          <ul className="max-h-[200px] divide-y divide-line-faint overflow-auto">
            {result.lockedVersions.map((v) => (
              <li
                key={`${v.mid}-${v.effectiveFrom}`}
                className="flex flex-wrap items-baseline gap-2 px-3.5 py-1.5 text-[12.5px]"
              >
                <span className="tabular font-medium text-ink-900">{v.mid}</span>
                <span className="text-ink-500">
                  version from {v.effectiveFrom}
                  {v.effectiveTo ? ` to ${v.effectiveTo}` : ' (standing)'}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-line-faint px-3.5 py-2 text-[11.5px] leading-relaxed text-ink-500">
            This is allowed, and it is how a merchant gets repriced after a month has been
            calculated &mdash; the old version is kept and closed, not overwritten, so every month
            already computed still reads the rates it was computed with. What changes is what a
            future recalculation of a <em>later</em> month will find.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Done({
  result,
  onAnother,
}: {
  result: Extract<RateCommitState, { status: 'done' }>['outcome'];
  onAnother: () => void;
}) {
  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead>
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink-900">
            <Icon name="check" size={14} strokeWidth={2.5} className="text-ok" />
            Rates imported
          </h2>
          <Button size="sm" variant="ghost" icon="upload" onClick={onAnother}>
            Import another sheet
          </Button>
        </PanelHead>
        <div className="p-4">
          <Summary result={result} month={result.effectiveFrom} dryRun={false} />
        </div>
      </Panel>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-canvas px-4 py-3">
        <StatusPill label="Next" swatch="blue" dot={false} />
        <p className="max-w-[80ch] text-[12.5px] leading-relaxed text-ink-600">
          Rates do not move a figure until the engine re-reads them. Re-calculate the month from
          the Periods tab, and any merchant that was blocked for want of a rate should compute.
        </p>
      </div>
    </div>
  );
}
