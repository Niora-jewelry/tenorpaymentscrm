'use client';

/**
 * The residuals screens, behind one tab strip.
 *
 * Same shape as Presets: a strip of sections, each with a count and a line
 * saying what it is for. An admin opening this has one of five questions —
 * how do I load a statement, what have we loaded, what will it calculate
 * with, what does the processor charge us, and which merchants are not
 * matched up — and the strip is those five in that order.
 *
 * Import leads, and not because it is the newest. Until a fee report exists
 * every other tab is describing what the module WOULD do, and a screen whose
 * first tab shows four zeroes reads as broken rather than as empty. The first
 * thing offered is therefore the thing that makes the rest mean something.
 */
import { useState } from 'react';
import { Icon, type IconName } from '@/proto/ui/icons';
import type { ImportHistoryRow } from '@/lib/records/residualImport';
import type {
  ResidualPeriod,
  ReferenceSummary,
  BuyRateRow,
  LinkWorklistRow,
} from '@/lib/records/adminResiduals';
import { ImportHistory } from './ImportHistory';
import { ImportSection } from './ImportSection';
import { RateImportSection } from './RateImportSection';
import { StatementImportSection } from './StatementImportSection';
import { PeriodsSection } from './PeriodsSection';
import { ReferenceSection } from './ReferenceSection';
import { BuyRatesSection } from './BuyRatesSection';
import { LinksSection } from './LinksSection';

type Section = {
  key: string;
  label: string;
  icon: IconName;
  /** Omitted where a number would mean nothing — Import is an action, not a
   *  collection, and a pill reading "1" beside it is noise. */
  count?: number;
  description: string;
  content: React.ReactNode;
};

export function ResidualsTabs({
  periods,
  reference,
  rates,
  worklist,
  processors,
  imports,
}: {
  periods: ResidualPeriod[];
  reference: ReferenceSummary;
  rates: BuyRateRow[];
  worklist: LinkWorklistRow[];
  processors: string[];
  imports: ImportHistoryRow[];
}) {
  const sections: Section[] = [
    {
      key: 'import',
      label: 'Import',
      icon: 'upload',
      description:
        'Load a processor’s fee report. The columns are confirmed before anything is written, and the engine runs over the month as soon as the lines land.',
      content: (
        <div className="space-y-4">
          <ImportSection processors={processors} />
          <ImportHistory imports={imports} />
        </div>
      ),
    },
    {
      key: 'statements',
      label: 'Statements',
      icon: 'paperclip',
      description:
        'The processor’s monthly statement, one PDF per merchant. This is the only source of volume, and three fee items are charged on volume rather than on a count — without it those lines cannot be worked out at all.',
      content: <StatementImportSection processors={processors} />,
    },
    {
      key: 'rates',
      label: 'Merchant rates',
      icon: 'percent',
      count: reference.ratedMids,
      description:
        'What each merchant pays TapDash. Import the rates sheet for all of them at once, or enter one by hand from the reconciliation screen. The engine cannot price a merchant without these.',
      content: <RateImportSection />,
    },
    {
      key: 'periods',
      label: 'Periods',
      icon: 'calendar',
      count: periods.length,
      description:
        'One per statement month. A period holds the processor’s fee lines; computing it works out what TapDash earned and compares that against what the processor says.',
      content: <PeriodsSection periods={periods} processors={processors} />,
    },
    {
      key: 'reference',
      label: 'Calculation',
      icon: 'sliders',
      count: reference.rules,
      description:
        'What the engine reads when a period is computed: the rules, the split percentages, and which merchants have rates on file.',
      content: <ReferenceSection reference={reference} />,
    },
    {
      key: 'buy-rates',
      label: 'Buy rates',
      icon: 'database',
      count: rates.length,
      description:
        'What the processor charges TapDash, per fee item and risk tier. The sell side — what the merchant pays — lives on each merchant’s Pricing tab.',
      content: <BuyRatesSection rates={rates} processors={processors} />,
    },
    {
      key: 'links',
      label: 'Links',
      icon: 'link',
      count: worklist.length,
      description:
        'Statement MIDs that are not yet attached to a merchant record — including the ones that match perfectly and just need confirming. Linking is for navigation only; it never affects what is calculated.',
      content: <LinksSection worklist={worklist} />,
    },
  ];

  const [active, setActive] = useState(sections[0].key);
  const current = sections.find((s) => s.key === active) ?? sections[0];

  return (
    <div>
      {/*
        ── A REAL TAB LIST, NOT A ROW OF BUTTONS ─────────────────────────
        `role="tablist"` with arrow-key movement, because six sections
        navigated only by clicking is the kind of thing that passes review and
        fails the first person using a keyboard. Left/Right move, Home/End
        jump, and only the active tab is in the page's tab order — which is
        what makes Tab leave the strip and land in the panel rather than
        walking through six buttons first.
      */}
      <div
        role="tablist"
        aria-label="Residuals sections"
        className="flex flex-wrap items-center gap-0.5 border-b border-line"
        onKeyDown={(e) => {
          const i = sections.findIndex((s) => s.key === active);
          const to =
            e.key === 'ArrowRight' ? (i + 1) % sections.length
            : e.key === 'ArrowLeft' ? (i - 1 + sections.length) % sections.length
            : e.key === 'Home' ? 0
            : e.key === 'End' ? sections.length - 1
            : -1;
          if (to < 0) return;
          e.preventDefault();
          setActive(sections[to].key);
          /* Move focus with the selection, or the ring is left behind on a
             tab that is no longer the one being shown. */
          document.getElementById(`residuals-tab-${sections[to].key}`)?.focus();
        }}
      >
        {sections.map((s) => {
          const on = s.key === active;
          return (
            <button
              key={s.key}
              id={`residuals-tab-${s.key}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls="residuals-panel"
              tabIndex={on ? 0 : -1}
              onClick={() => setActive(s.key)}
              className={`-mb-px flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/40 ${
                on
                  ? 'border-brand-600 bg-brand-50/50 text-brand-700'
                  : 'border-transparent text-ink-500 hover:bg-canvas hover:text-ink-900'
              }`}
            >
              <Icon name={s.icon} size={13} />
              {s.label}
              {s.count === undefined ? null : (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] tabular ${
                    on ? 'bg-brand-600/12 text-brand-700' : 'bg-canvas text-ink-400'
                  }`}
                >
                  {s.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/*
        The description belongs to the panel, so it sits inside it rather than
        floating between the strip and the content — where it read as page
        furniture and got skipped.
      */}
      <div
        id="residuals-panel"
        role="tabpanel"
        aria-labelledby={`residuals-tab-${current.key}`}
        className="mt-4"
      >
        <p className="mb-3 flex max-w-[82ch] items-start gap-2 text-[12.5px] leading-relaxed text-ink-500">
          <Icon name="info" size={13} className="mt-[3px] shrink-0 text-ink-300" />
          <span>{current.description}</span>
        </p>
        {current.content}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Shared bits, kept here so the four sections cannot drift apart visually.
 * ──────────────────────────────────────────────────────────────────────── */

export function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      {children}
    </div>
  );
}

export function PanelHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
      {children}
    </div>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex items-start gap-3 px-4 py-5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-canvas text-ink-400">
        <Icon name="info" size={15} />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-ink-700">{title}</p>
        <p className="mt-0.5 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-400">{body}</p>
      </div>
    </div>
  );
}

/*
 * `PeriodStatus` used to live here. It read the STORED status column, which
 * since R6a is only ever 'open' or 'reconciled' — so it rendered 'ready' for a
 * value the CHECK constraint forbids, and rendered a month with four blocked
 * merchants identically to a clean one. The live version derives the state at
 * merchant grain and lives in `PeriodsSection`, which is the only place that
 * needs it.
 */
