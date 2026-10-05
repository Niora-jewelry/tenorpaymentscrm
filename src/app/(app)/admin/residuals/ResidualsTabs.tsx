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
      label: 'Unmatched',
      icon: 'link',
      count: worklist.length,
      description:
        'Statement MIDs that do not resolve to a merchant record. Linking is for navigation only — it never affects what is calculated.',
      content: <LinksSection worklist={worklist} />,
    },
  ];

  const [active, setActive] = useState(sections[0].key);
  const current = sections.find((s) => s.key === active) ?? sections[0];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 border-b border-line">
        {sections.map((s) => {
          const on = s.key === active;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setActive(s.key)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
                on
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-ink-500 hover:text-ink-900'
              }`}
            >
              <Icon name={s.icon} size={13} />
              {s.label}
              {s.count === undefined ? null : (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] tabular ${
                    on ? 'bg-brand-50 text-brand-700' : 'bg-canvas text-ink-400'
                  }`}
                >
                  {s.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-3 max-w-[78ch] text-[12.5px] leading-relaxed text-ink-500">
        {current.description}
      </p>

      <div className="mt-4">{current.content}</div>
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
