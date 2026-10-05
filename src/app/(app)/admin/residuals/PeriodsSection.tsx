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
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { Button, OutlineChip, StatusPill } from '@/proto/ui/kit';
import type { ResidualPeriod } from '@/lib/records/adminResiduals';
import { Empty, Panel, PanelHead } from './ResidualsTabs';
import { computePeriodAction, coverageBeforeComputeAction, type CoverageCheck } from './importActions';

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
  /**
   * The coverage answer for one period, held until the operator decides.
   *
   * The handoff's Step 4: "Check coverage first rather than discovering a raise
   * mid-run." The engine is honest about what it skips, so running blind is
   * safe — it is just uninformative beforehand, and on a month that takes a
   * while the difference between a question and a wait is the whole point.
   */
  const [ask, setAsk] = useState<{ periodId: string; coverage: CoverageCheck } | null>(null);
  const [pending, startTransition] = useTransition();

  const processor = processors[0] ?? 'MAVERICK';

  const compute = (periodId: string) => {
    setAsk(null);
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

  /* Ask first; compute straight away when there is nothing to warn about. */
  const recompute = (periodId: string) => {
    setAsk(null);
    setError(null);
    setNotice(null);
    setRunningId(periodId);
    startTransition(async () => {
      const c = await coverageBeforeComputeAction(periodId);
      setRunningId(null);

      if (!c.ok) {
        /* A failed check must not block the compute — it is a courtesy, and
           the engine records whatever it skips either way. */
        compute(periodId);
        return;
      }
      if (c.coverage.withoutRates === 0 && c.coverage.withoutTier === 0) {
        compute(periodId);
        return;
      }
      setAsk({ periodId, coverage: c.coverage });
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

      {ask ? (
        <div className="border-b border-line-faint bg-[#fdf1d8] px-4 py-3 text-[#8a5a09]">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Icon name="alert-triangle" size={14} strokeWidth={2} />
            {ask.coverage.withoutRates > 0
              ? `${ask.coverage.withoutRates} of ${ask.coverage.inStatements} merchants in this month have no rates on file`
              : `${ask.coverage.withoutTier} merchant${ask.coverage.withoutTier === 1 ? '' : 's'} have rates but no risk level`}
          </p>
          <p className="mt-1 max-w-[86ch] text-[12.5px] leading-relaxed">
            {ask.coverage.withoutRates > 0 ? (
              <>
                The engine will skip {ask.coverage.withoutRates === 1 ? 'it' : 'them'} and record
                why, so nothing is lost &mdash; but the month will not carry a figure until every
                merchant in it does.
                {ask.coverage.examples.length > 0 ? (
                  <>
                    {' '}
                    Starting with{' '}
                    <span className="tabular">{ask.coverage.examples.join(', ')}</span>
                    {ask.coverage.withoutRates > ask.coverage.examples.length
                      ? ` and ${ask.coverage.withoutRates - ask.coverage.examples.length} more`
                      : ''}
                    .
                  </>
                ) : null}
              </>
            ) : (
              <>
                Without a risk level the split percentage is unknown, so those merchants cannot be
                costed. Set it on the Pricing tab or in the rate editor.
              </>
            )}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => compute(ask.periodId)}>
              Calculate anyway
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAsk(null)}>
              Not now
            </Button>
            <span className="text-[11.5px]">
              Importing the rates sheet fixes this for every merchant at once.
            </span>
          </div>
        </div>
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
              <td className="border-b border-line-faint px-4 py-2.5">
                {/* The month is the link, because the month IS the thing
                    being reconciled — a separate "open" action beside it
                    would be a second way to say one thing. */}
                <Link
                  href={`/admin/residuals/${p.id}`}
                  className="inline-flex items-center gap-1 text-[13.5px] font-medium text-ink-900 underline decoration-ink-300 decoration-1 underline-offset-2 transition-colors hover:text-brand-700 hover:decoration-brand-700"
                >
                  {monthLabel(p.statementMonth)}
                  <Icon name="arrow-right" size={12} />
                </Link>
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
        Open a month to reconcile it line by line. &ldquo;Not calculated&rdquo; covers a month
        never computed and one whose inputs have
        changed since — the module does not distinguish them, because neither can be trusted until
        the engine is re-run. A month only carries a version when every merchant in it computed.
      </p>
    </Panel>
  );
}
