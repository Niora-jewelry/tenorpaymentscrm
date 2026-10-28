/**
 * Admin → Residuals.
 *
 * ── WHAT THIS SCREEN IS FOR TODAY ────────────────────────────────────────
 * The engine, the registry and the reference data are all in place, and no
 * statement has ever been imported. So the honest job of this page right now
 * is to show what the module WOULD compute with — the twenty rules, the buy
 * rates, the split percentages, which merchants have rates — and to say
 * plainly what is missing before a number can be trusted.
 *
 * That is deliberate rather than a placeholder. A residuals screen showing
 * $0.00 because nothing has been imported is indistinguishable from one
 * showing $0.00 because the arithmetic is wrong, and the difference is the
 * whole question an operator opening this page is asking.
 *
 * ── GATED LIKE THE REST OF ADMIN ─────────────────────────────────────────
 * `ctx.isAdmin`, the same check every other admin page makes. Daniel's module
 * lived under a layout calling requireSuperAdmin() while its RLS admitted
 * admins too, and his handoff flags that mismatch as unresolved: "an admin
 * user has database permission to do everything in this module and no way to
 * reach any of it... Do not leave them disagreeing."
 *
 * Here they agree. The RLS, the SECURITY DEFINER functions and this page all
 * ask the same question: auth_is_admin().
 */
import { redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import {
  listPeriods,
  referenceSummary,
  buyRates,
  linkWorklist,
  processors,
} from '@/lib/records/adminResiduals';
import { recentImports } from '@/lib/records/residualImport';
import { merchantDashboard, synopsis } from '@/lib/records/residualGrid';
import { volumeMappingCoverage } from '@/lib/records/residualVolumes';
import { ResidualsHeader } from './ResidualsHeader';
import { ResidualsTabs } from './ResidualsTabs';

export default async function AdminResidualsPage() {
  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'residuals'))) redirect('/dashboard');

  const [periods, reference, rates, worklist, procs, imports] = await Promise.all([
    listPeriods(ctx),
    referenceSummary(ctx),
    buyRates(ctx),
    linkWorklist(ctx, null),
    processors(ctx),
    /* The handoff's own spec for this page: the last 20 imports with their
       error_message, "so a failed import is visible without a DB query". */
    recentImports(ctx, 20),
  ]);

  /*
   * The newest period's company-wide figure, for the status header.
   *
   * One extra call, and only when there is a period to ask about — the header
   * exists to answer "where does this stand" without a click, and a month
   * with no figure is exactly as worth saying as one with a figure.
   *
   * `listPeriods` orders newest first, so [0] is the month being worked on.
   */
  const latest = periods[0] ?? null;
  /*
   * Allowed to fail. The header is a convenience — it says where things stand
   * before you pick a tab — and a convenience must not be able to take the
   * whole screen down with it. `synopsis` throws on any read error, and a
   * period in an odd state (naming no processor, or more than one) is exactly
   * the case where an admin most needs the rest of this page.
   *
   * The same posture `periodHeader` already takes with `residual_period_context`.
   */
  const company = await (async () => {
    if (!latest) return null;
    try {
      const totals = await synopsis(ctx, latest.id);
      return totals.find((t) => t.mid === null) ?? null;
    } catch (e) {
      console.error('[residuals] header synopsis failed', e);
      return null;
    }
  })();

  /*
   * Which volumes each fee item is assessed on, for the Statements tab.
   *
   * Allowed to fail for the same reason the synopsis is: it is reference
   * information that makes a step-1 difference readable, not something the
   * import path depends on. A period in an odd state must not cost an admin
   * the ability to load a statement.
   */
  /*
   * Tab 1. Allowed to fail for the same reason the synopsis is: it is a view
   * over three reads that already have their own screens, and a period in an
   * odd state must not cost an admin the rest of the module.
   */
  const merchants = await (async () => {
    if (!latest) return [];
    try {
      return await merchantDashboard(ctx, latest.id);
    } catch (e) {
      console.error('[residuals] merchant dashboard failed', e);
      return [];
    }
  })();

  const volumeMappings = await (async () => {
    if (!latest) return [];
    try {
      return await volumeMappingCoverage(ctx, latest.id);
    } catch (e) {
      console.error('[residuals] volume mapping coverage failed', e);
      return [];
    }
  })();

  return (
    <div className="p-6">
      <ResidualsHeader
        periods={periods}
        netIncome={company?.netIncome ?? null}
        disclosable={company?.disclosable ?? false}
        ratedMids={reference.ratedMids}
        unattached={worklist.length}
      />

      <ResidualsTabs
        periods={periods}
        reference={reference}
        rates={rates}
        worklist={worklist}
        processors={procs}
        imports={imports}
        volumeMappings={volumeMappings}
        merchants={merchants}
        latestPeriodId={latest?.id ?? null}
        latestStatementMonth={latest?.statementMonth ?? null}
      />
    </div>
  );
}
