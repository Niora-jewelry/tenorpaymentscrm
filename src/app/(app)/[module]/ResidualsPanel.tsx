'use client';

/**
 * What this merchant earned, on the merchant's own record.
 *
 * ── FIVE STATES, AND THEY ARE NOT THE SAME STATE ─────────────────────────
 * The whole value of this panel is that it tells these apart:
 *
 *   admin only      the viewer may not see figures
 *   no MID          the record has no merchant number, so nothing can key to it
 *   no statements   a MID, but nothing imported that mentions it
 *   not calculated  statements imported, the engine has not produced a total
 *   figures         a total, and it is complete
 *
 * Every one of them renders as "no number" if you are careless, and four of
 * the five are then indistinguishable from the merchant having earned nothing.
 * That is the failure this panel exists to avoid, which is why each gets its
 * own sentence rather than an empty state.
 *
 * ── NO TOTAL UNTIL THE TOTAL IS COMPLETE ─────────────────────────────────
 * `residual_synopsis` returns `net_income` as NULL unless the month carries a
 * calculation version, and nothing here invents one. Daniel's argument:
 * a figure labelled partial is read as two true things, a loss and some
 * missing rows, and the first of those is false.
 *
 * ── NOTHING HERE ADDS ANYTHING UP ────────────────────────────────────────
 * The months are printed as they arrive and the lifetime figure comes from SQL
 * with `p_lifetime => true`. Summing the months in JavaScript would be the
 * client computing money, and it would also silently total only the
 * disclosable ones — which is the same missing-one-side-of-the-ledger problem
 * one level up.
 */
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { OutlineChip, StatusPill } from '@/proto/ui/kit';
import type { RecordResidualPeriod, RecordResiduals } from '@/lib/records/recordResiduals';

function monthLabel(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** A sentence and nothing else, for the four cases that have no figures. */
function Says({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-canvas text-ink-400">
        <Icon name="info" size={15} />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-ink-700">{title}</p>
        <p className="mt-0.5 max-w-[74ch] text-[12.5px] leading-relaxed text-ink-400">{body}</p>
      </div>
    </div>
  );
}

function StatePill({ state }: { state: string | null }) {
  if (state === null) return <OutlineChip>Not calculated</OutlineChip>;
  if (state === 'reconciled') return <StatusPill label="Signed off" swatch="teal" dot={false} />;
  if (state === 'ready') return <StatusPill label="Agrees" swatch="blue" dot={false} />;
  if (state === 'mismatch') return <StatusPill label="Disagrees" swatch="amber" dot={false} />;
  if (state === 'blocked') return <OutlineChip tone="brand">Blocked</OutlineChip>;
  if (state === 'awaiting_volumes') return <OutlineChip>Awaiting volumes</OutlineChip>;
  return <OutlineChip>{state}</OutlineChip>;
}

/**
 * Why a month has no figure, in the merchant's terms rather than the engine's.
 *
 * -- ONE MERCHANT'S FIGURE DEPENDS ON THE WHOLE MONTH --------------------
 * `residual_synopsis`'s `disclosable` is `bool_or(calculation_version is not
 * null)` over the PERIOD, not a per-merchant test. And the engine stamps that
 * version only when it skipped NOTHING. So a merchant whose own lines priced
 * perfectly still shows no figure while any OTHER merchant in the month is
 * blocked.
 *
 * That is deliberate: the version is the standing claim that the month's
 * outputs are current and complete, and one skipped merchant means the
 * month's money is missing a piece. But it makes the obvious explanation
 * wrong, and wrong in the way that wastes an afternoon. This function used to
 * end on "N of M lines have been priced", which on such a merchant reads
 * "1 of 1 lines priced" beside a blank total, and sends the reader hunting
 * for a fault in a merchant that has none.
 *
 * So the two cases are split by exactly the fact that distinguishes them:
 * whether THIS merchant's own lines are all priced.
 */
function whyNoFigure(p: RecordResidualPeriod): string {
  if (p.state === 'blocked') {
    return 'The engine could not price this month for this merchant — a rate it needs is not on file.';
  }
  if (p.state === 'awaiting_volumes') {
    return p.awaitingReason === null
      ? 'The fees charged on volume are waiting on figures from the processor’s statement.'
      : `${p.awaitingReason.charAt(0).toUpperCase()}${p.awaitingReason.slice(1)}.`;
  }
  if (p.rowsTotal > 0 && p.rowsComputed === p.rowsTotal) {
    return 'This merchant’s own lines are all priced. The month as a whole is not finished — another merchant in it was skipped — and a month only carries a figure once every merchant in it has one.';
  }
  return `${p.rowsComputed} of ${p.rowsTotal} lines have been priced. A total is withheld until every one of them has.`;
}

export function ResidualsPanel({ data }: { data: RecordResiduals }) {
  if (data.kind === 'admin_only') {
    return (
      <Says
        title="Residual figures are admin-only"
        body="What a merchant earned is held behind the same gate as the calculation itself. This is not an empty tab — there may well be figures here, and an administrator can see them."
      />
    );
  }

  if (data.kind === 'no_mid') {
    return (
      <Says
        title="This merchant has no MID"
        body="Residuals are keyed on the merchant number the processor uses. Add it to the MID field on the Pricing tab and any statement lines already imported for it will attach themselves."
      />
    );
  }

  if (data.kind === 'no_statements') {
    return (
      <Says
        title="No statements mention this MID"
        body={`Nothing imported so far carries ${data.mid}. Either no fee report covering this merchant has been imported yet, or the MID on this record differs from the one the processor uses.`}
      />
    );
  }

  const { periods } = data;

  return (
    <div className="space-y-4">
      {/* ── lifetime ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-line-soft px-4 py-3">
        <div>
          <p className="text-[11.5px] uppercase tracking-wide text-ink-400">
            Net income, all months
          </p>
          {data.lifetimeDisclosable && data.lifetimeNetIncome !== null ? (
            <p className="text-[24px] font-semibold tabular leading-tight text-ink-900">
              {data.lifetimeNetIncome}
            </p>
          ) : (
            <>
              <p className="text-[18px] font-semibold leading-tight text-ink-400">Not available</p>
              {/*
                The denominators, because they are what makes the absence
                explicable. "3 of 7 months priced" is a fact an operator can
                act on; a blank is not.
              */}
              <p className="mt-0.5 max-w-[60ch] text-[11.5px] leading-snug text-ink-400">
                {data.periodsComputed} of {data.periodsTotal} month
                {data.periodsTotal === 1 ? '' : 's'} have been priced completely &mdash; and a
                month counts only when EVERY merchant in it priced, not just this one. A lifetime
                total across some of them would be a different number, not a smaller one.
              </p>
            </>
          )}
        </div>
        <span className="text-[12px] tabular text-ink-400">MID {data.mid}</span>
      </div>

      {/* ── month by month ───────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-xl border border-line-soft">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-line-soft text-[11px] uppercase tracking-wide text-ink-400">
              <th className="px-3.5 py-1.5 font-semibold">Month</th>
              <th className="px-3.5 py-1.5 font-semibold">State</th>
              <th className="px-3.5 py-1.5 text-right font-semibold">Lines</th>
              <th className="px-3.5 py-1.5 text-right font-semibold">Net income</th>
              <th className="px-3.5 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.periodId}>
                <td className="border-b border-line-faint px-3.5 py-2 text-[13px] font-medium text-ink-900">
                  {monthLabel(p.statementMonth)}
                </td>
                <td className="border-b border-line-faint px-3.5 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatePill state={p.state} />
                    {p.mismatchCount > 0 ? (
                      <span className="text-[11px] text-[#8a5a09]">
                        {p.mismatchCount} to review
                      </span>
                    ) : null}
                    {p.suppressedCount > 0 ? (
                      <span className="text-[11px] text-ink-400">
                        {p.suppressedCount} accepted
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="border-b border-line-faint px-3.5 py-2 text-right text-[12.5px] tabular text-ink-500">
                  {p.rowsComputed === p.rowsTotal
                    ? p.rowsTotal
                    : `${p.rowsComputed} of ${p.rowsTotal}`}
                </td>
                <td className="border-b border-line-faint px-3.5 py-2 text-right text-[13px] tabular font-medium text-ink-900">
                  {p.disclosable && p.netIncome !== null ? (
                    p.netIncome
                  ) : (
                    <span className="text-ink-300">—</span>
                  )}
                </td>
                <td className="border-b border-line-faint px-3.5 py-2 text-right">
                  {/*
                    Into the admin surface for that month, which is where the
                    work of fixing it happens. The link is the whole "navigated
                    from the CRM and vice versa" half of the link kernel.
                  */}
                  <Link
                    href={`/admin/residuals/${p.periodId}`}
                    className="inline-flex items-center gap-1 text-[12px] text-brand-700 underline decoration-brand-700/30 transition-colors hover:decoration-brand-700"
                  >
                    Reconcile
                    <Icon name="arrow-right" size={11} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── why a month has no figure ────────────────────────────────── */}
      {periods.some((p) => !p.disclosable) ? (
        <div className="rounded-xl border border-line-soft px-4 py-3">
          <p className="text-[12.5px] font-semibold text-ink-700">Months without a figure</p>
          <ul className="mt-1.5 space-y-1.5">
            {periods
              .filter((p) => !p.disclosable)
              .map((p) => (
                <li key={p.periodId} className="flex items-start gap-2 text-[12px] leading-relaxed">
                  <span className="shrink-0 font-medium text-ink-700">
                    {monthLabel(p.statementMonth)}
                  </span>
                  <span className="text-ink-400">{whyNoFigure(p)}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <p className="max-w-[80ch] text-[11.5px] leading-relaxed text-ink-400">
        These figures are what TapDash earned after the processor&rsquo;s split, plus anything
        TapDash billed the merchant directly. They are computed from the statement and the
        merchant&rsquo;s own rates &mdash; not read off the statement &mdash; which is what makes
        the comparison on the reconciliation screen possible.
      </p>
    </div>
  );
}
