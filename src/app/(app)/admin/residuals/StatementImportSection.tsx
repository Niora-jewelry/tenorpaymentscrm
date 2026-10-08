'use client';

/**
 * Uploading processor statements — Step 2.
 *
 * ── MANY FILES, ONE PASS ─────────────────────────────────────────────────
 * A fee report is one file for the whole month. A statement is one file per
 * MERCHANT, and a month is forty-seven of them, so this screen is built around
 * a batch rather than a single upload. Every file gets its own row in the
 * preview, its own verdict, and its own outcome.
 *
 * ── THE FILES LIVE IN REACT STATE, NOT IN A FORM ─────────────────────────
 * Same reason as the fee report: two round trips need the same upload, and a
 * `<form action={...}>` would lose the `File` between them. Each step builds
 * its own FormData from state, and the server parses the bytes both times —
 * nothing read on this screen is ever sent back up and trusted.
 *
 * ── NOTHING HERE DOES ARITHMETIC ─────────────────────────────────────────
 * The totals are printed exactly as the server produced them. Money crosses as
 * text; the client formats and never computes. There is deliberately no "total
 * volume imported" figure on this screen, because that would mean adding money
 * in JavaScript.
 *
 * ── A FILE THAT CANNOT BE PROVED IS SHOWN, NOT HIDDEN ────────────────────
 * The preview separates provable files from the rest and says why each of the
 * rest failed. The import then takes the provable ones and leaves the others,
 * because refusing a whole month for one bad scan is worse than importing
 * forty-six and naming the one that needs looking at.
 */
import { useActionState, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, OutlineChip } from '@/proto/ui/kit';
import type { StatementOutcome, StatementRead } from '@/lib/records/residualStatements';
import { Panel, PanelHead } from './ResidualsTabs';
import {
  commitStatementsAction,
  previewStatementsAction,
  type StatementCommitState,
  type StatementPreviewState,
} from './statementImportActions';

/** `2026-08-01` <-> the `YYYY-MM` an `<input type="month">` carries. */
const toInputMonth = (iso: string) => iso.slice(0, 7);
const fromInputMonth = (v: string) => (v === '' ? '' : `${v}-01`);

function monthLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-01$/.exec(iso);
  if (!m) return iso;
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${names[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * Groups the integer part and leaves the decimals exactly as SQL produced
 * them. No rounding, no parsing back to a number.
 */
function money(text: string | null): string {
  if (text === null || text === '') return '—';
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [whole, frac] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac === undefined ? '' : `.${frac}`}`;
}

export function StatementImportSection({ processors }: { processors: string[] }) {
  const [round, setRound] = useState(0);
  return <Inner key={round} processors={processors} onReset={() => setRound((n) => n + 1)} />;
}

function Inner({ processors, onReset }: { processors: string[]; onReset: () => void }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [month, setMonth] = useState('');
  const [processor, setProcessor] = useState(processors[0] ?? 'MAVERICK');
  const [replace, setReplace] = useState(false);

  const [preview, runPreview, reading] = useActionState<StatementPreviewState, FormData>(
    previewStatementsAction,
    { status: 'idle' },
  );
  const [commit, runCommit, committing] = useActionState<StatementCommitState, FormData>(
    commitStatementsAction,
    { status: 'idle' },
  );
  const [, startTransition] = useTransition();

  const busy = reading || committing;
  const done = commit.status === 'done';

  const body = useMemo(() => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    fd.set('month', month);
    fd.set('processor', processor);
    if (replace) fd.set('replace', 'on');
    return fd;
  }, [files, month, processor, replace]);

  const provable = preview.status === 'ready' ? preview.reads.filter((r) => r.provable) : [];
  const unprovable = preview.status === 'ready' ? preview.reads.filter((r) => !r.provable) : [];

  return (
    <div className="space-y-4">
      {/* ── choose the files ────────────────────────────────────────────── */}
      <Panel>
        <PanelHead>
          <h2 className="text-[14px] font-semibold text-ink-900">Merchant statements</h2>
          {processors.length > 1 ? (
            <select
              value={processor}
              onChange={(e) => setProcessor(e.target.value)}
              aria-label="Processor"
              disabled={busy || done}
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
          <p className="max-w-[78ch] text-[12.5px] leading-relaxed text-ink-600">
            The statement is where <span className="font-medium text-ink-800">volume</span> comes
            from, and three fee items are charged on volume rather than on a count &mdash; BIN
            Sponsorship, Amex OptBlue and the Cash Discount programme. Without statements those
            lines cannot be worked out at all, so they are refused rather than priced at zero.
            One PDF per merchant; select the whole month at once.
          </p>

          <label
            className={`flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border border-dashed border-line px-4 py-4 transition-colors hover:border-ink-400 hover:bg-canvas ${
              busy || done ? 'pointer-events-none opacity-60' : ''
            }`}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-canvas text-ink-500">
              <Icon name="upload" size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-ink-900">
                {files.length === 0
                  ? 'Choose statement PDFs'
                  : `${files.length} file${files.length === 1 ? '' : 's'} selected`}
              </span>
              <span className="mt-0.5 block text-[11.5px] text-ink-500">
                {files.length === 0
                  ? 'PDF only — the figures are read from the page, by position.'
                  : files
                      .slice(0, 3)
                      .map((f) => f.name)
                      .join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '')}
              </span>
            </span>
            <input
              type="file"
              accept=".pdf"
              multiple
              className="sr-only"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[11rem]">
              <label
                htmlFor="statement-import-month"
                className="block text-[12.5px] font-medium text-ink-700"
              >
                Statement month
              </label>
              <input
                id="statement-import-month"
                type="month"
                value={toInputMonth(month)}
                onChange={(e) => setMonth(fromInputMonth(e.target.value))}
                disabled={busy || done}
                className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
              />
            </div>

            <Button
              onClick={() => startTransition(() => runPreview(body))}
              disabled={files.length === 0 || month === '' || busy || done}
              loading={reading}
            >
              Read the statements
            </Button>
          </div>

          {/*
            Checked per file against the month being imported, not assumed from
            it. A September statement loaded into August would price August's
            lines against September's volume, and every total would still add
            up — so the document's own month is compared and reported.
          */}
          <p className="text-[11.5px] leading-relaxed text-ink-400">
            Each file is checked against this month and against its own printed total before
            anything is written.
          </p>
        </div>
      </Panel>

      {preview.status === 'error' ? (
        <p className="rounded-xl border border-[#e7c9c9] bg-[#fdf6f6] px-4 py-3 text-[12.5px] text-[#7d2b2b]">
          {preview.message}
        </p>
      ) : null}

      {/* ── what the files turned out to be ─────────────────────────────── */}
      {preview.status === 'ready' && !done ? (
        <Panel>
          <PanelHead>
            <h3 className="text-[13.5px] font-semibold text-ink-900">
              What these statements say
            </h3>
            <span className="text-[12px] text-ink-500">{monthLabel(preview.month)}</span>
          </PanelHead>

          <div className="p-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[42rem] text-[12.5px]">
                <thead>
                  <tr className="border-b border-line-soft text-ink-500">
                    <th className="py-1.5 pr-3 text-left font-medium">Merchant number</th>
                    <th className="px-3 py-1.5 text-left font-medium">Month</th>
                    <th className="px-3 py-1.5 text-right font-medium">Statement total</th>
                    <th className="px-3 py-1.5 text-right font-medium">Sales</th>
                    <th className="px-3 py-1.5 text-right font-medium">Plan rows</th>
                    <th className="py-1.5 pl-3 text-left font-medium">File</th>
                  </tr>
                </thead>
                <tbody>
                  {provable.map((r) => (
                    <tr key={r.filename} className="border-b border-line-faint last:border-0">
                      <td className="py-1.5 pr-3">
                        <span className="tabular font-medium text-ink-900">{r.mid}</span>
                        {preview.alreadyImported.includes(r.mid ?? '') ? (
                          <span className="ml-2 text-[11px] text-[#8a5a09]">already imported</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-1.5 tabular text-ink-600">{r.processingMonth}</td>
                      <td className="px-3 py-1.5 text-right tabular text-ink-900">
                        {money(r.statedTotal)}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular text-ink-600">
                        {r.statedItemCount ?? '—'}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular text-ink-600">
                        {r.planRowCount}
                      </td>
                      <td className="max-w-[16rem] truncate py-1.5 pl-3 text-[11.5px] text-ink-400">
                        {r.filename}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {provable.length > 0 ? (
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-500">
                Every figure above was proved against the statement&rsquo;s own{' '}
                <span className="tabular">**</span> total row &mdash; the plan rows add up to it
                exactly, on the money and on the number of sales. A file whose rows did not add up
                is listed below instead of being imported with a warning.
              </p>
            ) : (
              <p className="text-[12.5px] text-ink-600">
                None of these files could be proved, so there is nothing to import.
              </p>
            )}

            {preview.alreadyImported.length > 0 ? (
              <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-xl border border-line-soft bg-canvas px-3.5 py-2.5">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-[12px] leading-relaxed text-ink-700">
                  <span className="font-medium text-ink-900">
                    Replace the {preview.alreadyImported.length} merchant
                    {preview.alreadyImported.length === 1 ? '' : 's'} already imported for this
                    month.
                  </span>{' '}
                  The earlier statement is retired and its volumes are superseded &mdash; only for
                  those merchants, never for the rest of the month. Left unticked, those files are
                  skipped and everything else still goes in.
                </span>
              </label>
            ) : null}

            {unprovable.length > 0 ? (
              <div className="mt-3 overflow-hidden rounded-xl border border-[#e7c9c9]">
                <p className="border-b border-[#e7c9c9] bg-[#fdf6f6] px-3.5 py-2 text-[12.5px] font-semibold text-[#7d2b2b]">
                  {unprovable.length} file{unprovable.length === 1 ? '' : 's'} will not be imported
                </p>
                <ul className="divide-y divide-line-faint">
                  {unprovable.map((r) => (
                    <li key={r.filename} className="px-3.5 py-2">
                      <p className="text-[12.5px] font-medium text-ink-900">
                        {r.mid ?? r.filename}
                      </p>
                      {r.problems.map((p, i) => (
                        <p key={`${i}-${p}`} className="mt-0.5 text-[11.5px] leading-relaxed text-ink-600">
                          {p}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                onClick={() => startTransition(() => runCommit(body))}
                disabled={provable.length === 0 || busy}
                loading={committing}
              >
                Import {provable.length} statement{provable.length === 1 ? '' : 's'}
              </Button>
              <span className="text-[11.5px] text-ink-400">
                The month is recomputed straight afterwards.
              </span>
            </div>
          </div>
        </Panel>
      ) : null}

      {commit.status === 'error' ? (
        <p className="rounded-xl border border-[#e7c9c9] bg-[#fdf6f6] px-4 py-3 text-[12.5px] text-[#7d2b2b]">
          {commit.message}
        </p>
      ) : null}

      {done ? <Result state={commit} onReset={onReset} router={router} /> : null}
    </div>
  );
}

function Result({
  state,
  onReset,
  router,
}: {
  state: Extract<StatementCommitState, { status: 'done' }>;
  onReset: () => void;
  router: ReturnType<typeof useRouter>;
}) {
  const landed = state.outcomes.filter((o) => o.ok);
  const didNot = state.outcomes.filter((o) => !o.ok);
  const unreconciled = landed.filter((o) => o.reconciled === false);
  const unmapped = landed.filter((o) => (o.unmappedCodes?.length ?? 0) > 0);

  return (
    <div className="space-y-3">
      <Panel>
        <PanelHead>
          <h3 className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink-900">
            <Icon name="check" size={14} className="text-ok" />
            Statements imported
          </h3>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onReset}>
              Import more
            </Button>
            <Button variant="ghost" onClick={() => router.refresh()}>
              Refresh
            </Button>
          </div>
        </PanelHead>

        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <Stat n={state.imported} label="Imported" hint="Statements whose figures proved out." />
          <Stat
            n={state.skipped}
            label="Skipped"
            hint="Could not be proved, or already on file for this month."
            tone={state.skipped > 0}
          />
          <Stat
            n={state.failed}
            label="Failed"
            hint="Reached the database and were refused. Nothing partial was kept."
            tone={state.failed > 0}
          />
        </div>

        {state.recomputed ? (
          <p className="border-t border-line-soft px-4 py-2.5 text-[12.5px] leading-relaxed text-ink-700">
            The month was recomputed:{' '}
            <span className="font-medium text-ink-900">
              {state.recomputed.lines} lines across {state.recomputed.merchants} merchants
            </span>
            {state.recomputed.failedMerchants > 0 ? (
              <>
                , and <span className="font-medium">{state.recomputed.failedMerchants}</span>{' '}
                merchant{state.recomputed.failedMerchants === 1 ? '' : 's'} still uncosted. A
                merchant with no rates on file, or no statement yet, is uncosted rather than wrong
                &mdash; the reconciliation screen says which.
              </>
            ) : (
              '.'
            )}
          </p>
        ) : null}

        {state.recomputeMessage ? (
          <p className="border-t border-line-soft px-4 py-2.5 text-[12.5px] text-[#8a5a09]">
            {state.recomputeMessage}
          </p>
        ) : null}
      </Panel>

      {unreconciled.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[#e8d8b8]">
          <p className="border-b border-[#e8d8b8] bg-[#fdfaf2] px-3.5 py-2 text-[12.5px] font-semibold text-[#8a5a09]">
            {unreconciled.length} landed without reconciling
          </p>
          <p className="px-3.5 py-2 text-[11.5px] leading-relaxed text-ink-600">
            The plan rows did not match the statement&rsquo;s stated total, so the four volume
            buckets were left empty rather than filled with figures that do not agree. The rows
            themselves are stored and visible; the merchant stays uncosted for the volume-based
            items until this is looked at.
          </p>
          <ul className="divide-y divide-line-faint border-t border-line-faint">
            {unreconciled.map((o) => (
              <li key={o.filename} className="px-3.5 py-1.5 text-[12.5px] tabular text-ink-800">
                {o.mid}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unmapped.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[#e8d8b8]">
          <p className="border-b border-[#e8d8b8] bg-[#fdfaf2] px-3.5 py-2 text-[12.5px] font-semibold text-[#8a5a09]">
            Volume in plan codes nothing claims
          </p>
          <p className="px-3.5 py-2 text-[11.5px] leading-relaxed text-ink-600">
            These statements carry card types that are not mapped to one of the four buckets, so
            that money is counted in no bucket. It is reported here rather than dropped &mdash; and
            it also stops the statement reconciling, which is why those merchants appear above as
            well: bucket totals that read as complete while real volume sits outside them would
            have a rate applied to too little money. The mapping is a table, so adding the code is
            configuration, after which the statement can be imported again.
          </p>
          <ul className="divide-y divide-line-faint border-t border-line-faint">
            {unmapped.map((o) => (
              <li key={o.filename} className="px-3.5 py-1.5 text-[12.5px]">
                <span className="tabular font-medium text-ink-900">{o.mid}</span>
                <span className="ml-2 tabular text-ink-700">{money(o.unmappedVolume ?? null)}</span>
                <span className="ml-2 text-ink-500">in {o.unmappedCodes?.join(', ')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {didNot.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-line-soft">
          <p className="border-b border-line-soft bg-canvas px-3.5 py-2 text-[12.5px] font-semibold text-ink-900">
            {didNot.length} not imported
          </p>
          <ul className="divide-y divide-line-faint">
            {didNot.map((o) => (
              <li key={o.filename} className="px-3.5 py-2">
                <p className="text-[12.5px] font-medium text-ink-900">
                  {o.mid ?? o.filename}
                  {o.mid ? (
                    <span className="ml-2 text-[11px] font-normal text-ink-400">{o.filename}</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-600">{o.message}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  n,
  label,
  hint,
  tone,
}: {
  n: number;
  label: string;
  hint: string;
  tone?: boolean;
}) {
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
      <p className="mt-0.5 max-w-[34ch] text-[11px] leading-snug text-ink-400">{hint}</p>
    </div>
  );
}

export type { StatementOutcome, StatementRead };
