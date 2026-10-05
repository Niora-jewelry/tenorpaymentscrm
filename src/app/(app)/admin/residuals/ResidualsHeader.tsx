'use client';

/**
 * Where residuals stand, before you pick a tab.
 *
 * ── WHY A HEADER AND NOT JUST THE TABS ───────────────────────────────────
 * The screen used to open on a title and six tabs, so the first question an
 * admin has — "is this month done, and if not what is stopping it" — took two
 * clicks and a read of a table to answer. Everything needed to answer it is
 * already loaded for the tabs; it just was not being said.
 *
 * ── IT STATES ONE MONTH, NOT A ROLL-UP ───────────────────────────────────
 * The most recent period, because that is the one being worked on. A total
 * across every month would be a different and less useful number, and the
 * lifetime figure already has a home on each merchant's own record.
 *
 * ── THE FIGURE IS WITHHELD ON THE SAME RULE AS EVERYWHERE ELSE ───────────
 * `disclosable` tracks the period's calculation version, which is stamped only
 * when the engine skipped nothing. So this shows a number or it shows why
 * there isn't one — never a partial sum, which reads as a real figure and is
 * not one.
 */
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { OutlineChip, StatusPill } from '@/proto/ui/kit';
import type { ResidualPeriod } from '@/lib/records/adminResiduals';

function monthLabel(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function StatePill({ status }: { status: string | null }) {
  if (status === null) return <OutlineChip>Unknown</OutlineChip>;
  if (status === 'reconciled') return <StatusPill label="Signed off" swatch="teal" dot={false} />;
  if (status === 'ready') return <StatusPill label="Agrees" swatch="blue" dot={false} />;
  if (status === 'mismatch') return <StatusPill label="Needs review" swatch="amber" dot={false} />;
  if (status === 'awaiting_volumes') return <OutlineChip>Awaiting volumes</OutlineChip>;
  return <OutlineChip>Open</OutlineChip>;
}

/** One figure with its label. Deliberately plain — this is a status bar. */
function Fact({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'warn';
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-[.04em] text-ink-400">{label}</p>
      <p
        className={`mt-0.5 text-[15px] font-semibold leading-tight ${
          tone === 'warn' ? 'text-[#8a5a09]' : 'text-ink-900'
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] leading-snug text-ink-400">{hint}</p> : null}
    </div>
  );
}

export function ResidualsHeader({
  periods,
  netIncome,
  disclosable,
  ratedMids,
  unattached,
}: {
  periods: ResidualPeriod[];
  /** For the most recent period only. Null when it cannot be disclosed. */
  netIncome: string | null;
  disclosable: boolean;
  ratedMids: number;
  unattached: number;
}) {
  /* `listPeriods` already orders newest first. */
  const latest = periods[0] ?? null;

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Residuals admin</h1>
          <p className="mt-0.5 text-[13px] text-ink-500">
            What the processor paid, against what TapDash should have earned.
          </p>
        </div>
      </div>

      {latest === null ? (
        /*
          Nothing imported. The most useful thing a status bar can do here is
          name the next action rather than show six zeroes, which read as a
          broken screen rather than an empty one.
        */
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-4 py-3">
          <Icon name="info" size={15} className="text-ink-400" />
          <p className="text-[13px] text-ink-700">
            No statement has been imported yet.
            <span className="ml-1 text-ink-500">
              The rules, buy rates and split percentages are loaded and waiting for one —
              start in <strong className="font-semibold text-ink-700">Import</strong>.
            </span>
          </p>
        </div>
      ) : (
        <div className="mt-3 overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4 px-4 py-3.5">
            <Fact
              label="Latest month"
              value={
                <Link
                  href={`/admin/residuals/${latest.id}`}
                  className="underline decoration-ink-300 decoration-1 underline-offset-2 transition-colors hover:text-brand-700 hover:decoration-brand-700"
                >
                  {monthLabel(latest.statementMonth)}
                </Link>
              }
              hint={`${latest.lineCount} line${latest.lineCount === 1 ? '' : 's'} · ${latest.mids} merchant${latest.mids === 1 ? '' : 's'}`}
            />

            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[.04em] text-ink-400">State</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <StatePill status={latest.derivedStatus} />
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-ink-400">
                {latest.calculationVersion === null
                  ? 'Not calculated'
                  : `Version ${latest.calculationVersion}`}
              </p>
            </div>

            {/*
              A figure, or the reason there isn't one. Never both, and never a
              partial sum — a number missing one side of the ledger is not a
              smaller number, it is a different one.
            */}
            {disclosable && netIncome !== null ? (
              <Fact
                label="Net income"
                value={<span className="tabular">{netIncome}</span>}
                hint="After the processor's split, plus anything billed directly"
              />
            ) : (
              <Fact
                label="Net income"
                value={<span className="text-ink-400">Not available</span>}
                hint="Withheld until every merchant in the month has computed"
              />
            )}

            {latest.merchantsBlocked > 0 ? (
              <Fact
                label="Blocked"
                value={`${latest.merchantsBlocked} merchant${latest.merchantsBlocked === 1 ? '' : 's'}`}
                hint="The engine could not price them — a rate is missing"
                tone="warn"
              />
            ) : (
              <Fact
                label="Merchants rated"
                value={ratedMids}
                hint="Have rates on file the engine can price with"
              />
            )}

            {unattached > 0 ? (
              <Fact
                label="Not attached"
                value={`${unattached} MID${unattached === 1 ? '' : 's'}`}
                hint="Navigation only — never affects a calculation"
              />
            ) : null}
          </div>

          {/*
            The one action worth offering from the header. Signing off lives on
            the month's own screen, where the evidence is.
          */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-faint bg-canvas px-4 py-2">
            <p className="text-[11.5px] leading-relaxed text-ink-500">
              {latest.signable
                ? 'Every merchant in this month agrees. It can be signed off.'
                : latest.merchantsBlocked > 0
                  ? 'Enter the missing rates, then re-calculate the month.'
                  : 'Open the month to work through what still disagrees.'}
            </p>
            <Link
              href={`/admin/residuals/${latest.id}`}
              className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-700 transition-colors hover:text-brand-800"
            >
              Reconcile {monthLabel(latest.statementMonth)}
              <Icon name="arrow-right" size={12} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
