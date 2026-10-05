/**
 * Admin → Residuals → one month.
 *
 * ── THE QUESTION THIS SCREEN ANSWERS ─────────────────────────────────────
 * "Does what the processor paid us agree with what we should have earned, and
 * where it doesn't, why not." Everything else in the module exists to make
 * this page answerable.
 *
 * ── WHY IT IS A PAGE AND NOT ANOTHER TAB ─────────────────────────────────
 * The other four tabs are about configuration and are the same whichever
 * month you are looking at. This one is about ONE month, and it has a URL so
 * a disputed month can be linked to in an email.
 *
 * ── A NUMBER IS NOT SHOWN UNTIL IT IS A COMPLETE NUMBER ──────────────────
 * `residual_synopsis` returns `net_income` as NULL unless the month carries a
 * calculation version, and `disclosable` says which case it is. The page
 * honours that by not rendering a total at all — not a greyed one, not one
 * labelled "partial". Daniel's argument, and it is the sharpest one in the
 * module: a figure labelled partial is read as two true things, a loss and
 * some missing rows, and the first of those is false.
 *
 * ── EVERY READ HERE CAN THROW, AND IS LET TO ──────────────────────────────
 * `residual_period_context` raises rather than guessing when a period names no
 * processor or more than one. Catching that to render an empty grid would turn
 * a refusal into a clean bill of health, which is the bug this module already
 * had once. The one exception is handled inside `periodHeader`, which allows
 * the context read to fail so the month's own facts still render.
 */
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { authorize } from '@/lib/records/permissions';
import {
  gridRows,
  merchantStates,
  periodHeader,
  periodHistory,
  synopsis,
} from '@/lib/records/residualGrid';
import { Icon } from '@/proto/ui/icons';
import { Reconciliation } from './Reconciliation';

export default async function PeriodPage({
  params,
}: {
  params: Promise<{ periodId: string }>;
}) {
  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  const { periodId } = await params;

  /* A malformed id would reach PostgREST as a bad uuid and raise 22P02; a
     404 is the honest answer to a URL that is not a period. */
  if (!/^[0-9a-f-]{36}$/i.test(periodId)) notFound();

  const header = await periodHeader(ctx, periodId);
  if (!header) notFound();

  const [rows, states, totals, history] = await Promise.all([
    gridRows(ctx, periodId),
    merchantStates(ctx, periodId),
    synopsis(ctx, periodId),
    periodHistory(ctx, periodId, 50),
  ]);

  return (
    <div className="p-6">
      <Link
        href="/admin/residuals"
        className="inline-flex items-center gap-1 text-[12.5px] text-ink-500 transition-colors hover:text-ink-900"
      >
        <Icon name="chevron-left" size={13} />
        All periods
      </Link>

      <Reconciliation
        header={header}
        rows={rows}
        states={states}
        totals={totals}
        history={history}
      />
    </div>
  );
}
