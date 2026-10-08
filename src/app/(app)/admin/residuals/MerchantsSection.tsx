'use client';

/**
 * The merchant dashboard — tab 1 of the module.
 *
 * `residuals.md` §12 lists four tabs and this is the one that was never
 * started. It answers a single question per merchant: where does this month
 * stand for them, and what is the next thing to do about it.
 *
 * ── IT DOES NOT SUM ANYTHING ─────────────────────────────────────────────
 * Not a stylistic choice. `netIncome` arrives already withheld unless the
 * month carries a calculation version, because a partially-computed month's
 * figure has the wrong SIGN — the costs compute and the volume-driven income
 * does not. Adding up the figures that are present would produce a screen
 * showing every merchant at a loss, and it would be believed. So the money is
 * printed where it exists and the reason is given where it does not, and
 * there is no total row.
 *
 * ── THE ROWS ARE SORTED BY WHAT NEEDS DOING ──────────────────────────────
 * Blocked first, then awaiting volumes, then mismatches, then the settled
 * ones. A dashboard sorted by MID is a list; sorted by state it is a queue.
 *
 * ── EVERY STATE NAMES ITS OWN REMEDY ─────────────────────────────────────
 * `awaitingReason` is a sentence from the database, not a code, and it says
 * which half is missing. Where the remedy is a screen, the row links to it:
 * rates to the rate editor, volumes to the Statements tab, differences to the
 * merchant on the reconciliation grid.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { OutlineChip } from '@/proto/ui/kit';
import { STATE_LABEL, type MerchantDashboardRow } from '@/lib/residuals/reconciliation';
import { Panel, PanelHead } from './ResidualsTabs';

/** Work first. Settled last. */
const STATE_ORDER: Record<string, number> = {
  blocked: 0,
  awaiting_volumes: 1,
  mismatch: 2,
  ready: 3,
  reconciled: 4,
};

/** Tone per rung, matching the reconciliation grid's vocabulary. */
const STATE_TONE: Record<string, { fg: string; bg: string; border: string }> = {
  blocked: { fg: '#b02a30', bg: '#fce9ea', border: '#f7cfd1' },
  awaiting_volumes: { fg: '#8a5a09', bg: '#fdfaf2', border: '#e8d8b8' },
  mismatch: { fg: '#8a5a09', bg: '#fdfaf2', border: '#e8d8b8' },
  ready: { fg: '#1f6f4a', bg: '#f0f8f3', border: '#c9e3d4' },
  reconciled: { fg: '#1f6f4a', bg: '#f0f8f3', border: '#c9e3d4' },
};

/**
 * Groups the integer part and leaves the decimals exactly as SQL produced
 * them. The module's standing rule: money crosses as text, the client
 * formats, it never computes.
 */
function money(text: string | null): string {
  if (text === null || text === '') return '—';
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [whole, frac] = body.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac === undefined ? '' : `.${frac}`}`;
}

type Filter = 'all' | 'work' | 'blocked' | 'awaiting_volumes' | 'mismatch' | 'settled';

export function MerchantsSection({
  rows,
  periodId,
  statementMonth,
}: {
  rows: MerchantDashboardRow[];
  periodId: string | null;
  statementMonth: string | null;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (q !== '') {
          const hay = `${r.mid} ${r.merchantName ?? ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        const s = r.state?.state ?? null;
        switch (filter) {
          case 'all':
            return true;
          case 'work':
            return s === 'blocked' || s === 'awaiting_volumes' || s === 'mismatch' || s === null;
          case 'settled':
            return s === 'ready' || s === 'reconciled';
          default:
            return s === filter;
        }
      })
      .slice()
      .sort((a, b) => {
        const oa = STATE_ORDER[a.state?.state ?? ''] ?? -1;
        const ob = STATE_ORDER[b.state?.state ?? ''] ?? -1;
        return oa - ob || a.mid.localeCompare(b.mid);
      });
  }, [rows, filter, query]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) {
      const s = r.state?.state ?? 'unknown';
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  if (periodId === null) {
    return (
      <Panel>
        <div className="px-4 py-5">
          <p className="text-[13px] font-semibold text-ink-700">No month to show yet</p>
          <p className="mt-0.5 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-400">
            This screen lists every merchant in a statement month and where each one stands. Import
            a processor fee report on the Import tab and the month appears here.
          </p>
        </div>
      </Panel>
    );
  }

  const work =
    (counts.blocked ?? 0) + (counts.awaiting_volumes ?? 0) + (counts.mismatch ?? 0) +
    (counts.unknown ?? 0);

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHead>
          <h2 className="text-[14px] font-semibold text-ink-900">
            {rows.length} merchant{rows.length === 1 ? '' : 's'}
            {statementMonth ? (
              <span className="ml-2 font-normal text-ink-500">{monthLabel(statementMonth)}</span>
            ) : null}
          </h2>
          <Link
            href={`/admin/residuals/${periodId}`}
            className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-700 transition-colors hover:text-brand-800"
          >
            Reconciliation grid
            <Icon name="chevron-right" size={13} />
          </Link>
        </PanelHead>

        <div className="space-y-3 p-4">
          <p className="max-w-[80ch] text-[12.5px] leading-relaxed text-ink-600">
            {work === 0
              ? 'Every merchant in this month is settled. Nothing here needs a decision.'
              : `${work} of ${rows.length} merchant${work === 1 ? '' : 's'} need something before this month can be signed off. They are listed first.`}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Chip label="All" n={rows.length} on={filter === 'all'} onClick={() => setFilter('all')} />
            <Chip label="Needs work" n={work} on={filter === 'work'} onClick={() => setFilter('work')} />
            <Chip
              label="Blocked"
              n={counts.blocked ?? 0}
              on={filter === 'blocked'}
              onClick={() => setFilter('blocked')}
            />
            <Chip
              label="Awaiting volumes"
              n={counts.awaiting_volumes ?? 0}
              on={filter === 'awaiting_volumes'}
              onClick={() => setFilter('awaiting_volumes')}
            />
            <Chip
              label="Differences"
              n={counts.mismatch ?? 0}
              on={filter === 'mismatch'}
              onClick={() => setFilter('mismatch')}
            />
            <Chip
              label="Settled"
              n={(counts.ready ?? 0) + (counts.reconciled ?? 0)}
              on={filter === 'settled'}
              onClick={() => setFilter('settled')}
            />

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a merchant or MID"
              aria-label="Find a merchant or MID"
              className="ml-auto w-full max-w-[18rem] rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] text-ink-900 outline-none focus-field"
            />
          </div>
        </div>
      </Panel>

      {sorted.length === 0 ? (
        <Panel>
          <p className="px-4 py-5 text-[12.5px] text-ink-500">
            No merchant matches that.
          </p>
        </Panel>
      ) : (
        <ul className="space-y-2">
          {sorted.map((r) => (
            <MerchantRow key={r.mid} row={r} periodId={periodId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Chip({
  label,
  n,
  on,
  onClick,
}: {
  label: string;
  n: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
        on
          ? 'border-brand-600/30 bg-brand-50 text-brand-700'
          : 'border-line bg-white text-ink-600 hover:border-ink-400'
      }`}
    >
      {label}
      <span className={`ml-1.5 tabular ${on ? 'text-brand-600' : 'text-ink-400'}`}>{n}</span>
    </button>
  );
}

function MerchantRow({ row, periodId }: { row: MerchantDashboardRow; periodId: string }) {
  const s = row.state?.state ?? null;
  const tone = s ? STATE_TONE[s] : null;

  return (
    <li className="overflow-hidden rounded-xl border border-line-soft bg-white">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
        {/* ── who ─────────────────────────────────────────────────────── */}
        <div className="min-w-[14rem] flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink-900">
              {row.merchantName ?? 'Unnamed merchant'}
            </span>
            <span className="tabular text-[12px] text-ink-500">{row.mid}</span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-400">
            <span>
              {row.lineCount} line{row.lineCount === 1 ? '' : 's'}
            </span>
            {row.rowsTotal > 0 && row.rowsComputed < row.rowsTotal ? (
              <span className="text-[#8a5a09]">
                {row.rowsComputed} of {row.rowsTotal} costed
              </span>
            ) : null}
            {row.recordId ? (
              <Link
                /* `/{module}?record={id}` is how the app opens a drawer, and
                   residuals is the apt module to open it in — Statements lives
                   there. */
                href={`/residuals?record=${row.recordId}`}
                className="text-ink-500 underline decoration-line underline-offset-2 transition-colors hover:text-ink-900"
              >
                Open record
              </Link>
            ) : (
              <span title="Linking a MID to a record is for navigation only; it never affects what is calculated.">
                not linked to a record
              </span>
            )}
          </div>

          {/*
            Two names on one MID is a real signal, not a cosmetic one — the
            August Mastersheet carries 30119900929 twice with different volume
            rates — so it is said on the row rather than resolved silently.
          */}
          {row.nameVariants.length > 1 ? (
            <p className="mt-1 text-[11.5px] leading-relaxed text-[#8a5a09]">
              This MID appears under {row.nameVariants.length} names:{' '}
              {row.nameVariants.join(', ')}. Worth confirming they are the same business.
            </p>
          ) : null}
        </div>

        {/* ── money ───────────────────────────────────────────────────── */}
        <div className="min-w-[9rem] text-right">
          {row.disclosable ? (
            <>
              <p className="tabular text-[15px] font-semibold text-ink-900">
                {money(row.netIncome)}
              </p>
              <p className="text-[11px] text-ink-400">net income</p>
            </>
          ) : (
            <p
              className="max-w-[22ch] text-[11.5px] leading-snug text-ink-400"
              title="A partial month's total has the wrong sign, not merely the wrong magnitude — the costs compute and the volume-driven income does not. So it is withheld rather than shown with a caveat."
            >
              no total until the month computes in full
            </p>
          )}
        </div>

        {/* ── where it stands ─────────────────────────────────────────── */}
        <div className="min-w-[11rem]">
          {s && tone ? (
            <span
              className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11.5px] font-medium"
              style={{ color: tone.fg, backgroundColor: tone.bg, borderColor: tone.border }}
            >
              {STATE_LABEL[s]}
            </span>
          ) : (
            <OutlineChip>No state recorded</OutlineChip>
          )}

          <Remedy row={row} periodId={periodId} />
        </div>
      </div>
    </li>
  );
}

/**
 * What to do next, and where.
 *
 * The sentence comes from the database where there is one — `awaitingReason`
 * names which half is missing, and the spec is explicit that it is a sentence
 * rather than a code so that it can say so.
 */
function Remedy({ row, periodId }: { row: MerchantDashboardRow; periodId: string }) {
  const st = row.state;
  if (!st) {
    return (
      <p className="mt-1 max-w-[30ch] text-[11.5px] leading-snug text-ink-400">
        The engine has not reported on this merchant for this month.
      </p>
    );
  }

  const link = (href: string, label: string) => (
    <Link
      href={href}
      className="mt-1 inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-700 transition-colors hover:text-brand-800"
    >
      {label}
      <Icon name="chevron-right" size={12} />
    </Link>
  );

  if (st.state === 'blocked') {
    return (
      <div>
        <p className="mt-1 max-w-[32ch] text-[11.5px] leading-snug text-ink-600">
          {st.skippedWhole > 0
            ? 'No rates on file for this merchant, so none of its lines can be costed.'
            : `${st.blockedLines} line${st.blockedLines === 1 ? '' : 's'} could not be costed for want of a rate.`}
        </p>
        {/* The per-merchant rate editor is on the merchant's own block on the
            reconciliation grid — there is no separate rates route. Opening it
            focused is the shortest path to the field that is missing. */}
        {link(`/admin/residuals/${periodId}?mid=${row.mid}`, 'Enter rates')}
      </div>
    );
  }

  if (st.state === 'awaiting_volumes') {
    return (
      <div>
        <p className="mt-1 max-w-[32ch] text-[11.5px] leading-snug text-ink-600">
          {st.awaitingReason ?? 'Waiting on the statement volumes for this month.'}
        </p>
        {link(`/admin/residuals/${periodId}?mid=${row.mid}`, 'Open on the grid')}
      </div>
    );
  }

  if (st.state === 'mismatch') {
    const live = st.mismatchCount - st.suppressedCount;
    return (
      <div>
        <p className="mt-1 max-w-[32ch] text-[11.5px] leading-snug text-ink-600">
          {live} difference{live === 1 ? '' : 's'} against the statement
          {st.suppressedCount > 0 ? `, and ${st.suppressedCount} already accepted` : ''}.
        </p>
        {link(`/admin/residuals/${periodId}?mid=${row.mid}`, 'Review the differences')}
      </div>
    );
  }

  return (
    <p className="mt-1 max-w-[32ch] text-[11.5px] leading-snug text-ink-400">
      {st.state === 'reconciled'
        ? 'Every comparison agrees with the statement.'
        : 'Computed, with nothing outstanding.'}
    </p>
  );
}

function monthLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${names[Number(m[2]) - 1]} ${m[1]}`;
}
