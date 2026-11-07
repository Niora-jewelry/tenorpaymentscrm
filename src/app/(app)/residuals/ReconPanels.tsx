'use client';
/**
 * The three reconciliation tabs. Acquiring and ACH share one layout (MID summary rows that open
 * into fee rows); Accept.blue compares expected against charged, column by column.
 */
import Link from 'next/link';
import { Fragment, useMemo, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import type { FlagColor } from '@/lib/residuals/calc/types';
import type { AcceptBlueView, MidView, ReconView, WorkspaceData } from '@/lib/residuals/workspace';
import { FLAG_ROW, FLAG_TONE, FlagDot, Panel, PanelHeader, Pill, RiskPill, Th, money, percent, plain } from './ui';

type Legend = { color: FlagColor; label: string }[];

/** What each colour means differs by tab, so each tab names its own. */
export const LEGENDS: Record<'acquiring' | 'ach' | 'acceptblue', Legend> = {
  acquiring: [
    { color: 'red', label: 'Red' },
    { color: 'orange', label: 'Needs review' },
    { color: 'light_red', label: 'Income above report' },
    { color: 'light_green', label: 'Report above income' },
  ],
  ach: [
    { color: 'red', label: 'Our net higher' },
    { color: 'orange', label: 'Needs review' },
    { color: 'green', label: 'Our net lower' },
  ],
  acceptblue: [
    { color: 'red', label: 'Charged more than expected' },
    { color: 'orange', label: 'Needs review' },
    { color: 'green', label: 'Charged less than expected' },
  ],
};

const recordHref = (id: string | null) => (id ? `/records?record=${id}` : null);

function MerchantCell({ name, mid, recordId }: { name: string; mid: string; recordId: string | null }) {
  const href = recordHref(recordId);
  return (
    <div className="min-w-0">
      {href ? (
        <Link href={href} onClick={(e) => e.stopPropagation()} className="font-semibold text-ink-900 hover:text-brand-600 hover:underline">
          {name}
        </Link>
      ) : (
        <span className="font-semibold text-ink-900">{name}</span>
      )}
      <div className="font-mono text-[11.5px] text-ink-400">{mid || 'No MID'}</div>
    </div>
  );
}

function SourceCard({ source, notes, label }: { source: ReconView['source']; notes: string[]; label: string }) {
  return (
    <Panel className="p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Source report</div>
      <div className="mt-3 flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ok-bg text-ok">
          <Icon name="file-text" size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-ink-900">{source.file ?? label}</div>
          <div className="text-[12px] text-ink-500">
            {source.rows} rows
            {source.importedAt && ` · imported ${new Date(source.importedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
          </div>
        </div>
      </div>
      {notes.map((n) => (
        <div key={n} className="mt-3 rounded-md bg-canvas px-3 py-2 text-[12px] text-ink-600">{n}</div>
      ))}
    </Panel>
  );
}

function FlagCounts({ legend, counts, clean, alerts }: { legend: Legend; counts: Partial<Record<FlagColor, number>>; clean: number; alerts: number }) {
  return (
    <Panel className="p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Flags</div>
      <div className="mt-3 grid grid-cols-1 gap-x-5 gap-y-2 text-[13px] sm:grid-cols-2">
        {legend.map((l) => (
          <div key={l.color} className="flex items-center gap-2">
            <FlagDot color={l.color} />
            <span className="flex-1 text-ink-600">{l.label}</span>
            <span className="tabular font-bold">{counts[l.color] ?? 0}</span>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <FlagDot color={null} />
          <span className="flex-1 text-ink-600">Clean</span>
          <span className="tabular font-bold">{clean}</span>
        </div>
        <div className="flex items-center gap-2">
          <Icon name="alert-triangle" size={12} className="text-warn" />
          <span className="flex-1 text-ink-600">Alerts</span>
          <span className="tabular font-bold">{alerts}</span>
        </div>
      </div>
    </Panel>
  );
}

function NetCard({ label, total, mids, footnote }: { label: string; total: number; mids: number; footnote: string }) {
  return (
    <Panel className="flex flex-col justify-between border-transparent bg-brand-900 p-5 text-white">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-200">{label}</div>
        <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11.5px] font-semibold">{mids} MIDs</span>
      </div>
      <div className="tabular mt-3 text-[32px] font-bold leading-none">{money(total)}</div>
      <div className="mt-3 text-[12px] text-brand-200">{footnote}</div>
    </Panel>
  );
}

function FilterBar<T extends string>({ options, value, onChange, q, onQ }: {
  options: { key: T; label: string; color?: FlagColor | null }[]; value: T; onChange: (k: T) => void; q: string; onQ: (s: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-5 py-3">
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors ${
              value === o.key ? 'border-brand-900 bg-brand-900 text-white' : 'border-line bg-white text-ink-700 hover:bg-canvas'
            }`}
          >
            {o.color !== undefined && <FlagDot color={o.color} />}
            {o.label}
          </button>
        ))}
      </div>
      <label className="relative ml-auto w-full sm:w-64">
        <span className="sr-only">Search MID or merchant</span>
        <Icon name="search" size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          value={q}
          onChange={(e) => onQ(e.target.value)}
          placeholder="Search MID or merchant…"
          className="w-full rounded-md border border-line bg-white py-1.5 pl-8 pr-3 text-[13px] outline-none focus:border-brand-400"
        />
      </label>
    </div>
  );
}

/* ── Acquiring and ACH ───────────────────────────────────────────────────── */

export function ReconTab({ kind, view, label, data }: { kind: 'acquiring' | 'ach'; view: ReconView | null; label: string; data: WorkspaceData }) {
  const [sub, setSub] = useState<'recon' | 'match'>('recon');
  if (!view) return <NoReport label={label} month={data.period?.label} />;
  if (kind !== 'ach' || !data.ach) return <ReconBody kind={kind} view={view} label={label} />;
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
        {([['recon', 'Reconciliation'], ['match', 'MID matching']] as const).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setSub(k)}
            className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${sub === k ? 'bg-brand-900 text-white' : 'text-ink-600 hover:text-ink-900'}`}
          >
            {l}
          </button>
        ))}
      </div>
      {sub === 'recon' ? <ReconBody kind={kind} view={view} label={label} /> : <AchMatching matches={data.ach.nameMatches} />}
    </div>
  );
}

type FilterKey = 'all' | 'clean' | FlagColor;

function ReconBody({ kind, view, label }: { kind: 'acquiring' | 'ach'; view: ReconView; label: string }) {
  const legend = LEGENDS[kind];
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<FilterKey>('all');
  const [q, setQ] = useState('');
  const counts = useMemo(() => {
    const c: Partial<Record<FlagColor, number>> = {};
    for (const m of view.mids) if (m.color) c[m.color] = (c[m.color] ?? 0) + 1;
    return c;
  }, [view]);
  const clean = view.mids.filter((m) => !m.color).length;
  const alerts = view.mids.reduce((s, m) => s + m.alertCount, 0);
  const visible = view.mids.filter((m) => {
    if (q && !`${m.mid} ${m.name}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'all') return true;
    if (filter === 'clean') return !m.color;
    return m.color === filter;
  });
  const resultLabel = kind === 'acquiring' ? 'Income' : 'Net';
  const reportedLabel = kind === 'acquiring' ? 'Net revenue' : 'Report net';

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr_1fr]">
        <SourceCard source={view.source} notes={view.notes} label={label} />
        <FlagCounts legend={legend} counts={counts} clean={clean} alerts={alerts} />
        <NetCard label={`Final ${label} net`} total={view.total} mids={view.mids.filter((m) => m.mid).length} footnote="Each MID's net goes to the Final Tally" />
      </div>

      <Panel>
        <FilterBar<FilterKey>
          options={[
            { key: 'all', label: 'All MIDs' },
            ...legend.map((l) => ({ key: l.color as FilterKey, label: l.label, color: l.color })),
            { key: 'clean', label: 'Clean', color: null },
          ]}
          value={filter}
          onChange={setFilter}
          q={q}
          onQ={setQ}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-[13px]">
            <thead>
              <tr className="border-b border-line-soft">
                <Th className="w-10" />
                <Th>Merchant / MID</Th>
                <Th>Risk level</Th>
                <Th>Status</Th>
                <Th>Notifications</Th>
                <Th right>{resultLabel}</Th>
                <Th right>Split</Th>
                <Th right className="pr-5">Aggregate tally</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m) => (
                <MidRows
                  key={m.mid || m.name}
                  m={m}
                  legend={legend}
                  open={!!open[m.mid || m.name]}
                  onToggle={() => setOpen((o) => ({ ...o, [m.mid || m.name]: !o[m.mid || m.name] }))}
                  resultLabel={resultLabel}
                  reportedLabel={reportedLabel}
                  kind={kind}
                />
              ))}
              {!visible.length && (
                <tr><td colSpan={8} className="px-5 py-8 text-center text-[13px] text-ink-500">No MIDs match this filter.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-canvas">
                <td colSpan={7} className="px-5 py-3 text-right text-[13px] font-semibold">Final {label} number</td>
                <td className="tabular px-5 py-3 text-right text-[16px] font-bold">{money(view.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function MidRows({ m, legend, open, onToggle, resultLabel, reportedLabel, kind }: {
  m: MidView; legend: Legend; open: boolean; onToggle: () => void; resultLabel: string; reportedLabel: string; kind: 'acquiring' | 'ach';
}) {
  const status = m.color ? legend.find((l) => l.color === m.color)?.label ?? m.color : null;
  const negative = (m.income ?? 0) < 0;
  return (
    <Fragment>
      <tr onClick={onToggle} className={`cursor-pointer border-b border-line-soft transition-colors hover:bg-canvas ${open ? 'bg-canvas' : ''}`}>
        <td className="px-3 py-3 text-center">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="mx-auto text-ink-400" />
        </td>
        <td className="px-3 py-3"><MerchantCell name={m.name} mid={m.mid} recordId={m.recordId} /></td>
        <td className="px-3 py-3"><RiskPill risk={m.riskLevel} /></td>
        <td className="px-3 py-3">
          {!m.calculated ? <Pill tone="bad">Not calculated</Pill> : status ? <Pill tone={FLAG_TONE[m.color!]}>{status}</Pill> : <Pill tone="ok">Reconciled</Pill>}
        </td>
        <td className="px-3 py-3">
          {m.alertCount ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-warn">
              <Icon name="alert-triangle" size={13} /> {m.alertCount} alert{m.alertCount > 1 ? 's' : ''}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-ok"><Icon name="check" size={13} /> All clear</span>
          )}
        </td>
        <td className="tabular px-3 py-3 text-right">{money(m.income)}</td>
        <td className="tabular px-3 py-3 text-right text-ink-500">{!m.calculated ? '—' : negative ? 'n/a' : percent(m.percentage)}</td>
        <td className="tabular px-5 py-3 text-right text-[14.5px] font-bold">{m.calculated ? money(m.net) : '—'}</td>
      </tr>
      {open && (
        <tr className="border-b border-line-soft bg-canvas/60">
          <td colSpan={8} className="px-4 pb-4 pt-1">
            {m.midAlerts.length > 0 && (
              <ul className="mb-2 space-y-1">
                {m.midAlerts.map((a, i) => (
                  <li key={i} className="flex items-center gap-2 text-[12px] text-ink-700"><FlagDot color={a.color} />{a.message}</li>
                ))}
              </ul>
            )}
            <div className="overflow-hidden rounded-lg border border-line bg-white">
              <div className="flex items-center justify-between border-b border-line-soft px-4 py-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">
                  {kind === 'acquiring' ? 'Fee item report' : 'ACH fee report'} · {m.rows.length} rows
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-[12.5px]">
                  <thead>
                    <tr className="border-b border-line-soft bg-canvas/70">
                      <Th className="w-6" />
                      <Th>{kind === 'acquiring' ? 'Fee item' : 'Fee category'}</Th>
                      {kind === 'acquiring' && <Th>Category</Th>}
                      <Th right>Count</Th>
                      {kind === 'acquiring' && <Th right>Amount</Th>}
                      <Th right>{reportedLabel}</Th>
                      <Th right>Merchant pmt</Th>
                      <Th right>Buy rate</Th>
                      <Th right>{resultLabel}</Th>
                      <Th>Alerts</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.rows.map((r, i) => (
                      <tr key={i} className={`border-b border-line-soft last:border-0 ${r.color ? FLAG_ROW[r.color] : ''}`}>
                        <td className="pl-3"><FlagDot color={r.color} /></td>
                        <td className="px-3 py-2 font-semibold">{r.feeItem}</td>
                        {kind === 'acquiring' && <td className="px-3 py-2 text-ink-500">{r.category}</td>}
                        <td className="tabular px-3 py-2 text-right">{plain(r.count)}</td>
                        {kind === 'acquiring' && <td className="tabular px-3 py-2 text-right">{r.amount ? money(r.amount) : '—'}</td>}
                        <td className="tabular px-3 py-2 text-right">{money(r.reported)}</td>
                        <td className="tabular px-3 py-2 text-right">{money(r.merchantPayment)}</td>
                        <td className="tabular px-3 py-2 text-right">{money(r.buyRate)}</td>
                        <td className="tabular px-3 py-2 text-right font-bold">{money(r.result)}</td>
                        <td className="max-w-[340px] px-3 py-2">
                          {r.alerts.length ? (
                            <ul className="space-y-0.5">
                              {r.alerts.map((a, j) => <li key={j} className="text-[11.5px] leading-snug text-ink-700">{a.message}</li>)}
                            </ul>
                          ) : <span className="text-ink-300">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function AchMatching({ matches }: { matches: NonNullable<WorkspaceData['ach']>['nameMatches'] }) {
  const matched = matches.filter((m) => m.mid).length;
  return (
    <Panel>
      <PanelHeader
        title="Match ACH names to MIDs"
        sub="The ACH report lists merchants by name only. Matches are stored and reused in later months."
        right={<Pill tone={matched === matches.length ? 'ok' : 'warn'}>{matched} of {matches.length} matched</Pill>}
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-line-soft"><Th className="pl-5">Name on ACH report</Th><Th>MID</Th><Th>CRM record</Th><Th>Status</Th></tr>
          </thead>
          <tbody>
            {matches.map((m) => (
              <tr key={m.name} className="border-b border-line-soft last:border-0">
                <td className="px-5 py-2.5 font-mono text-[12px] font-semibold">{m.name}</td>
                <td className="px-3 py-2.5 font-mono text-[12.5px]">{m.mid ?? '—'}</td>
                <td className="px-3 py-2.5 text-ink-600">{m.recordName ?? '—'}</td>
                <td className="px-3 py-2.5">
                  {m.mid ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-ok">
                      <Icon name="check" size={13} /> {m.matchedBy === 'auto_name' ? 'Matched by name' : 'Matched'}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-warn"><Icon name="alert-triangle" size={13} /> Unmatched, not calculated</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ── Accept.blue ─────────────────────────────────────────────────────────── */

export function AcceptBlueTab({ view, month }: { view: AcceptBlueView | null; month?: string }) {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [q, setQ] = useState('');
  if (!view) return <NoReport label="Accept.blue" month={month} />;
  const legend = LEGENDS.acceptblue;
  const counts: Partial<Record<FlagColor, number>> = {};
  for (const m of view.merchants) if (m.color) counts[m.color] = (counts[m.color] ?? 0) + 1;
  const visible = view.merchants.filter((m) => {
    if (q && !`${m.mid ?? ''} ${m.reportMid ?? ''} ${m.displayName}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'all') return true;
    if (filter === 'clean') return !m.color;
    return m.color === filter;
  });
  const MATCH: Record<string, string> = { exact: 'Exact MID', trailing_zero: 'Trailing zero dropped', name_exception: 'Name exception' };
  const off = (field: string, m: (typeof view.merchants)[number]) => m.alerts.some((a) => a.field === field && (a.color === 'red' || a.color === 'green'));

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr_1fr]">
        <SourceCard source={view.source} notes={[`Expected Accept.blue charge ${money(view.expectedTotal)}`]} label="Accept.blue report" />
        <FlagCounts legend={legend} counts={counts} clean={view.merchants.filter((m) => !m.color).length} alerts={view.merchants.reduce((s, m) => s + m.alerts.length, 0)} />
        <NetCard label="Accept.blue charged (ISO Total)" total={view.chargedTotal} mids={view.merchants.length} footnote="Each merchant's ISO Total goes to the Final Tally" />
      </div>
      <Panel>
        <FilterBar<FilterKey>
          options={[{ key: 'all', label: 'All merchants' }, ...legend.map((l) => ({ key: l.color as FilterKey, label: l.label, color: l.color })), { key: 'clean', label: 'Clean', color: null }]}
          value={filter}
          onChange={setFilter}
          q={q}
          onQ={setQ}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-[13px]">
            <thead>
              <tr className="border-b border-line-soft">
                <Th className="pl-5">Merchant / MID</Th>
                <Th>Matched by</Th>
                <Th right>Monthly exp / charged</Th>
                <Th right>Transactions exp / charged</Th>
                <Th right>Updater + DAF</Th>
                <Th right>Expected</Th>
                <Th right>ISO Total</Th>
                <Th>Notifications</Th>
              </tr>
            </thead>
            <tbody>
              {visible.map((m) => (
                <tr key={`${m.name}-${m.reportMid}`} className={`border-b border-line-soft last:border-0 ${m.color ? FLAG_ROW[m.color] : ''}`}>
                  <td className="px-5 py-2.5">
                    <div className="flex items-start gap-2"><span className="mt-1.5"><FlagDot color={m.color} /></span><MerchantCell name={m.displayName} mid={m.mid ?? ''} recordId={m.recordId} /></div>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-ink-600">{m.matchedBy ? MATCH[m.matchedBy] : '—'}</td>
                  <td className={`tabular px-3 py-2.5 text-right ${off('monthly', m) ? 'font-bold text-bad' : ''}`}>
                    {money(m.expected ? Number(m.expected.monthly) : null)} / {money(Number(m.charged.monthly))}
                  </td>
                  <td className={`tabular px-3 py-2.5 text-right ${off('transaction', m) ? 'font-bold text-bad' : ''}`}>
                    {money(m.expected ? Number(m.expected.transaction) : null)} / {money(Number(m.charged.transaction))}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right">{money(Number(m.charged.cardUpdaterPerUpdate) + Number(m.charged.daf))}</td>
                  <td className="tabular px-3 py-2.5 text-right">{money(m.expected ? Number(m.expected.total) : null)}</td>
                  <td className="tabular px-3 py-2.5 text-right font-bold">{money(Number(m.isoTotal))}</td>
                  <td className="max-w-[320px] px-3 py-2.5">
                    {m.alerts.length ? (
                      <ul className="space-y-0.5">{m.alerts.map((a, i) => <li key={i} className="text-[11.5px] leading-snug text-ink-700">{a.message}</li>)}</ul>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-ok"><Icon name="check" size={13} /> All clear</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-canvas font-semibold">
                <td colSpan={5} className="px-5 py-3 text-right">Totals</td>
                <td className="tabular px-3 py-3 text-right">{money(view.expectedTotal)}</td>
                <td className="tabular px-3 py-3 text-right text-[15px] font-bold">{money(view.chargedTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
        {view.missingFromReport.length > 0 && (
          <div className="border-t border-line-soft px-5 py-3 text-[12.5px] text-warn">
            Set up for Accept.blue in the CRM but missing from this report: {view.missingFromReport.join(', ')}
          </div>
        )}
      </Panel>
    </div>
  );
}

export function NoReport({ label, month }: { label: string; month?: string }) {
  return (
    <Panel className="px-6 py-10 text-center">
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-canvas text-ink-400"><Icon name="upload" size={18} /></div>
      <h3 className="mt-3 text-[15px] font-semibold">No {label} report for {month ?? 'this month'}</h3>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-500">
        Load the report for this month and the reconciliation runs automatically. The {label} report has not been loaded yet.
      </p>
    </Panel>
  );
}
