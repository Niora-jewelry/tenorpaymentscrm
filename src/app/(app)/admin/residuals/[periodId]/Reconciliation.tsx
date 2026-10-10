'use client';

/**
 * One month's reconciliation.
 *
 * ── NOTHING ON THIS SCREEN DOES ARITHMETIC ───────────────────────────────
 * Every money value arrives from SQL as a string and is printed as one. There
 * is no `Number()` below, no sum, and no total row the client computes — the
 * only total is the one `residual_synopsis` returns, and it withholds itself
 * until the month is complete.
 *
 * The one place a number IS parsed is `Number(delta) < 0` to pick a colour,
 * which decides nothing and is stated where it happens.
 *
 * ── THE GRID IS GROUPED BY MERCHANT, NOT FLAT ────────────────────────────
 * A flat list of 200 fee lines does not answer the question the page is for.
 * The unit of work is a merchant: its state is a single verdict on whether it
 * reconciles, and its lines are the evidence. So merchants are collapsed by
 * default and the ones needing attention are open.
 *
 * ── AN ABSENT VERDICT AND A PASSING ONE LOOK DIFFERENT ───────────────────
 * `verdicts` is keyed by step, and a missing key means the comparison could
 * not be made — an uncomputed line, an unmapped fee item, a merchant with no
 * volume row. Rendering that as a blank cell would read as an oversight, so it
 * renders as a dash with a reason on hover, and 'exempt' renders as its own
 * thing because the rule shape says the comparison does not apply.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, OutlineChip, StatusPill } from '@/proto/ui/kit';
/*
 * From `lib/residuals/reconciliation.ts`, NOT from `lib/records/residualGrid.ts`.
 * The labels are runtime values, and importing one from the server module
 * pulls its `server-only` and `next/headers` dependencies into this bundle —
 * which is a build error, not a preference. See that file's header.
 */
import {
  HISTORY_KIND_LABEL,
  STATE_LABEL,
  STEP_LABEL,
  formatMoneyText,
  type GridRow,
  type HistoryEntry,
  type MerchantState,
  type PeriodHeader,
  type Synopsis,
  type Verdict,
} from '@/lib/residuals/reconciliation';
import type { RateEditorData } from '@/lib/residuals/rates';
import type { VolumeRow } from '@/lib/residuals/volumes';
import {
  acknowledgeVerdictAction,
  reopenPeriodAction,
  signOffPeriodAction,
  withdrawAcknowledgmentAction,
} from './actions';
import { loadRateEditorAction } from './rateActions';
import { RateEditor } from './RateEditor';
import { loadVolumesAction } from './volumeActions';
import { VolumeEditor } from './VolumeEditor';

function monthLabel(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const STEPS = [1, 2, 3] as const;

export function Reconciliation({
  header,
  rows,
  states,
  totals,
  history,
  focusMid = null,
}: {
  header: PeriodHeader;
  rows: GridRow[];
  states: MerchantState[];
  totals: Synopsis[];
  history: HistoryEntry[];
  /** One merchant to start expanded, from `?mid=` on the URL. */
  focusMid?: string | null;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * Whether the Pricing-tab sync can reach this month at all.
   *
   * ── "BEFORE THIS MONTH", NOT "IS THIS MONTH" ─────────────────────────
   * The sync opens a row at `date_trunc('month', now())` with NO end date, so
   * it covers the current month AND every month after it. Only a month BEFORE
   * the current one is out of its reach.
   *
   * This was `=== thisMonth` first, which gets a future-dated period wrong —
   * it would tell the operator the Pricing tab cannot help when it is in fact
   * the right place. An integration test caught the same confusion from the
   * other side, by using a scratch month in 2031 and then asserting the sync
   * could not reach it.
   */
  const syncCanReach = useMemo(() => {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return header.statementMonth.slice(0, 7) >= thisMonth;
  }, [header.statementMonth]);

  const company = totals.find((t) => t.mid === null) ?? null;
  const byMid = useMemo(() => {
    const m = new Map<string, Synopsis>();
    for (const t of totals) if (t.mid !== null) m.set(t.mid, t);
    return m;
  }, [totals]);

  const stateByMid = useMemo(() => {
    const m = new Map<string, MerchantState>();
    for (const s of states) m.set(s.mid, s);
    return m;
  }, [states]);

  const rowsByMid = useMemo(() => {
    const m = new Map<string, GridRow[]>();
    for (const r of rows) {
      const list = m.get(r.mid) ?? [];
      list.push(r);
      m.set(r.mid, list);
    }
    /* The registry's own sort_order, with group rows after their members. */
    for (const list of m.values()) {
      list.sort(
        (a, b) =>
          (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
          a.scope.localeCompare(b.scope) ||
          (a.feeItemName ?? '').localeCompare(b.feeItemName ?? ''),
      );
    }
    return m;
  }, [rows]);

  /*
   * Merchants needing attention first, in the ladder's own order. Someone
   * opening a month wants the work, not the alphabet.
   */
  const ORDER: Record<MerchantState['state'], number> = {
    blocked: 0,
    awaiting_volumes: 1,
    mismatch: 2,
    ready: 3,
    reconciled: 4,
  };
  const mids = useMemo(() => {
    const all = [...new Set([...rowsByMid.keys(), ...stateByMid.keys()])];
    return all.sort((a, b) => {
      const sa = stateByMid.get(a)?.state;
      const sb = stateByMid.get(b)?.state;
      const oa = sa ? ORDER[sa] : 9;
      const ob = sb ? ORDER[sb] : 9;
      return oa - ob || a.localeCompare(b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsByMid, stateByMid]);

  /*
   * Open the ones with work in them; leave the settled ones closed.
   *
   * A merchant arrived at from the dashboard opens too, even when settled —
   * following a link to a merchant and finding their block collapsed reads as
   * the link having failed.
   */
  const [open, setOpen] = useState<Set<string>>(() => {
    const s = new Set<string>();
    for (const m of states) {
      if (m.state !== 'ready' && m.state !== 'reconciled') s.add(m.mid);
    }
    if (focusMid) s.add(focusMid);
    return s;
  });

  /*
   * WHICH operation `pending` refers to.
   *
   * One transition serves sign-off, reopen and every acknowledgment on the
   * month, so `pending` alone cannot say what is running — and putting a
   * spinner on a button because *something* is in flight would spin the
   * sign-off button while an acknowledgment three merchants down was saving.
   * Signing a month off is the heaviest and most consequential thing on this
   * screen (it freezes the calculations), so it is the one that most needs to
   * show that it started.
   */
  const [busy, setBusy] = useState<string | null>(null);

  const run = (label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
    setError(null);
    setNotice(null);
    setBusy(label);
    startTransition(async () => {
      try {
        const r = await fn();
        if (r.ok) setNotice(r.message);
        else setError(r.message);
      } finally {
        setBusy(null);
      }
    });
  };

  return (
    <div className="mt-2">
      <Header
        header={header}
        company={company}
        pending={pending}
        busy={busy}
        onSignOff={(note) => run('sign-off', () => signOffPeriodAction(header.id, note))}
        onReopen={(reason) => run('reopen', () => reopenPeriodAction(header.id, reason))}
      />

      {notice ? (
        <p
          role="status"
          className="mt-3 flex items-start gap-1.5 rounded-lg bg-ok-bg px-3 py-2 text-[12.5px] leading-relaxed text-ink-800"
        >
          <Icon name="check" size={13} strokeWidth={2.5} className="mt-[2px] shrink-0 text-ok" />
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-1.5 rounded-lg border border-[#f7cfd1] bg-[#fce9ea] px-3 py-2 text-[12.5px] leading-relaxed text-[#b02a30]"
        >
          <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
          {error}
        </p>
      ) : null}

      {mids.length === 0 ? (
        <div className="mt-4 rounded-xl border border-line bg-white px-4 py-5">
          <p className="text-[13px] font-semibold text-ink-700">This month has no lines</p>
          <p className="mt-0.5 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-400">
            The period exists but nothing has been imported into it, so there is nothing to
            reconcile. That is also why it cannot be signed off: a month with no merchants would be
            vacuously clean, and signing it would freeze it against the import that was about to
            arrive.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {mids.map((mid) => (
            <MerchantBlock
              key={mid}
              mid={mid}
              state={stateByMid.get(mid) ?? null}
              totals={byMid.get(mid) ?? null}
              rows={rowsByMid.get(mid) ?? []}
              open={open.has(mid)}
              onToggle={() =>
                setOpen((s) => {
                  const next = new Set(s);
                  if (next.has(mid)) next.delete(mid);
                  else next.add(mid);
                  return next;
                })
              }
              pending={pending}
              syncCanReach={syncCanReach}
              periodId={header.id}
              statementMonth={header.statementMonth}
              onNotice={(m) => {
                setError(null);
                setNotice(m);
              }}
              onError={(m) => {
                setNotice(null);
                setError(m);
              }}
              onAcknowledge={(scope, scopeId, step, reason) =>
                run('acknowledge', () =>
                  acknowledgeVerdictAction(header.id, scope, scopeId, step, reason),
                )
              }
              onWithdraw={(ackId, reason) =>
                run('withdraw', () => withdrawAcknowledgmentAction(header.id, ackId, reason))
              }
            />
          ))}
        </div>
      )}

      <HistoryPanel history={history} />
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * The header
 * ──────────────────────────────────────────────────────────────────────── */

function DerivedPill({ status }: { status: string }) {
  if (status === 'reconciled') return <StatusPill label="Reconciled" swatch="teal" dot={false} />;
  if (status === 'ready') return <StatusPill label="Ready" swatch="blue" dot={false} />;
  if (status === 'mismatch') return <StatusPill label="Mismatch" swatch="amber" dot={false} />;
  if (status === 'awaiting_volumes') return <OutlineChip>Awaiting volumes</OutlineChip>;
  return <OutlineChip>Open</OutlineChip>;
}

function Header({
  header,
  company,
  pending,
  busy,
  onSignOff,
  onReopen,
}: {
  header: PeriodHeader;
  company: Synopsis | null;
  pending: boolean;
  /** Which operation `pending` is about — see `run` above. */
  busy: string | null;
  onSignOff: (note: string) => void;
  onReopen: (reason: string) => void;
}) {
  const [note, setNote] = useState('');
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');

  const signedOff = header.storedStatus === 'reconciled';

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[17px] font-semibold text-ink-900">
              {monthLabel(header.statementMonth)}
            </h1>
            <DerivedPill status={header.derivedStatus} />
            {header.processor ? <OutlineChip tone="brand">{header.processor}</OutlineChip> : null}
          </div>
          <p className="mt-1 text-[12.5px] text-ink-500">
            {header.merchantCount} merchant{header.merchantCount === 1 ? '' : 's'}
            {header.calculationVersion === null
              ? ' · not calculated'
              : ` · calculation version ${header.calculationVersion}`}
          </p>
          {header.registryLabel ? (
            <p className="mt-0.5 max-w-[80ch] text-[11.5px] leading-snug text-ink-400">
              Priced by: {header.registryLabel}
            </p>
          ) : null}
          {header.processor === null ? (
            /*
              `residual_period_context` raises for this, and the page lets the
              header render anyway — a month that names no processor still has
              facts worth seeing, and the reason it cannot be reconciled is
              more useful than a 500.
            */
            <p className="mt-1.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-[#8a5a09]">
              <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
              This period names no processor, or names more than one. Verdicts are derived per
              processor, so they cannot be computed until that is resolved.
            </p>
          ) : null}
        </div>

        <div className="shrink-0 text-right">
          {/*
            The total, or the explanation of its absence. Never both, and never
            a number with a caveat attached: `residual_synopsis` returns NULL
            rather than a partial sum precisely so that a component cannot
            render one.
          */}
          {company?.disclosable && company.netIncome !== null ? (
            <>
              <p className="text-[11.5px] uppercase tracking-wide text-ink-400">Net income</p>
              <p className="text-[24px] font-semibold tabular leading-tight text-ink-900">
                {formatMoneyText(company.netIncome)}
              </p>
            </>
          ) : (
            <div className="max-w-[34ch] rounded-lg border border-line-soft bg-canvas px-3 py-2 text-left">
              <p className="text-[12.5px] font-semibold text-ink-700">No total yet</p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-ink-400">
                {company
                  ? `${company.merchantsComputed} of ${company.merchantsTotal} merchants and ${company.rowsComputed} of ${company.rowsTotal} rows have computed. A sum missing one side of the ledger is not a smaller number — it is a different one.`
                  : 'Nothing has computed for this month.'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── the ladder, as counts ─────────────────────────────────────── */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-3">
        {(
          [
            ['blocked', header.blocked, 'the engine could not compute something'],
            ['awaiting_volumes', header.awaitingVolumes, 'no volume figures on file'],
            ['mismatch', header.mismatch, 'a comparison disagrees, unacknowledged'],
            ['ready', header.ready, 'clean, not yet signed off'],
            ['reconciled', header.reconciled, 'signed off'],
          ] as const
        )
          .filter(([, n]) => n > 0)
          .map(([key, n, why]) => (
            <div key={key} title={why}>
              <p className="text-[17px] font-semibold tabular leading-none text-ink-900">{n}</p>
              <p className="mt-1 text-[11.5px] text-ink-500">
                {STATE_LABEL[key as MerchantState['state']]}
              </p>
            </div>
          ))}
      </div>

      {/* ── sign-off ─────────────────────────────────────────────────── */}
      <div className="border-t border-line-faint px-4 py-3">
        {signedOff ? (
          reopening ? (
            <div className="space-y-2">
              <label
                htmlFor="reopen-reason"
                className="block text-[12.5px] font-medium text-ink-700"
              >
                Why is this month being reopened?
              </label>
              <input
                id="reopen-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded against the month, permanently."
                className="w-full max-w-[520px] rounded-lg border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  icon="rotate-ccw"
                  disabled={pending || reason.trim().length < 3}
                  loading={pending && busy === 'reopen'}
                  loadingLabel="Reopening…"
                  onClick={() => onReopen(reason)}
                >
                  Reopen the month
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setReopening(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-[12.5px] text-ink-700">
                <Icon name="lock" size={13} className="text-ok" />
                Signed off. Acknowledgments and calculations are frozen.
              </p>
              <Button size="sm" variant="ghost" onClick={() => setReopening(true)}>
                Reopen
              </Button>
            </div>
          )
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                icon="check"
                disabled={pending || !header.signable}
                loading={pending && busy === 'sign-off'}
                loadingLabel="Signing off…"
                onClick={() => onSignOff(note)}
              >
                Sign the month off
              </Button>
              {header.signable ? (
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="A note, if there is anything to say (optional)"
                  className="min-w-[280px] flex-1 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] text-ink-900 outline-none focus-field"
                />
              ) : null}
            </div>
            {!header.signable ? (
              /*
                Said as the reason, not as a disabled button with no
                explanation. The "at least one merchant" half matters: an empty
                month is vacuously clean, and signing it would freeze it
                against the import that was about to arrive.
              */
              <p className="max-w-[80ch] text-[11.5px] leading-relaxed text-ink-400">
                {header.merchantCount === 0
                  ? 'Nothing has been imported into this month, so there is nothing to sign off.'
                  : 'Every merchant has to be clean first. Sign-off is a standing claim that the month agrees, and the counts above are what is standing in the way.'}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * One merchant
 * ──────────────────────────────────────────────────────────────────────── */

function StatePill({ state }: { state: MerchantState['state'] }) {
  if (state === 'reconciled') return <StatusPill label="Reconciled" swatch="teal" dot={false} />;
  if (state === 'ready') return <StatusPill label="Ready" swatch="blue" dot={false} />;
  if (state === 'mismatch') return <StatusPill label="Mismatch" swatch="amber" dot={false} />;
  if (state === 'blocked') return <OutlineChip tone="brand">Blocked</OutlineChip>;
  return <OutlineChip>Awaiting volumes</OutlineChip>;
}

/**
 * What a merchant's state means, and what to do about it.
 *
 * ── THE ADVICE FOR A BLOCKED MERCHANT WAS WRONG ──────────────────────────
 * It said "enter them on the merchant's Pricing tab and re-calculate". That is
 * true for the CURRENT month and false for every past one, which is every
 * month a real statement covers.
 *
 * `residual_sync_rates_from_record` writes its rates effective from
 * `residual_rate_effective_month(now())` — `date_trunc('month', now())` — with
 * no end date. That covers the current month and everything after it, and
 * nothing before. So filling the Pricing tab today leaves
 * `residual_merchant_rates_for_month(mid, '2026-05-01')` finding nothing, and
 * it RAISES rather than returning no rows. An operator following the old
 * advice would do the suggested thing, re-run the engine, see no change, and
 * have no way to tell which of the two had failed.
 *
 * Backdating is `residual_supersede_merchant_rate`, which takes the effective
 * date explicitly — the rate editor on this screen. The text below now says
 * that, and says it differently for a past month than for the current one,
 * because for the current month the Pricing tab genuinely is the right place.
 */
function stateExplanation(s: MerchantState, syncCanReach: boolean): string {
  if (s.state === 'blocked') {
    if (s.skippedWhole > 0) {
      return syncCanReach
        ? 'The engine skipped this merchant whole: it has no rates on file for this month. Fill in the Pricing tab on the merchant’s record — that syncs rates from the first of the current month, which covers this one — then re-calculate.'
        : 'The engine skipped this merchant whole: it has no rates on file for THIS month. Rates entered on the Pricing tab start from the current month and never reach an earlier one, so enter them below with this month’s effective date, then re-calculate.';
    }
    return `${s.blockedLines} line${s.blockedLines === 1 ? '' : 's'} could not be computed — a rate the rule needs is blank. Each failure records which rate it wanted.`;
  }
  if (s.state === 'awaiting_volumes') {
    /*
     * ── THE REASON IS QUOTED, NOT RE-DERIVED ────────────────────────────
     * `residual_merchant_states.awaiting_reason` already returns a sentence —
     * one of "engine recorded no_volumes", "a mapped row has no volume row for
     * this merchant-month", or "a needed volume bucket is NULL on the
     * statement row".
     *
     * This used to branch on `=== 'no_row'`, which is not a value that
     * function ever returns, so the else arm always won: a merchant with NO
     * volume row at all was told its row existed with a blank bucket. Wrong,
     * and wrong in the direction that sends the operator looking for a row
     * that is not there. The reason gated on the state is the function's own
     * fix-1 behaviour — it explains the state the row is actually in, or it is
     * NULL — so quoting it cannot drift from it.
     */
    const why = s.awaitingReason;
    const tail =
      ' Volume figures come from the processor’s PDF statement; they can be entered by hand below.';
    return why === null
      ? `The rules assessed on volume cannot compute for this merchant.${tail}`
      : `${why.charAt(0).toUpperCase()}${why.slice(1)}, so the rules assessed on volume cannot compute — and a blank bucket is not a zero, so the comparison is withheld rather than made against a guess.${tail}`;
  }
  if (s.state === 'mismatch') {
    return `${s.mismatchCount} comparison${s.mismatchCount === 1 ? '' : 's'} disagree${s.mismatchCount === 1 ? 's' : ''} beyond tolerance. Each one is either a real finding or something to acknowledge with a reason.`;
  }
  if (s.state === 'reconciled') return 'Signed off as part of this month.';
  return 'Every comparison agrees within tolerance.';
}

function MerchantBlock({
  mid,
  state,
  totals,
  rows,
  open,
  onToggle,
  pending,
  syncCanReach,
  periodId,
  statementMonth,
  onNotice,
  onError,
  onAcknowledge,
  onWithdraw,
}: {
  mid: string;
  state: MerchantState | null;
  totals: Synopsis | null;
  rows: GridRow[];
  open: boolean;
  onToggle: () => void;
  pending: boolean;
  /** Decides which of two true pieces of advice to give. See `stateExplanation`. */
  syncCanReach: boolean;
  periodId: string;
  statementMonth: string;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  onAcknowledge: (scope: string, scopeId: string, step: number, reason: string) => void;
  onWithdraw: (ackId: string, reason: string) => void;
}) {
  const name = rows.find((r) => r.merchantName)?.merchantName ?? null;
  const router = useRouter();

  /*
   * Null until the operator asks. Both editors are fetched on demand — one
   * call per merchant each, and fetching them for every merchant in a month
   * would be sixty round trips to render forms nobody has opened.
   *
   * Only one is open at a time. They fix different causes and a merchant has
   * one state, so offering both at once would invite the operator to guess
   * which is the blocker.
   */
  const [rates, setRates] = useState<RateEditorData | null>(null);
  const [volumes, setVolumes] = useState<VolumeRow | null>(null);
  const [loading, startLoad] = useTransition();

  /*
   * Offered where a RATE is what the engine is waiting on — a merchant skipped
   * whole, or one with blocked lines naming a rate it could not find.
   */
  const needsRates = state?.state === 'blocked';
  /*
   * And volumes where a VOLUME is. Deliberately separate: no rate fixes a
   * missing volume figure and no volume fixes a missing rate, and the ladder
   * already decided which one is standing in the way.
   */
  const needsVolumes = state?.state === 'awaiting_volumes';

  const openRates = () => {
    setVolumes(null);
    startLoad(async () => {
      const r = await loadRateEditorAction(periodId, mid);
      if (r.ok) setRates(r.data);
      else onError(r.message);
    });
  };

  const openVolumes = () => {
    setRates(null);
    startLoad(async () => {
      const r = await loadVolumesAction(periodId, mid);
      if (r.ok) setVolumes(r.row);
      else onError(r.message);
    });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer flex-wrap items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-canvas"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="text-ink-400" />
        <span className="text-[13.5px] font-semibold text-ink-900">{name ?? mid}</span>
        {name ? <span className="text-[12px] tabular text-ink-400">{mid}</span> : null}
        {state ? <StatePill state={state.state} /> : <OutlineChip>No state</OutlineChip>}
        <span className="text-[12px] text-ink-400">
          {rows.length} row{rows.length === 1 ? '' : 's'}
          {state && state.suppressedCount > 0
            ? ` · ${state.suppressedCount} acknowledged`
            : ''}
        </span>
        <span className="ml-auto text-[13px] tabular text-ink-700">
          {/* The merchant's own total, withheld on the same rule as the
              company one. */}
          {totals?.disclosable && totals.netIncome !== null
            ? formatMoneyText(totals.netIncome)
            : '—'}
        </span>
      </button>

      {open ? (
        <>
          {state ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-faint bg-canvas px-4 py-2">
              <p className="max-w-[86ch] text-[12px] leading-relaxed text-ink-500">
                {stateExplanation(state, syncCanReach)}
              </p>
              {needsRates && rates === null ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="percent"
                  disabled={loading}
                  loading={loading}
                  loadingLabel="Loading…"
                  onClick={openRates}
                >
                  Enter rates
                </Button>
              ) : null}
              {needsVolumes && volumes === null ? (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="database"
                  disabled={loading}
                  loading={loading}
                  loadingLabel="Loading…"
                  onClick={openVolumes}
                >
                  Enter volumes
                </Button>
              ) : null}
            </div>
          ) : null}

          {volumes !== null ? (
            <VolumeEditor
              periodId={periodId}
              row={volumes}
              onDone={(message) => {
                setVolumes(null);
                onNotice(message);
                router.refresh();
              }}
              onCancel={() => setVolumes(null)}
            />
          ) : null}

          {rates !== null ? (
            <RateEditor
              periodId={periodId}
              statementMonth={statementMonth}
              data={rates}
              onDone={(message) => {
                setRates(null);
                onNotice(message);
                /* The rate row is written, but the engine has not re-run — the
                   figures on screen are still the old ones until it does. The
                   refresh is so the merchant's state reflects the new row. */
                router.refresh();
              }}
              onCancel={() => setRates(null)}
            />
          ) : null}

          <LineTable
            rows={rows}
            pending={pending}
            onAcknowledge={onAcknowledge}
            onWithdraw={onWithdraw}
          />
        </>
      ) : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * The lines
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A money cell.
 *
 * `formatMoneyText` groups and prefixes the string without parsing it — see
 * its own note. A dash for null, because a withheld figure is not a zero.
 */
function Money({ v }: { v: string | null }) {
  if (v === null) return <span className="text-ink-300">—</span>;
  return <span>{formatMoneyText(v)}</span>;
}

/**
 * One step's cell.
 *
 * Four renderings for four meanings, and keeping them visually distinct is the
 * point of the component:
 *
 *   match      a tick. Nothing to do.
 *   exempt     said in words, because the rule shape means the comparison does
 *              not apply — a blank here would read as an oversight.
 *   mismatch   the signed delta, which is computed minus stated.
 *   absent     a dash. The comparison could not be made at all.
 */
function VerdictCell({ v }: { v: Verdict | undefined }) {
  if (!v) {
    return (
      <span
        className="text-ink-300"
        title="No comparison — the operand does not exist for this row."
      >
        —
      </span>
    );
  }
  if (v.verdict === 'match') {
    return (
      <span
        className="inline-flex items-center gap-1 text-ok"
        title={`Stated ${v.left ?? '—'}, computed ${v.right ?? '—'}, within ${v.tolerance ?? '—'}`}
      >
        <Icon name="check" size={12} strokeWidth={2.5} />
      </span>
    );
  }
  if (v.verdict === 'exempt') {
    return (
      <span
        className="text-[11px] text-ink-400"
        title="This comparison does not apply to this row by rule shape."
      >
        n/a
      </span>
    );
  }

  /* The only parse on this screen, and it chooses a colour rather than a
     value. The number itself is printed as the text it arrived as. */
  const negative = v.delta !== null && Number(v.delta) < 0;

  return (
    <span
      className={`inline-flex items-center gap-1 tabular ${
        v.suppressed ? 'text-ink-400 line-through decoration-ink-300' : 'text-[#b02a30]'
      }`}
      title={`Stated ${v.left ?? '—'}, computed ${v.right ?? '—'}, tolerance ${v.tolerance ?? '—'}${
        v.suppressed ? ' — acknowledged' : ''
      }`}
    >
      {negative ? null : '+'}
      {v.delta ?? '?'}
    </span>
  );
}

function LineTable({
  rows,
  pending,
  onAcknowledge,
  onWithdraw,
}: {
  rows: GridRow[];
  pending: boolean;
  onAcknowledge: (scope: string, scopeId: string, step: number, reason: string) => void;
  onWithdraw: (ackId: string, reason: string) => void;
}) {
  /** Which row+step is being acknowledged, and the reason being typed. */
  const [acking, setAcking] = useState<{ row: GridRow; step: number } | null>(null);
  /**
   * Which acknowledgment is being withdrawn.
   *
   * A withdrawal needs a reason for the same cause an acknowledgment does, and
   * the database refuses one under three characters. An earlier version of
   * this component submitted a canned string — which satisfies the constraint
   * and defeats its purpose, leaving a record that says an acceptance was
   * revoked and nothing about why.
   */
  const [withdrawing, setWithdrawing] = useState<{ row: GridRow; ackId: string } | null>(null);
  const [reason, setReason] = useState('');

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-left">
        <thead>
          <tr className="border-y border-line-faint text-[11px] uppercase tracking-wide text-ink-400">
            <th className="px-4 py-1.5 font-semibold">Fee item</th>
            <th className="px-2 py-1.5 text-right font-semibold">Count</th>
            <th className="px-2 py-1.5 text-right font-semibold">Stated net</th>
            <th className="px-2 py-1.5 text-right font-semibold">Income</th>
            <th className="px-2 py-1.5 text-right font-semibold">Buy rate</th>
            <th className="px-2 py-1.5 text-right font-semibold">Net before split</th>
            <th className="px-2 py-1.5 text-right font-semibold">Net income</th>
            {STEPS.map((s) => (
              <th
                key={s}
                className="px-2 py-1.5 text-center font-semibold"
                title={STEP_LABEL[s].long}
              >
                {STEP_LABEL[s].short}
              </th>
            ))}
            <th className="px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            /* A mismatch that is not yet acknowledged is the only actionable
               state, so that is the only thing that gets a button. */
            const actionable = STEPS.filter((s) => {
              const v = r.verdicts[String(s) as '1' | '2' | '3'];
              return v?.verdict === 'mismatch' && !v.suppressed;
            });
            const acknowledged = STEPS.map((s) => r.verdicts[String(s) as '1' | '2' | '3'])
              .filter((v): v is Verdict => Boolean(v?.suppressed && v?.ack_id));

            return (
              <tr key={`${r.scope}-${r.rowId}`} className={r.isGroupMember ? 'bg-canvas/40' : ''}>
                <td className="border-b border-line-faint px-4 py-1.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {r.scope === 'group' ? (
                      <OutlineChip tone="brand">group</OutlineChip>
                    ) : null}
                    <span className="text-[12.5px] text-ink-900">
                      {r.feeItemName ?? r.groupKey ?? '—'}
                    </span>
                    {/* A group member's own figures live on the group row, not
                        on the member — the engine writes 0.00 there, and
                        showing that as money would read as a real zero. */}
                    {r.isGroupMember ? (
                      <span
                        className="text-[10.5px] text-ink-400"
                        title="Priced as part of its group; the figures are on the group row."
                      >
                        in group
                      </span>
                    ) : null}
                    {r.source === 'manual' ? <OutlineChip>manual</OutlineChip> : null}
                  </span>
                  {r.volumeBuckets && r.volumeBuckets.length > 0 ? (
                    <span className="mt-0.5 block text-[10.5px] text-ink-400">
                      vs {r.volumeBuckets.join(' + ')}
                    </span>
                  ) : null}
                </td>
                <td className="border-b border-line-faint px-2 py-1.5 text-right text-[12.5px] tabular text-ink-500">
                  <Money v={r.itemCount} />
                </td>
                <td className="border-b border-line-faint px-2 py-1.5 text-right text-[12.5px] tabular text-ink-700">
                  <Money v={r.netRevenue} />
                </td>
                <td className="border-b border-line-faint px-2 py-1.5 text-right text-[12.5px] tabular text-ink-700">
                  <Money v={r.totalIncome} />
                </td>
                <td className="border-b border-line-faint px-2 py-1.5 text-right text-[12.5px] tabular text-ink-700">
                  <Money v={r.totalBuyRate} />
                </td>
                <td className="border-b border-line-faint px-2 py-1.5 text-right text-[12.5px] tabular text-ink-700">
                  <Money v={r.tapdashNetBeforeSplit} />
                </td>
                <td className="border-b border-line-faint px-2 py-1.5 text-right text-[12.5px] tabular font-medium text-ink-900">
                  <Money v={r.netIncome} />
                </td>
                {STEPS.map((s) => (
                  <td
                    key={s}
                    className="border-b border-line-faint px-2 py-1.5 text-center text-[12px]"
                  >
                    <VerdictCell v={r.verdicts[String(s) as '1' | '2' | '3']} />
                  </td>
                ))}
                <td className="border-b border-line-faint px-2 py-1.5 text-right">
                  {!r.isComputed ? (
                    <span className="text-[11px] text-ink-400" title="The engine skipped this row.">
                      not computed
                    </span>
                  ) : actionable.length > 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        setWithdrawing(null);
                        setAcking({ row: r, step: actionable[0] });
                        setReason('');
                      }}
                    >
                      Acknowledge
                    </Button>
                  ) : acknowledged.length > 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => {
                        const ackId = acknowledged[0].ack_id;
                        if (!ackId) return;
                        setAcking(null);
                        setWithdrawing({ row: r, ackId });
                        setReason('');
                      }}
                    >
                      Withdraw
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {acking ? (
        <AcknowledgeForm
          row={acking.row}
          step={acking.step}
          reason={reason}
          onReason={setReason}
          pending={pending}
          onCancel={() => setAcking(null)}
          onConfirm={(step) => {
            onAcknowledge(acking.row.scope, acking.row.rowId, step, reason);
            setAcking(null);
          }}
        />
      ) : null}

      {withdrawing ? (
        <ReasonPrompt
          title={`Withdraw the acknowledgment on ${withdrawing.row.feeItemName ?? withdrawing.row.groupKey ?? 'this row'}`}
          body="The mismatch starts counting again and will block the month until it is acknowledged afresh or the figures change."
          label="Why is it being withdrawn?"
          confirmLabel="Withdraw"
          reason={reason}
          onReason={setReason}
          pending={pending}
          onCancel={() => setWithdrawing(null)}
          onConfirm={() => {
            onWithdraw(withdrawing.ackId, reason);
            setWithdrawing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * A mandatory reason, for the actions whose whole value is the reason.
 *
 * Shared by withdrawal and reopening. The three-character floor is the
 * database's own (`length(btrim(coalesce(p_reason,''))) < 3` raises 22004);
 * disabling the button at the same threshold means the refusal arrives as a
 * greyed button rather than as a SQLSTATE.
 */
function ReasonPrompt({
  title,
  body,
  label,
  confirmLabel,
  reason,
  onReason,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  label: string;
  confirmLabel: string;
  reason: string;
  onReason: (v: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="border-t border-line-soft bg-canvas px-4 py-3">
      <p className="text-[13px] font-semibold text-ink-900">{title}</p>
      <p className="mt-0.5 max-w-[80ch] text-[12px] leading-relaxed text-ink-500">{body}</p>

      <label htmlFor="reason-prompt" className="mt-2.5 block text-[12.5px] font-medium text-ink-700">
        {label}
      </label>
      <input
        id="reason-prompt"
        value={reason}
        onChange={(e) => onReason(e.target.value)}
        placeholder="Recorded permanently."
        className="mt-1 w-full max-w-[640px] rounded-lg border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
      />

      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="danger"
          disabled={pending || reason.trim().length < 3}
          loading={pending}
          loadingLabel="Saving…"
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The reason, which is mandatory.
 *
 * It shows the two numbers being reconciled, because an acknowledgment is a
 * claim about THOSE numbers and the person writing the reason should be able
 * to see them while they write it. The delta itself is not submitted — the
 * function derives it, so that the record is of what was actually true rather
 * than what the client said was.
 */
function AcknowledgeForm({
  row,
  step,
  reason,
  onReason,
  pending,
  onCancel,
  onConfirm,
}: {
  row: GridRow;
  step: number;
  reason: string;
  onReason: (v: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (step: number) => void;
}) {
  const mismatched = STEPS.filter((s) => {
    const v = row.verdicts[String(s) as '1' | '2' | '3'];
    return v?.verdict === 'mismatch' && !v.suppressed;
  });
  const [chosen, setChosen] = useState<number>(step);
  const v = row.verdicts[String(chosen) as '1' | '2' | '3'];

  return (
    <div className="border-t border-line-soft bg-canvas px-4 py-3">
      <p className="text-[13px] font-semibold text-ink-900">
        Acknowledge a mismatch on {row.feeItemName ?? row.groupKey ?? 'this row'}
      </p>

      {mismatched.length > 1 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-ink-400">Which comparison:</span>
          {mismatched.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setChosen(s)}
              className={`cursor-pointer rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                chosen === s
                  ? 'border-brand-600/30 bg-brand-50 text-brand-700'
                  : 'border-line bg-white text-ink-600 hover:border-ink-400'
              }`}
            >
              {STEP_LABEL[s].short}
            </button>
          ))}
        </div>
      ) : null}

      <p className="mt-2 max-w-[80ch] text-[12px] leading-relaxed text-ink-500">
        {STEP_LABEL[chosen as 1 | 2 | 3].long}
      </p>

      {v ? (
        <p className="mt-1.5 text-[12.5px] tabular text-ink-700">
          Stated <strong>{v.left ?? '—'}</strong>, computed <strong>{v.right ?? '—'}</strong>,
          tolerance {v.tolerance ?? '—'} &mdash; a difference of{' '}
          <strong className="text-[#b02a30]">{v.delta ?? '?'}</strong>
        </p>
      ) : null}

      <label htmlFor="ack-reason" className="mt-2.5 block text-[12.5px] font-medium text-ink-700">
        Why is this difference acceptable?
      </label>
      <input
        id="ack-reason"
        value={reason}
        onChange={(e) => onReason(e.target.value)}
        placeholder="Recorded permanently, against this row and this month."
        className="mt-1 w-full max-w-[640px] rounded-lg border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
      />
      <p className="mt-1 max-w-[80ch] text-[11px] leading-snug text-ink-400">
        The row keeps showing the difference. Acknowledging it stops it blocking the month, and
        records who accepted it and why — if the figures move, the acknowledgment retires itself.
      </p>

      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          icon="check"
          disabled={pending || reason.trim().length < 3}
          onClick={() => onConfirm(chosen)}
        >
          Acknowledge
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * What happened to this month
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Four append-only sources on one timeline.
 *
 * Collapsed by default: it is the answer to "what happened to this month",
 * which is a question somebody asks occasionally and urgently, not a thing to
 * read past on the way to the grid.
 */
function HistoryPanel({ history }: { history: HistoryEntry[] }) {
  const [open, setOpen] = useState(false);

  if (history.length === 0) return null;

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-canvas"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} className="text-ink-400" />
        <span className="text-[13px] font-semibold text-ink-900">What happened to this month</span>
        <span className="text-[12px] text-ink-400">({history.length})</span>
      </button>

      {open ? (
        <ul className="divide-y divide-line-faint border-t border-line-faint">
          {history.map((h, i) => (
            <li key={`${h.kind}-${h.occurredAt}-${i}`} className="px-4 py-2">
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="text-[12.5px] font-medium text-ink-900">
                  {HISTORY_KIND_LABEL[h.kind] ?? h.kind}
                </span>
                <span className="text-[11.5px] text-ink-400">
                  {new Date(h.occurredAt).toLocaleString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </p>
              {/*
                The detail verbatim. These are append-only records and the
                useful thing is what they actually say, not a summary of it
                that could be wrong about a month somebody is disputing.
              */}
              <pre className="mt-0.5 max-w-full overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-ink-500">
                {JSON.stringify(h.detail, null, 1)}
              </pre>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
