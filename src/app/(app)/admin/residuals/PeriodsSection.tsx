'use client';

/**
 * Statement periods.
 *
 * ── TWO STATUSES, AND BOTH ARE SHOWN ─────────────────────────────────────
 * `residual_periods.status` is only ever 'open' or 'reconciled' — a CHECK
 * enforces it — and since R6a the engine writes no status at all. So the
 * stored column cannot tell a month that computed cleanly from one with four
 * blocked merchants: both read 'open'. The useful value is the one
 * `residual_period_state` derives at merchant grain, and that is what the
 * Status column shows. The stored value appears only where it differs, because
 * sign-off reads the stored one.
 *
 * ── `calculation_version` IS SHOWN AS WORDS ──────────────────────────────
 * The number means nothing to a reader, and NULL means two things Daniel
 * deliberately did not separate:
 *
 *   "calculation_version NULL covers both never-computed and
 *    invalidated-since, which are not usefully different to a reader."
 *
 * So it says "not calculated" for both, which is the true statement.
 *
 * ── WHY RE-COMPUTING IS A BUTTON AND NOT AUTOMATIC ───────────────────────
 * The engine's inputs change without the statement changing — a merchant's
 * rates get entered, a buy-rate schedule is superseded, a MID is linked. The
 * figures do not follow until the engine is re-run. Recomputing on every one
 * of those edits would mean a background job in a stack that has no scheduler;
 * doing it on page load would recompute a signed month. So it is an explicit
 * action, and it is safe to offer without a confirmation because the engine is
 * idempotent over a period: it rewrites its own six columns and records the
 * run.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, OutlineChip, StatusPill } from '@/proto/ui/kit';
import type { ResidualPeriod } from '@/lib/records/adminResiduals';
import { Empty, Panel, PanelHead } from './ResidualsTabs';
import { computePeriodAction } from './importActions';

function monthLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A period's state, in the module's own vocabulary.
 *
 * 'open' covers two cases the derivation cannot separate — nothing computed
 * yet, and computed with blocked merchants — so the blocked count is shown
 * beside it rather than folded into the word.
 */
function DerivedStatus({ period }: { period: ResidualPeriod }) {
  const s = period.derivedStatus;

  if (s === null) {
    return <OutlineChip>Unknown</OutlineChip>;
  }
  if (s === 'reconciled') return <StatusPill label="Reconciled" swatch="teal" dot={false} />;
  if (s === 'ready') return <StatusPill label="Ready" swatch="blue" dot={false} />;
  if (s === 'mismatch') return <StatusPill label="Mismatch" swatch="amber" dot={false} />;
  if (s === 'awaiting_volumes') return <OutlineChip>Awaiting volumes</OutlineChip>;
  return <OutlineChip>Open</OutlineChip>;
}

export function PeriodsSection({
  periods,
  processors,
}: {
  periods: ResidualPeriod[];
  processors: string[];
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const processor = processors[0] ?? 'MAVERICK';

  const recompute = (periodId: string) => {
    setError(null);
    setNotice(null);
    setRunningId(periodId);
    startTransition(async () => {
      const r = await computePeriodAction(periodId, processor);
      setRunningId(null);
      if (r.ok) setNotice(r.message);
      else setError(r.message);
    });
  };

  if (periods.length === 0) {
    return (
      <Panel>
        <Empty
          title="No statement periods yet"
          body="A period appears when a processor fee report is imported — use the Import tab. Until then there is nothing to calculate; the rules and rates in the other tabs are in place and waiting for one."
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

      {notice ? (
        <p
          role="status"
          className="flex items-start gap-1.5 border-b border-line-faint bg-ok-bg px-4 py-2 text-[12.5px] leading-relaxed text-ink-800"
        >
          <Icon name="check" size={13} strokeWidth={2.5} className="mt-[2px] shrink-0 text-ok" />
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 border-b border-line-faint px-4 py-2 text-[12.5px] leading-relaxed text-danger"
        >
          <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
          {error}
        </p>
      ) : null}

      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-line-soft text-[11.5px] uppercase tracking-wide text-ink-400">
            <th className="px-4 py-2 font-semibold">Month</th>
            <th className="px-4 py-2 font-semibold">Status</th>
            <th className="px-4 py-2 font-semibold tabular">Lines</th>
            <th className="px-4 py-2 font-semibold tabular">Merchants</th>
            <th className="px-4 py-2 font-semibold">Calculated</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.id}>
              <td className="border-b border-line-faint px-4 py-2.5 text-[13.5px] font-medium text-ink-900">
                {monthLabel(p.statementMonth)}
              </td>
              <td className="border-b border-line-faint px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <DerivedStatus period={p} />
                  {p.merchantsBlocked > 0 ? (
                    <span className="text-[11.5px] text-[#8a5a09]">
                      {p.merchantsBlocked} blocked
                    </span>
                  ) : null}
                  {/* Shown only when the two disagree: sign-off reads the
                      stored column, so a difference is worth seeing. */}
                  {p.derivedStatus !== null && p.derivedStatus !== p.status ? (
                    <span className="text-[11px] text-ink-400">stored: {p.status}</span>
                  ) : null}
                </div>
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
              <td className="border-b border-line-faint px-4 py-2.5 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="rotate-ccw"
                  disabled={pending}
                  loading={runningId === p.id}
                  loadingLabel="Calculating…"
                  onClick={() => recompute(p.id)}
                >
                  Re-calculate
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="border-t border-line-faint px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-400">
        &ldquo;Not calculated&rdquo; covers a month never computed and one whose inputs have
        changed since — the module does not distinguish them, because neither can be trusted until
        the engine is re-run. A month only carries a version when every merchant in it computed.
      </p>
    </Panel>
  );
}
