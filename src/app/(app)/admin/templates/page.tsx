/**
 * Admin → Permissions — create and rename permission templates, and reach the
 * grant matrix for each one.
 *
 * A template's grants ARE editable: `setTemplateGrant`/`clearTemplateGrant`
 * write them, and the Permissions link on each row opens the matrix that does
 * it. (This file's header used to say the opposite, describing a phase that had
 * since shipped.)
 *
 * `HowPermissionsWork` above the list carries the model itself. It is on the
 * screen rather than in a document because one rule reliably surprises people
 * and is expensive to get wrong: an empty template restricts NOTHING, since a
 * scope with no entry resolves to Edit rather than Hidden.
 *
 * Gated the way every admin route is: `authorize()`, redirect if not admin,
 * and checked again independently inside every action.
 */
import { redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { listTemplatesForAdmin } from '@/lib/records/adminTemplates';
import { TemplatesSection } from './TemplatesSection';
import { HowPermissionsWork } from './HowPermissionsWork';

export default async function AdminTemplatesPage() {
  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'permissions'))) redirect('/dashboard');

  const templates = await listTemplatesForAdmin(ctx);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Permission templates</h1>
        <p className="text-[13px] text-ink-500">
          A named set of permissions, attached to users on the Users screen.
        </p>
      </div>

      <HowPermissionsWork />

      <TemplatesSection templates={templates} />
    </div>
  );
}
