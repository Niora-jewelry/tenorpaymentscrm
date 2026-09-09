/**
 * /dashboard — the authenticated landing target.
 *
 * ── THE LOOP THIS FIXES (found 2026-09-07, live) ─────────────────────────
 * This file used to end in a bare `redirect('/records')`, guarded only by the
 * comment below, which predicted the exact fault it then shipped:
 *
 *   > "Records List has no seeded template that hides it, and no UI yet exists
 *   >  to create one … so this can't loop today."
 *
 * It could, and it did — not through a template, but through the `admin_only`
 * floor that was there all along. Records List is `admin_only = true`, and
 * `resolveModuleGrant` (`grantRules.ts`) returns **hidden** for any non-admin
 * on an admin-only module regardless of any grant. So:
 *
 *   sign in → DEFAULT_REDIRECT = /dashboard → /records
 *           → [module]/page.tsx sees grant 'hidden' → redirect('/dashboard')
 *           → /records → … forever
 *
 * Four Member accounts exist in the live database. **None of them could reach
 * the application at all.** It was never caught because the permission model
 * had never been exercised by a non-admin — the project's own notes say so.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────
 * Land on the first module this person can actually open, resolved through the
 * same gate the module route itself uses, rather than on a hard-coded slug.
 * An admin still lands on Records List because it is first in `position`
 * order; a member lands on their first visible display module.
 *
 * The redirect target is therefore never a route that will bounce them back,
 * which is what makes the loop unreachable rather than merely unlikely. If a
 * future admin hides every module from someone, they get a plain explanation
 * instead of a redirect — see below.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { authorize, moduleGrant } from '@/lib/records/permissions';
import { loadConfig } from '@/lib/records/config';
import { Icon } from '@/proto/ui/icons';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // Middleware already enforces the session. Re-checking is deliberate: a
  // server component must never assume an upstream check ran.
  const ctx = await authorize();
  const config = await loadConfig();

  // Resolved through the SAME gate `[module]/page.tsx` applies, so a module
  // that would bounce the user back here can never be chosen as the target.
  // `config.modules` is already in the admin's `position` order.
  const grants = await Promise.all(
    config.modules.map(async (m) => ({ m, grant: await moduleGrant(ctx, m.id, m.adminOnly) })),
  );
  const first = grants.find((g) => g.grant !== 'hidden');

  if (first) redirect(`/${first.m.slug}`);

  /*
   * No module is visible to this account. Previously unreachable-by-assumption
   * and therefore unhandled; now it is a real state an admin can create with
   * the grant matrix, so it gets a real screen. A redirect here would be the
   * loop all over again.
   */
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-line bg-white p-6 text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-full bg-canvas text-ink-400">
          <Icon name="lock" size={18} />
        </div>
        <h1 className="mt-3 text-[15px] font-semibold text-ink-900">No modules are shared with you yet</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          Your account is active, but an administrator has not given it access to any module.
          Ask them to grant you access and then reload this page.
        </p>
        <Link
          href="/dashboard"
          className="mt-4 inline-flex rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-ink-700 transition-colors hover:bg-canvas"
        >
          Reload
        </Link>
      </div>
    </div>
  );
}
