'use client';
/**
 * The Residuals page: month picker, seven tabs, and the views behind them. Layout follows the
 * Lovable "payment-reconcile-lab" interface; every number comes from `loadWorkspace` (database +
 * TypeScript calculator).
 */
import Link from 'next/link';
import { useState } from 'react';
import { Icon, type IconName } from '@/proto/ui/icons';
import type { RiskLevel } from '@/lib/residuals/calc/types';
import type { TemplateGridRow, WorkspaceData } from '@/lib/residuals/workspace';
import { AcceptBlueTab, ReconTab } from './ReconPanels';
import { FlagDot, Panel, PanelHeader, Pill, RISK_LABEL, RiskPill, Stat, Th, money, percent } from './ui';

export type WorkspaceTab = 'dashboard' | 'tally' | 'acquiring' | 'ach' | 'acceptblue' | 'buyrates' | 'partners';

const TABS: { id: WorkspaceTab; label: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-list' },
  { id: 'tally', label: 'Final Tally', icon: 'check' },
  { id: 'acquiring', label: 'Acquiring', icon: 'percent' },
  { id: 'ach', label: 'ACH', icon: 'database' },
  { id: 'acceptblue', label: 'Accept.blue', icon: 'link' },
  { id: 'buyrates', label: 'Buy Rate Template', icon: 'sliders' },
  { id: 'partners', label: 'Partner List', icon: 'users' },
];

export function ResidualsWorkspace({ data, initialTab }: { data: WorkspaceData; initialTab: WorkspaceTab }) {
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const select = (t: WorkspaceTab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', t);
    window.history.replaceState(null, '', url);
  };
  const { period } = data;
  const reconCount = [data.acquiring, data.ach, data.acceptBlue].filter(Boolean).length;

  return (
    <div className="min-w-0 px-5 py-6 lg:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-bold tracking-tight text-ink-900">Residuals</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-ink-500">
            <span>{period?.label ?? 'No months yet'}</span>
            <span aria-hidden>·</span>
            <span>{reconCount} reconciliation{reconCount === 1 ? '' : 's'}</span>
            <span aria-hidden>·</span>
            {period?.status === 'locked' ? (
              <span className="inline-flex items-center gap-1"><Icon name="lock" size={12} /> Locked</span>
            ) : (
              <span className="font-semibold text-warn">{period ? 'Open' : ''}</span>
            )}
          </p>
        </div>
        <Link
          href="/admin/residuals"
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white px-3 py-2 text-[13px] font-semibold text-ink-800 hover:bg-canvas"
        >
          <Icon name="upload" size={14} /> Imports and periods
        </Link>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <MonthPicker data={data} tab={tab} />
      </div>

      <nav className="no-scrollbar mt-4 flex gap-0.5 overflow-x-auto border-b border-line" aria-label="Residuals sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => select(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[13px] font-semibold transition-colors ${
              tab === t.id ? 'border-brand-700 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-900'
            }`}
          >
            <Icon name={t.icon} size={15} /> {t.label}
          </button>
        ))}
      </nav>

      <section className="mt-5" key={tab}>
        {tab === 'dashboard' && <Dashboard data={data} goTo={select} />}
        {tab === 'tally' && <FinalTally data={data} />}
        {tab === 'acquiring' && <ReconTab kind="acquiring" view={data.acquiring} label="Acquiring" data={data} />}
        {tab === 'ach' && <ReconTab kind="ach" view={data.ach} label="ACH" data={data} />}
        {tab === 'acceptblue' && <AcceptBlueTab view={data.acceptBlue} month={period?.label} />}
        {tab === 'buyrates' && <BuyRates data={data} />}
        {tab === 'partners' && <Partners data={data} />}
      </section>
    </div>
  );
}

function MonthPicker({ data, tab }: { data: WorkspaceData; tab: WorkspaceTab }) {
  return (
    <details className="relative">
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-md border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink-900 hover:bg-canvas">
        <Icon name="calendar" size={14} className="text-ink-400" /> {data.period?.label ?? 'Pick a month'}
        <Icon name="chevron-down" size={13} className="text-ink-400" />
      </summary>
      <div className="absolute left-0 z-20 mt-1 w-64 rounded-lg border border-line bg-white p-1.5 shadow-lg">
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Statement month</div>
        {data.periods.map((p) => (
          <Link
            key={p.id}
            href={`/residuals?month=${p.month}&tab=${tab}`}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-canvas ${p.id === data.period?.id ? 'font-semibold text-ink-900' : 'text-ink-700'}`}
          >
            <span className="flex-1">{p.label}</span>
            {p.status === 'locked' ? <Icon name="lock" size={12} className="text-ink-400" /> : <span className="text-[11.5px] font-semibold text-warn">Open</span>}
          </Link>
        ))}
        {!data.periods.length && <div className="px-2 py-2 text-[13px] text-ink-500">No months yet. Create one on the admin page.</div>}
      </div>
    </details>
  );
}

/* ── Dashboard ───────────────────────────────────────────────────────────── */

const SKIP_LABEL: Record<string, string> = {
  RISK_LEVEL_BLANK: 'blank risk level',
  MID_NOT_IN_CRM: 'not in the CRM',
  NO_STATEMENT: 'no statement',
};

function Dashboard({ data, goTo }: { data: WorkspaceData; goTo: (t: WorkspaceTab) => void }) {
  const { totals, counts, tally } = data;
  const skipped = Object.entries(counts.skippedReasons).map(([k, n]) => `${n} ${SKIP_LABEL[k] ?? k.toLowerCase()}`).join(', ');
  const top = tally.filter((t) => t.aggregate > 0).slice(0, 5);
  const max = top[0]?.aggregate || 1;
  const byPartner = data.partners.map((p) => {
    const rows = tally.filter((t) => t.partner?.id === p.id);
    return { p, mids: rows.length, payout: rows.reduce((s, r) => s + r.payout, 0) };
  });
  const unassigned = tally.filter((t) => !t.partner).length;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Stat label="MIDs calculated" value={`${counts.midsCalculated}`} sub={counts.midsSkipped ? `${counts.midsSkipped} skipped · ${skipped}` : 'None skipped'} />
        <Stat label="Acquiring" value={money(totals.acquiring)} sub="Maverick fee item report" />
        <Stat label="ACH" value={money(totals.ach)} sub="Maverick ACH fee report" />
        <Stat label="Accept.blue" value={money(-totals.acceptBlue)} sub="Charged to TapDash (ISO Total)" />
        <Stat label="Partner payout" value={money(totals.payout)} sub={`ISO retains ${money(totals.isoRetained)}`} />
        <Stat accent label="Grand total" value={money(totals.aggregate)} sub="All reconciliations" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Panel>
          <PanelHeader title="Residuals by month" sub={`Net across all MIDs, last ${data.trend.length} month${data.trend.length === 1 ? '' : 's'} on file`} />
          <TrendChart trend={data.trend} />
        </Panel>
        <Panel>
          <PanelHeader title="Top merchants" sub="By aggregate residual" right={<button type="button" onClick={() => goTo('tally')} className="text-[12px] font-semibold text-brand-600 hover:underline">Final Tally</button>} />
          <div className="space-y-3.5 p-5">
            {top.map((r) => (
              <div key={r.mid}>
                <div className="mb-1.5 flex items-center justify-between gap-3 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2 font-semibold"><FlagDot color={r.color} /><span className="truncate">{r.name}</span></span>
                  <span className="tabular shrink-0 font-bold">{money(r.aggregate)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-canvas">
                  <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.max(2, (r.aggregate / max) * 100)}%` }} />
                </div>
              </div>
            ))}
            {!top.length && <p className="text-[13px] text-ink-500">Nothing calculated for this month yet.</p>}
          </div>
        </Panel>
      </div>

      <Panel>
        <PanelHeader
          title="Partner payouts"
          sub="Split applied to each MID's aggregate, including per-MID adjustments"
          right={<span className="tabular text-[14px] font-bold">{money(totals.payout)}</span>}
        />
        {unassigned > 0 && (
          <div className="border-b border-line-soft bg-warn-bg/60 px-5 py-2.5 text-[12.5px] text-ink-700">
            {unassigned} of {tally.length} MIDs have no partner assigned, so their whole aggregate stays with the ISO. Assign partners on the Partner List.
          </div>
        )}
        <div className="grid gap-px bg-line-soft sm:grid-cols-2 xl:grid-cols-3">
          {byPartner.map(({ p, mids, payout }) => (
            <div key={p.id} className="flex items-center gap-3 bg-white px-5 py-4">
              <Initials name={p.name} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold">{p.name}</div>
                <div className="text-[12px] text-ink-500">{mids} MIDs · {percent(p.defaultSplit)} standard</div>
              </div>
              <div className="text-right">
                <div className="tabular font-bold">{money(payout)}</div>
                <div className="tabular text-[12px] text-ink-500">{totals.payout ? Math.round((payout / totals.payout) * 100) : 0}%</div>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function TrendChart({ trend }: { trend: WorkspaceData['trend'] }) {
  const W = 640, H = 260, L = 64, R = 16, T = 16, B = 34;
  const hi = Math.max(1, ...trend.map((t) => t.acquiring + Math.max(0, t.ach)));
  const lo = Math.min(0, ...trend.map((t) => -t.acceptBlue + Math.min(0, t.ach)));
  const step = niceStep((hi - lo) / 4);
  const top = Math.ceil(hi / step) * step;
  const bottom = Math.floor(lo / step) * step;
  const y = (v: number) => T + ((top - v) / (top - bottom)) * (H - T - B);
  const ticks: number[] = [];
  for (let v = bottom; v <= top + 1e-9; v += step) ticks.push(v);
  const slot = (W - L - R) / Math.max(trend.length, 1);
  const bw = Math.min(56, slot * 0.5);
  const kfmt = (v: number) => `${v < 0 ? '−' : ''}$${(Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k`;

  return (
    <div className="px-3 py-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Net residuals by month: Acquiring and ACH above zero, Accept.blue charges below">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="var(--color-line-soft)" strokeWidth={v === 0 ? 1.5 : 1} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--color-ink-400)">{kfmt(v)}</text>
          </g>
        ))}
        {trend.map((t, i) => {
          const cx = L + slot * i + slot / 2;
          const acqTop = y(t.acquiring);
          const achTop = y(t.acquiring + Math.max(0, t.ach));
          return (
            <g key={t.month}>
              <rect x={cx - bw / 2} y={acqTop} width={bw} height={Math.max(0, y(0) - acqTop)} fill="var(--color-brand-700)">
                <title>{`${t.label} Acquiring ${money(t.acquiring)}`}</title>
              </rect>
              <rect x={cx - bw / 2} y={achTop} width={bw} height={Math.max(0, acqTop - achTop)} fill="var(--color-brand-300)">
                <title>{`${t.label} ACH ${money(t.ach)}`}</title>
              </rect>
              <rect x={cx - bw / 2} y={y(0)} width={bw} height={Math.max(0, y(-t.acceptBlue) - y(0))} fill="var(--color-warn)" opacity={0.75}>
                <title>{`${t.label} Accept.blue charged ${money(t.acceptBlue)}`}</title>
              </rect>
              <text x={cx} y={H - 12} textAnchor="middle" fontSize="12" fill="var(--color-ink-500)">{t.label}</text>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 px-2 text-[12px] text-ink-600">
        <Swatch c="bg-brand-700" l="Acquiring" /><Swatch c="bg-brand-300" l="ACH" /><Swatch c="bg-warn/75" l="Accept.blue charged" />
      </div>
    </div>
  );
}
const niceStep = (raw: number) => {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
};
const Swatch = ({ c, l }: { c: string; l: string }) => (
  <span className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${c}`} />{l}</span>
);
const Initials = ({ name }: { name: string }) => (
  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-900 text-[11.5px] font-bold text-white">
    {name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
  </div>
);

/* ── Final Tally ─────────────────────────────────────────────────────────── */

function FinalTally({ data }: { data: WorkspaceData }) {
  const locked = data.period?.status === 'locked';
  const { tally, totals } = data;
  return (
    <div className="space-y-5">
      <div className={`flex flex-wrap items-center gap-3 rounded-xl border px-5 py-3.5 ${locked ? 'border-ok/25 bg-ok-bg' : 'border-warn/25 bg-warn-bg'}`}>
        <Icon name="lock" size={18} className={locked ? 'text-ok' : 'text-warn'} />
        <div className="min-w-0 flex-1 text-[13px]">
          <span className="font-semibold">{locked ? 'This month is locked.' : 'This month is still open.'}</span>{' '}
          <span className="text-ink-600">
            {locked ? 'Reconciliations, tallies and payouts are frozen.' : 'Figures recalculate from the database on every load until the month is locked.'}
          </span>
        </div>
      </div>
      <Panel>
        <PanelHeader
          title="Final tally per MID"
          sub="Acquiring and ACH nets, less what Accept.blue charged, with the partner split applied to the aggregate"
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-[13px]">
            <thead>
              <tr className="border-b border-line-soft">
                <Th className="pl-5">Merchant / MID</Th><Th right>Acquiring</Th><Th right>ACH</Th><Th right>Accept.blue</Th><Th right>Aggregate</Th>
                <Th>Partner</Th><Th right>Split</Th><Th right>Partner payout</Th><Th right className="pr-5">ISO retained</Th>
              </tr>
            </thead>
            <tbody>
              {tally.map((r) => (
                <tr key={r.mid} className="border-b border-line-soft hover:bg-canvas/60">
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2 font-semibold">
                      <FlagDot color={r.color} />
                      {r.recordId ? <Link href={`/records?record=${r.recordId}`} className="hover:text-brand-600 hover:underline">{r.name}</Link> : r.name}
                    </div>
                    <div className="pl-4 font-mono text-[11.5px] text-ink-400">{r.mid}</div>
                  </td>
                  <td className="tabular px-3 py-2.5 text-right">{money(r.acquiring)}</td>
                  <td className="tabular px-3 py-2.5 text-right text-ink-600">{r.ach == null ? '—' : money(r.ach)}</td>
                  <td className="tabular px-3 py-2.5 text-right text-ink-600">{r.acceptBlue == null ? '—' : money(-r.acceptBlue)}</td>
                  <td className="tabular px-3 py-2.5 text-right font-bold">{money(r.aggregate)}</td>
                  <td className="px-3 py-2.5">{r.partner ? <Pill>{r.partner.name}</Pill> : <span className="text-[12px] text-ink-400">Unassigned</span>}</td>
                  <td className="tabular px-3 py-2.5 text-right">
                    {r.partner ? <>{percent(r.split)}{r.adjusted && <span className="ml-1.5"><Pill tone="brand">MID adj.</Pill></span>}</> : '—'}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right font-semibold">{money(r.payout)}</td>
                  <td className="tabular px-5 py-2.5 text-right">{money(r.isoRetained)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-canvas font-semibold">
                <td className="px-5 py-3">Totals</td>
                <td className="tabular px-3 py-3 text-right">{money(totals.acquiring)}</td>
                <td className="tabular px-3 py-3 text-right">{money(totals.ach)}</td>
                <td className="tabular px-3 py-3 text-right">{money(-totals.acceptBlue)}</td>
                <td className="tabular px-3 py-3 text-right text-[15px] font-bold">{money(totals.aggregate)}</td>
                <td colSpan={2} />
                <td className="tabular px-3 py-3 text-right">{money(totals.payout)}</td>
                <td className="tabular px-5 py-3 text-right">{money(totals.isoRetained)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/* ── Buy Rate Template ───────────────────────────────────────────────────── */

const fmtRate = (row: TemplateGridRow, v: number | null) => {
  if (v == null) return '—';
  if (row.kind === 'share') return percent(v);
  if (row.kind === 'rate') return `${(v * 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
};

function BuyRates({ data }: { data: WorkspaceData }) {
  const [section, setSection] = useState<'card' | 'ach'>('card');
  const rows = data.template[section];
  const tiers: RiskLevel[] = section === 'card' ? ['no_risk', 'low_risk', 'moderate_risk', 'high_risk'] : ['low_risk', 'moderate_risk', 'high_risk'];
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-line bg-white p-0.5">
        {([['card', 'Maverick'], ['ach', 'Maverick ACH']] as const).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setSection(k)}
            className={`rounded-md px-4 py-1.5 text-[13px] font-semibold ${section === k ? 'bg-brand-900 text-white' : 'text-ink-600 hover:text-ink-900'}`}
          >
            {l}
          </button>
        ))}
      </div>
      <Panel>
        <PanelHeader
          title={section === 'card' ? 'Maverick buy rates' : 'Maverick ACH buy rates'}
          sub={section === 'card' ? 'What Maverick charges TapDash, by the merchant’s Risk Level' : 'No Risk merchants use the Low Risk column'}
          right={<Pill tone="brand">{rows.length - 1} rates × {tiers.length} tiers</Pill>}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line-soft">
                <Th className="pl-5">Fee</Th>
                {tiers.map((t) => <Th key={t} right>{RISK_LABEL[t]}</Th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={`border-b border-line-soft last:border-0 ${r.kind === 'share' ? 'bg-ok-bg/60' : ''}`}>
                  <td className="px-5 py-2.5 font-semibold">{r.label}</td>
                  {tiers.map((t) => (
                    <td key={t} className={`tabular px-3 py-2.5 text-right ${r.values[t] === 0 ? 'text-ink-400' : ''}`}>{fmtRate(r, r.values[t] ?? null)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line-soft px-5 py-3 text-[12px] text-ink-500">
          Read from residual_buy_rates and residual_buy_rate_tiers. The calculators use these rates. Editing with a change log is the next step.
          {data.template.missing.length > 0 && <span className="text-warn"> Missing: {data.template.missing.join(', ')}.</span>}
        </div>
      </Panel>
    </div>
  );
}

/* ── Partner List ────────────────────────────────────────────────────────── */

function Partners({ data }: { data: WorkspaceData }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const assigned = data.partners.reduce((s, p) => s + p.mids.length, 0);
  return (
    <div className="space-y-4">
      {assigned === 0 && (
        <div className="rounded-xl border border-warn/25 bg-warn-bg px-5 py-3 text-[13px] text-ink-700">
          No MIDs are assigned to a partner yet, so every MID shows as Unassigned on the Final Tally.
        </div>
      )}
      {data.partners.map((p) => {
        const isOpen = !!open[p.id];
        return (
          <Panel key={p.id}>
            <button type="button" onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))} className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-canvas/60">
              <Initials name={p.name} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{p.name} {!p.active && <Pill>Inactive</Pill>}</div>
                <div className="text-[12px] text-ink-500">{p.mids.length} MIDs · {p.mids.filter((m) => m.adjusted).length} with adjustment</div>
              </div>
              <div className="text-right">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Standard split</div>
                <div className="tabular text-[20px] font-bold">{percent(p.defaultSplit)}</div>
              </div>
              <Icon name={isOpen ? 'chevron-up' : 'chevron-down'} size={18} className="text-ink-400" />
            </button>
            {isOpen && (
              <div className="overflow-x-auto border-t border-line-soft">
                <table className="w-full min-w-[560px] text-[13px]">
                  <thead>
                    <tr className="border-b border-line-soft bg-canvas/70"><Th className="pl-5">Merchant / MID</Th><Th>Risk level</Th><Th right className="pr-5">Split applied</Th></tr>
                  </thead>
                  <tbody>
                    {p.mids.map((m) => (
                      <tr key={m.mid} className="border-b border-line-soft last:border-0">
                        <td className="px-5 py-2.5"><div className="font-semibold">{m.name}</div><div className="font-mono text-[11.5px] text-ink-400">{m.mid}</div></td>
                        <td className="px-3 py-2.5"><RiskPill risk={m.riskLevel} /></td>
                        <td className="tabular px-5 py-2.5 text-right font-semibold">
                          {percent(m.split)} <span className="ml-1.5">{m.adjusted ? <Pill tone="brand">Adjusted</Pill> : <Pill>Standard</Pill>}</span>
                        </td>
                      </tr>
                    ))}
                    {!p.mids.length && <tr><td colSpan={3} className="px-5 py-4 text-[13px] text-ink-500">No MIDs assigned to {p.name}.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
