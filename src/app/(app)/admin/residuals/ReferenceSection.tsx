'use client';

/**
 * What the engine will calculate with.
 *
 * ── WHY THIS SCREEN EXISTS AT ALL ────────────────────────────────────────
 * Before a statement is imported there is no figure to show. The useful thing
 * an admin can be told instead is what the module is READY to do: the rules
 * are loaded, the split percentages are these, this many merchants have rates
 * on file. That is a real answer to "is this thing set up", and it is
 * checkable before a single statement arrives.
 *
 * The "what is still missing" panel is the other half, and it is the more
 * important one. A residuals screen that shows nothing and explains nothing
 * invites the reader to assume it is broken.
 *
 * ── THAT PANEL IS COUNTED, NOT WRITTEN ───────────────────────────────────
 * It used to be four hardcoded sentences, every one of them a statement about
 * the state of the data: "nothing has been imported yet", "it is blank for all
 * of them". Each was true the day it was written. Each becomes a lie the
 * moment the thing it describes is done — and a panel insisting nothing has
 * been imported, displayed above a month of imported figures, is worse than no
 * panel at all, because it teaches the reader to ignore the whole box.
 *
 * So every item is derived from a count taken now, and an item with nothing
 * outstanding is not rendered. When the list is empty the box says so. The one
 * exception is the PCI question, which is an unresolved decision rather than
 * missing data and is marked as such.
 */
import { Icon } from '@/proto/ui/icons';
import { OutlineChip } from '@/proto/ui/kit';
import type { ReferenceSummary } from '@/lib/records/adminResiduals';
import { Panel, PanelHead } from './ResidualsTabs';

function Stat({ n, label, hint }: { n: number; label: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line-soft px-3.5 py-3">
      <p className="text-[20px] font-semibold tabular leading-none text-ink-900">{n}</p>
      <p className="mt-1.5 text-[12.5px] font-medium text-ink-700">{label}</p>
      {hint ? <p className="mt-0.5 text-[11.5px] leading-snug text-ink-400">{hint}</p> : null}
    </div>
  );
}

export function ReferenceSection({ reference }: { reference: ReferenceSummary }) {
  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead>
          <h2 className="text-[14px] font-semibold text-ink-900">Loaded and ready</h2>
        </PanelHead>
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          <Stat n={reference.rules} label="Calculation rules" hint="One per fee item on the statement" />
          <Stat n={reference.terms} label="Formula terms" hint="The income and buy-rate sides of each rule" />
          <Stat n={reference.feeItems} label="Fee items" hint="Matched on the exact name the processor uses" />
          <Stat n={reference.buyRates} label="Buy rates" hint="What the processor charges TapDash" />
          <Stat n={reference.planCodes} label="Plan codes" hint="Mapped to volume buckets" />
          <Stat
            n={reference.ratedMids}
            label="Merchants with rates"
            hint="From their Pricing tab"
          />
        </div>
      </Panel>

      <Panel>
        <PanelHead>
          <h2 className="text-[14px] font-semibold text-ink-900">TapDash&rsquo;s share</h2>
          <span className="text-[12px] text-ink-400">per risk tier, after the processor&rsquo;s cut</span>
        </PanelHead>
        <div className="flex flex-wrap gap-2 p-4">
          {reference.riskTiers.map((t) => (
            <div key={t.tierKey} className="rounded-lg border border-line-soft px-3 py-2">
              <p className="text-[12.5px] font-medium text-ink-900">{t.label}</p>
              <p className="mt-0.5 text-[15px] font-semibold tabular text-brand-700">
                {t.share === null ? '—' : `${Math.round(Number(t.share) * 100)}%`}
              </p>
            </div>
          ))}
        </div>
        <p className="border-t border-line-faint px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-400">
          A merchant&rsquo;s tier comes from the Risk Level field on their Pricing tab. The share is
          applied per line and rounded to the penny on each one &mdash; not once on the total,
          which gives a different answer.
        </p>
      </Panel>

      <Panel>
        <PanelHead>
          <h2 className="text-[14px] font-semibold text-ink-900">Processors</h2>
        </PanelHead>
        <div className="space-y-1.5 p-4">
          {reference.schedules.map((s) => (
            <div key={`${s.processor}-${s.label}`} className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-ink-900">{s.processor}</span>
              <span className="text-[12.5px] text-ink-500">{s.label}</span>
              {s.isResidualSplit ? (
                <OutlineChip tone="brand">Pays a share of net</OutlineChip>
              ) : (
                <OutlineChip>Flat vendor rate</OutlineChip>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Outstanding o={reference.outstanding} />
    </div>
  );
}

/**
 * What is still missing before a calculated month can be trusted.
 *
 * An operator who does not know these are outstanding will read the first
 * computed month as gospel — which is the whole reason the box is here and the
 * whole reason it must never claim something that has since been done.
 */
function Outstanding({ o }: { o: ReferenceSummary['outstanding'] }) {
  const items: string[] = [];

  if (o.excelImports === 0) {
    items.push(
      'No processor fee report has been imported, so there is nothing to calculate. Use the Import tab.',
    );
  }

  if (o.pdfImports === 0) {
    items.push(
      o.excelImports === 0
        ? 'A PDF statement is needed alongside the fee report. Without one, the first of the three reconciliation checks cannot run.'
        : 'No PDF statement has been imported, so the first of the three reconciliation checks has not run on any month.',
    );
  }

  if (o.statementMids > 0 && o.midsWithoutRates > 0) {
    items.push(
      `${o.midsWithoutRates} of the ${o.statementMids} merchants in the statements have no rates on file. The engine skips those whole and records why — it does not cost them at zero.`,
    );
  }

  if (o.midsWithoutMonthlyFee > 0) {
    items.push(
      `${o.midsWithoutMonthlyFee} merchant${o.midsWithoutMonthlyFee === 1 ? '' : 's'} ${o.midsWithoutMonthlyFee === 1 ? 'has' : 'have'} rates but no monthly TapDash fee, and one rule cannot compute without it.`,
    );
  }

  if (o.excelImports > 0 && o.volumeRows === 0) {
    items.push(
      'No volume figures are on file, so the rules assessed on volume cannot compute for any merchant.',
    );
  }

  /*
   * Not a count — an open decision, and it stays listed until somebody makes
   * it. The template says the merchant pays PCI directly; the processor's own
   * report says TapDash was charged. Both cannot be right, and the engine
   * computes whichever the rules currently say.
   */
  items.push(
    'The PCI question is unsettled: the template says the merchant pays it directly, the processor’s report says TapDash was charged.',
  );

  const onlyTheOpenQuestion = items.length === 1;

  return (
    <div
      className={
        onlyTheOpenQuestion
          ? 'rounded-xl border border-line-soft bg-canvas px-4 py-3.5 text-ink-700'
          : 'rounded-xl border border-[#f7e0af] bg-[#fdf1d8] px-4 py-3.5 text-[#8a5a09]'
      }
    >
      <p className="flex items-center gap-1.5 text-[13.5px] font-semibold">
        <Icon name={onlyTheOpenQuestion ? 'info' : 'alert-triangle'} size={14} strokeWidth={2} />
        {onlyTheOpenQuestion ? 'One question still open' : 'Before a calculated month can be trusted'}
      </p>
      <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed">
        {items.map((line) => (
          <li key={line} className="flex items-start gap-2">
            <span
              aria-hidden
              className={`mt-[7px] size-[4px] shrink-0 rounded-full ${
                onlyTheOpenQuestion ? 'bg-ink-400' : 'bg-[#8a5a09]/50'
              }`}
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
