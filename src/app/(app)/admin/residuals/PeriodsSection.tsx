'use client';

/**
 * Statement periods.
 *
 * `calculation_version` is shown as plain words rather than a number, because
 * the number means nothing to a reader and NULL means two different things
 * that Daniel deliberately did not separate:
 *
 *   "calculation_version NULL covers both never-computed and
 *    invalidated-since, which are not usefully different to a reader."
 *
 * So it says "not calculated" for both, which is the true statement.
 */
import type { ResidualPeriod } from '@/lib/records/adminResiduals';
import { Empty, Panel, PanelHead, PeriodStatus } from './ResidualsTabs';

function monthLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function PeriodsSection({ periods }: { periods: ResidualPeriod[] }) {
  if (periods.length === 0) {
    return (
      <Panel>
        <Empty
          title="No statement periods yet"
          body="A period appears when a processor fee report is imported. Until then there is nothing to calculate — the rules and rates below are in place and waiting for one."
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead>
        <h2 className="text-[14px] font-semibold text-ink-900">
          Periods <span className="ml-1 font-normal text-ink-400">({periods.length})</span>
        </h2>
      </PanelHead>

      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-line-soft text-[11.5px] uppercase tracking-wide text-ink-400">
            <th className="px-4 py-2 font-semibold">Month</th>
            <th className="px-4 py-2 font-semibold">Status</th>
            <th className="px-4 py-2 font-semibold tabular">Lines</th>
            <th className="px-4 py-2 font-semibold tabular">Merchants</th>
            <th className="px-4 py-2 font-semibold">Calculated</th>
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.id}>
              <td className="border-b border-line-faint px-4 py-2.5 text-[13.5px] font-medium text-ink-900">
                {monthLabel(p.statementMonth)}
              </td>
              <td className="border-b border-line-faint px-4 py-2.5">
                <PeriodStatus status={p.status} />
              </td>
              <td className="border-b border-line-faint px-4 py-2.5 text-[13px] tabular text-ink-700">
                {p.lineCount}
              </td>
              <td className="border-b border-line-faint px-4 py-2.5 text-[13px] tabular text-ink-700">
                {p.mids}
              </td>
              <td className="border-b border-line-faint px-4 py-2.5 text-[13px] text-ink-500">
                {p.calculationVersion === null ? 'Not calculated' : `Version ${p.calculationVersion}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
