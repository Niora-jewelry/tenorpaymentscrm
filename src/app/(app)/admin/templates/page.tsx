/**
 * Admin → Permissions — the user types (Permissions spec), each linking to its
 * settings, its tab / sub-tab / field levels and its history.
 *
 * `HowPermissionsWork` above the list states the model where it is configured:
 * own override → user type → most restrictive, Super admin above all of it, and
 * the guardrails.
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
        <h1 className="text-xl font-semibold text-ink-900">Permissions</h1>
        <p className="text-[13px] text-ink-500">
          Everyone has one user type. Set a type here; set one person&rsquo;s own differences from the Users screen.
        </p>
      </div>

      <HowPermissionsWork />

      <TemplatesSection templates={templates} />
    </div>
  );
}
