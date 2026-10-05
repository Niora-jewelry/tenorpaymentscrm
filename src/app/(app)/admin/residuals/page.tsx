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
import { authorize } from '@/lib/records/permissions';
import {
  listPeriods,
  referenceSummary,
  buyRates,
  linkWorklist,
  processors,
} from '@/lib/records/adminResiduals';
import { recentImports } from '@/lib/records/residualImport';
import { ResidualsTabs } from './ResidualsTabs';

export default async function AdminResidualsPage() {
  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

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

  return (
    <div className="p-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-ink-900">Residuals</h1>
        <p className="text-[13px] text-ink-500">
          What the processor paid, against what TapDash should have earned.
        </p>
      </div>

      <ResidualsTabs
        periods={periods}
        reference={reference}
        rates={rates}
        worklist={worklist}
        processors={procs}
        imports={imports}
      />
    </div>
  );
}
