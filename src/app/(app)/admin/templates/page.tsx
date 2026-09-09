/**
 * Admin → Templates — Phase 6a of the permission work.
 *
 * Creating and renaming permission templates. What a template GRANTS is not
 * editable yet: that is the matrix, 6b (read-only) then 6c (writes), and it
 * gets built on this screen's route once this one is verified. The banner and
 * the per-row "grants nothing" line are there because until then, a template
 * created here has zero grants and therefore restricts nothing —
 * `effective_grant()` falls through to **Edit**, not Hidden. See
 * `adminTemplates.ts`'s header.
 *
 * Gated the way every admin route is: `authorize()`, redirect if not admin,
 * and checked again independently inside every action.
 */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { listTemplatesForAdmin } from '@/lib/records/adminTemplates';
import { TemplatesSection } from './TemplatesSection';

export default async function AdminTemplatesPage() {
  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  const templates = await listTemplatesForAdmin(ctx);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Permission templates</h1>
        <p className="text-[13px] text-ink-500">
          A named set of permissions, attached to users on the Users screen.
        </p>
      </div>

      <TemplatesSection templates={templates} />
    </div>
  );
}
