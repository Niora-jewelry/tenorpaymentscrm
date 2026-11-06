'use client';

/**
 * Reporting (Maverick Integration spec, Reporting tab): the processor's data for
 * this merchant, in a full-screen view with a left-hand panel.
 *
 *   Acquiring › Acquiring transactions, Batch reports, Payout reports
 *   ACH › Transactions
 *
 * Read-only. No export, no download, no totals. Filters sit on the column
 * headers, like Excel, and several can be on at once. Card numbers show the
 * last four digits only. "Last updated" says how fresh it is.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import type { ReportingPanel as PanelData, ReportPage } from '@/lib/processors/service';
import { reportView, SECTIONS, type ReportColumn, type ReportFilters, type ReportViewKey } from '@/lib/processors/reportingViews';
import { reportingRowsAction } from './processorActions';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
const money = (n: unknown) => (typeof n === 'number' || (typeof n === 'string' && n !== '') ? Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '');

function cell(c: ReportColumn, v: string | number | null | undefined): string {
  if (v == null || v === '') return '';
  switch (c.kind) {
    case 'money':
      return money(v);
    case 'int':
      return Number(v).toLocaleString('en-US');
    case 'date':
      return new Date(`${String(v).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    case 'datetime':
      return new Date(String(v)).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    case 'last4':
      return `•••• ${String(v)}`;
    default:
      return String(v);
  }
}

export function ReportingPanel({ recordId, data }: { recordId: string; data: PanelData }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(14,28,52,.05)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-900 text-white">
          <Icon name="layout-list" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-ink-900">Reporting</h3>
          <p className="text-[12px] text-ink-500">
            {data.lastUpdated ? `Last updated ${when(data.lastUpdated)}.` : 'Not updated yet.'} Transactions, batches, payouts and ACH activity, read-only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-900 px-3 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-brand-800"
        >
          <Icon name="panel-left-open" size={14} /> Open Reporting
        </button>
      </header>
      {!data.matched && !data.connected ? (
        <p className="flex items-start gap-2 border-t border-line-soft bg-canvas px-4 py-2.5 text-[12.5px] text-ink-500">
          <Icon name="info" size={13} className="mt-[2px] shrink-0" />
          Data appears here once the processor is connected and the daily sync has run.
        </p>
      ) : null}
      <ul className="grid gap-px border-t border-line-soft bg-line-soft sm:grid-cols-2">
        {SECTIONS.map((s) => {
          const views = data.views.filter((v) => v.section === s.key);
          if (!views.length) return null;
          return (
            <li key={s.key} className="bg-white px-4 py-3">
              <p className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">{s.label}</p>
              <p className="mt-0.5 text-[12.5px] text-ink-600">{views.map((v) => v.label).join(' · ')}</p>
            </li>
          );
        })}
      </ul>
      {open ? <ReportingView recordId={recordId} data={data} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

function ReportingView({ recordId, data, onClose }: { recordId: string; data: PanelData; onClose: () => void }) {
  const [viewKey, setViewKey] = useState<ReportViewKey>(data.views[0]!.key);
  const [filters, setFilters] = useState<Record<string, ReportFilters>>({});
  const [pages, setPages] = useState<ReportPage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, start] = useTransition();
  const view = reportView(viewKey)!;
  const active = filters[viewKey] ?? {};
  const options = pages[0]?.options ?? {};

  const load = useCallback(
    (page: number, f: ReportFilters) =>
      start(async () => {
        setError(null);
        const r = await reportingRowsAction({ recordId, view: viewKey, filters: f, page });
        if (!r.ok) return setError(r.message);
        setPages((p) => (page === 0 ? [r.data] : [...p, r.data]));
      }),
    [recordId, viewKey],
  );

  useEffect(() => {
    load(0, filters[viewKey] ?? {});
    // Reload when the screen or its filters change; `filters` is read through the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, JSON.stringify(filters[viewKey] ?? {})]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const setFilter = (col: string, f: ReportFilters[string] | null) =>
    setFilters((all) => {
      const next = { ...(all[viewKey] ?? {}) };
      if (f) next[col] = f;
      else delete next[col];
      return { ...all, [viewKey]: next };
    });

  const rows = pages.flatMap((p) => p.rows);
  const more = pages.at(-1)?.more ?? false;
  const filterCount = Object.keys(active).length;

  // Opened by a click, so it only ever renders in the browser.
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Reporting" className="fixed inset-0 z-[95] flex flex-col bg-canvas">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-white px-4 py-3 sm:px-6">
        <button type="button" onClick={onClose} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[13px] font-semibold text-ink-700 hover:bg-canvas">
          <Icon name="chevron-left" size={14} /> Back to record
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold text-ink-900">Reporting</h2>
          <p className="text-[12px] text-ink-500">{data.lastUpdated ? `Last updated ${when(data.lastUpdated)}` : 'Not updated yet'} · Read-only</p>
        </div>
        {filterCount ? (
          <button type="button" onClick={() => setFilters((all) => ({ ...all, [viewKey]: {} }))} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold text-brand-700 hover:bg-brand-50">
            <Icon name="x" size={12} /> Clear {filterCount} filter{filterCount === 1 ? '' : 's'}
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav aria-label="Reports" className="shrink-0 border-b border-line bg-white p-3 md:w-[230px] md:border-b-0 md:border-r">
          {SECTIONS.map((s) => {
            const views = data.views.filter((v) => v.section === s.key);
            if (!views.length) return null;
            return (
              <div key={s.key} className="mb-3">
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[.08em] text-ink-400">{s.label}</p>
                <ul className="flex gap-1 overflow-x-auto md:block md:space-y-0.5">
                  {views.map((v) => (
                    <li key={v.key} className="shrink-0">
                      <button
                        type="button"
                        aria-current={v.key === viewKey ? 'page' : undefined}
                        onClick={() => {
                          setPages([]);
                          setViewKey(v.key);
                        }}
                        className={`w-full rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors ${v.key === viewKey ? 'bg-brand-900 text-white' : 'text-ink-700 hover:bg-canvas'}`}
                      >
                        {v.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <main className="min-h-0 min-w-0 flex-1 overflow-auto p-3 sm:p-5">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-ink-900">{view.section === 'ach' ? 'ACH transactions' : view.label}</h3>
            {loading ? <Spinner /> : null}
          </div>
          {error ? <p role="alert" className="mb-3 rounded-lg border border-bad/20 bg-bad-bg px-3 py-2 text-[12.5px] text-bad">{error}</p> : null}
          <div className="overflow-x-auto rounded-xl border border-line bg-white">
            <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
              <thead className="sticky top-0 z-[1] bg-[#f7f9fc]">
                <tr className="border-b border-line">
                  {view.columns.map((c) => (
                    <th key={c.key} scope="col" className={`whitespace-nowrap px-3 py-2 text-[11.5px] font-semibold uppercase tracking-[.04em] text-ink-500 ${c.kind === 'money' || c.kind === 'int' ? 'text-right' : ''}`}>
                      <span className={`inline-flex items-center gap-1 ${c.kind === 'money' || c.kind === 'int' ? 'flex-row-reverse' : ''}`}>
                        {c.label}
                        {c.filter ? <HeaderFilter column={c} value={active[c.key]} options={options[c.key] ?? []} onChange={(f) => setFilter(c.key, f)} /> : null}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-line-faint last:border-0 hover:bg-[#fbfcfe]">
                    {view.columns.map((c) => (
                      <td key={c.key} className={`whitespace-nowrap px-3 py-2 text-ink-800 ${c.kind === 'money' || c.kind === 'int' ? 'text-right tabular-nums' : ''} ${c.kind === 'last4' ? 'font-mono text-[12.5px]' : ''}`}>
                        {cell(c, r[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && !loading ? (
              <p className="px-4 py-10 text-center text-[13px] text-ink-500">{filterCount ? 'Nothing matches these filters.' : data.matched ? view.empty : 'No data yet.'}</p>
            ) : null}
          </div>
          {more ? (
            <div className="mt-3 flex justify-center">
              <button type="button" disabled={loading} onClick={() => load(pages.length, active)} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:bg-canvas disabled:opacity-50">
                {loading ? <Spinner /> : <Icon name="chevron-down" size={13} />} Show more
              </button>
            </div>
          ) : null}
        </main>
      </div>
    </div>,
    document.body,
  );
}

/** The filter on a column header, like Excel: a checklist, a date range or four digits. */
function HeaderFilter({ column, value, options, onChange }: { column: ReportColumn; value: ReportFilters[string] | undefined; options: string[]; onChange: (f: ReportFilters[string] | null) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ReportFilters[string]>(value ?? {});
  const [search, setSearch] = useState('');
  const box = useRef<HTMLSpanElement>(null);
  const on = Boolean(value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const apply = () => {
    const empty = !draft.values?.length && !draft.from && !draft.to && !draft.last4;
    onChange(empty ? null : draft);
    setOpen(false);
  };

  const shown = options.filter((o) => o.toLowerCase().includes(search.toLowerCase()));
  return (
    <span ref={box} className="relative normal-case tracking-normal">
      <button
        type="button"
        aria-label={`Filter ${column.filterLabel ?? column.label}`}
        aria-expanded={open}
        onClick={() => {
          setDraft(value ?? {});
          setOpen((o) => !o);
        }}
        className={`grid size-5 place-items-center rounded ${on ? 'bg-brand-900 text-white' : 'text-ink-400 hover:bg-line-soft hover:text-ink-700'}`}
      >
        <Icon name="filter" size={11} />
      </button>
      {open ? (
        <div className="absolute left-0 top-6 z-10 w-[240px] rounded-xl border border-line bg-white p-3 text-left font-normal shadow-[0_12px_32px_-8px_rgba(14,28,52,.3)]">
          <p className="mb-2 text-[12px] font-semibold text-ink-800">{column.filterLabel ?? column.label}</p>
          {column.filter === 'values' ? (
            <>
              {options.length > 8 ? (
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="mb-2 w-full rounded-md border border-line px-2 py-1 text-[12.5px] outline-none focus:border-brand-500" />
              ) : null}
              <div className="max-h-[220px] space-y-0.5 overflow-y-auto">
                {shown.length ? (
                  shown.map((o) => {
                    const checked = draft.values?.includes(o) ?? false;
                    return (
                      <label key={o} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[12.5px] text-ink-700 hover:bg-canvas">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setDraft((d) => ({ ...d, values: e.target.checked ? [...(d.values ?? []), o] : (d.values ?? []).filter((x) => x !== o) }))}
                        />
                        <span className="truncate">{o}</span>
                      </label>
                    );
                  })
                ) : (
                  <p className="text-[12px] text-ink-400">Nothing to pick from yet.</p>
                )}
              </div>
            </>
          ) : column.filter === 'date' ? (
            <div className="grid gap-2">
              <label className="text-[11.5px] text-ink-500">
                From
                <input type="date" value={draft.from ?? ''} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value || undefined }))} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-[12.5px] text-ink-800" />
              </label>
              <label className="text-[11.5px] text-ink-500">
                To
                <input type="date" value={draft.to ?? ''} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value || undefined }))} className="mt-0.5 w-full rounded-md border border-line px-2 py-1 text-[12.5px] text-ink-800" />
              </label>
            </div>
          ) : (
            <input
              inputMode="numeric"
              maxLength={4}
              placeholder="Last 4 digits"
              value={draft.last4 ?? ''}
              onChange={(e) => setDraft({ last4: e.target.value.replace(/\D/g, '').slice(0, 4) || undefined })}
              className="w-full rounded-md border border-line px-2 py-1 font-mono text-[12.5px]"
            />
          )}
          <div className="mt-3 flex justify-between gap-2">
            <button type="button" onClick={() => { onChange(null); setOpen(false); }} className="rounded-md px-2 py-1 text-[12px] font-medium text-ink-500 hover:bg-canvas">
              Clear
            </button>
            <button type="button" onClick={apply} className="rounded-md bg-brand-900 px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-brand-800">
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
