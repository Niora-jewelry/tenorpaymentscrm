'use client';

/**
 * The processor's template buy rates.
 *
 * ── RATES ARE RENDERED AS TEXT, NEVER PARSED ─────────────────────────────
 * Every rate arrives from SQL as a string and is printed as one. Daniel's
 * rule, and it is not fussiness: `numeric(14,2)` survives a round trip as a
 * string and does not survive one as a JavaScript number, which has a single
 * floating-point type. The client formats; it never computes.
 *
 * So there is no `Number(rate)` anywhere below, and no total row — a total
 * would mean adding them up here, which is exactly the thing that must happen
 * in SQL or not at all.
 *
 * ── READ-ONLY, DELIBERATELY ──────────────────────────────────────────────
 * These are the processor's own published rates, not ours to edit. Changing
 * one means a dated successor to the whole schedule, which is a different
 * screen and a different decision. Showing them read-only is honest about
 * that rather than offering an edit that would silently rewrite history.
 */
import { useMemo, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { OutlineChip } from '@/proto/ui/kit';
import type { BuyRateRow } from '@/lib/records/adminResiduals';
import { Empty, Panel, PanelHead } from './ResidualsTabs';

const TIER_LABEL: Record<string, string> = {
  no_program: 'No program',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  vendor_flat: 'Flat',
};

export function BuyRatesSection({
  rates,
  processors,
}: {
  rates: BuyRateRow[];
  processors: string[];
}) {
  const [query, setQuery] = useState('');

  /*
   * One row per fee item, one column per tier. The source is one row per
   * (item, tier) pair, and reading forty of those as a flat list to compare
   * two tiers of one item is the thing this pivot exists to prevent.
   */
  const pivoted = useMemo(() => {
    const byItem = new Map<string, Record<string, string | null>>();
    for (const r of rates) {
      const row = byItem.get(r.feeItem) ?? {};
      row[r.riskTier] = r.rate;
      byItem.set(r.feeItem, row);
    }
    const q = query.trim().toLowerCase();
    return [...byItem.entries()]
      .filter(([item]) => !q || item.toLowerCase().includes(q))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [rates, query]);

  const tiers = useMemo(() => {
    const seen = new Set(rates.map((r) => r.riskTier));
    return ['no_program', 'low', 'medium', 'high', 'vendor_flat'].filter((t) => seen.has(t));
  }, [rates]);

  if (rates.length === 0) {
    return (
      <Panel>
        <Empty
          title="No buy rates loaded"
          body="Buy rates come with the processor's template. Without them the engine cannot work out what a fee item cost TapDash, and it refuses to guess."
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead>
        <h2 className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink-900">
          Buy rates
          {processors.map((p) => (
            <OutlineChip key={p} tone="brand">
              {p}
            </OutlineChip>
          ))}
        </h2>
        <div className="relative">
          <Icon
            name="search"
            size={12}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fee item"
            aria-label="Search fee items"
            className="w-[220px] rounded-lg border border-line bg-white py-1.5 pl-7 pr-2 text-[12.5px] text-ink-900 outline-none focus-field"
          />
        </div>
      </PanelHead>

      <div className="max-h-[560px] overflow-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-line-soft text-[11.5px] uppercase tracking-wide text-ink-400">
              <th className="px-4 py-2 font-semibold">Fee item</th>
              {tiers.map((t) => (
                <th key={t} className="px-4 py-2 text-right font-semibold">
                  {TIER_LABEL[t] ?? t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pivoted.map(([item, row]) => (
              <tr key={item}>
                <td className="border-b border-line-faint px-4 py-2 text-[13px] text-ink-900">
                  {item}
                </td>
                {tiers.map((t) => (
                  <td
                    key={t}
                    className="border-b border-line-faint px-4 py-2 text-right text-[13px] tabular text-ink-700"
                  >
                    {/* Printed, not parsed. A missing rate is a dash, which is
                        a different claim from a rate of zero. */}
                    {row[t] ?? <span className="text-ink-300">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {pivoted.length === 0 ? (
          <p className="px-4 py-5 text-center text-[13px] text-ink-400">Nothing matches “{query}”.</p>
        ) : null}
      </div>

      <p className="border-t border-line-faint px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-400">
        A blank cell means no rate is on file for that tier, which is not the same as a rate of
        zero — the engine refuses to compute against a missing rate rather than booking the cost
        as free.
      </p>
    </Panel>
  );
}
