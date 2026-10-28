/**
 * `Admin → Permissions → one user type` — its settings (Permissions spec), its
 * tab / sub-tab / field levels, and its change history.
 *
 * The matrix is framed as "a non-admin on only this type", which is why
 * `templateGrantMatrix` passes `isAdmin: false`. The actions passed down
 * re-authorize on their own, because a Server Action is reachable without
 * ever loading this page.
 */
import { notFound, redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { templateGrantMatrix } from '@/lib/records/adminGrants';
import { OutlineChip } from '@/proto/ui/kit';
import { GrantMatrix, MatrixBackLink, type GrantWriter } from '../../GrantMatrix';
import { setTemplateGrantAction, clearTemplateGrantAction, setTemplateGrantsAction } from '../actions';
import { ModuleScopePicker } from '../../ModuleScopePicker';
import { loadConfig } from '@/lib/records/config';
import { permissionHistory, settingGroups, templateSettings } from '@/lib/records/permissionSettings';
import { SettingsPanel } from '../../SettingsPanel';
import { PermissionHistory } from '../../PermissionHistory';

export default async function TemplateGrantsPage({
  params,
  searchParams,
}: {
  params: Promise<{ templateId: string }>;
  searchParams: Promise<{ module?: string }>;
}) {
  const { templateId } = await params;
  const { module: moduleParam } = await searchParams;

  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'permissions'))) redirect('/dashboard');

  const config = await loadConfig();
  // Validated against the real module list — a mistyped link must not silently
  // write a per-module grant nobody intended.
  const activeModuleId = config.modules.some((m) => m.id === moduleParam) ? moduleParam! : null;

  const matrix = await templateGrantMatrix(ctx, templateId, activeModuleId);
  if (!matrix || matrix.subject.kind !== 'template') notFound();
  const { subject } = matrix;
  const [groups, settings, history] = await Promise.all([
    settingGroups(),
    templateSettings(ctx, templateId),
    permissionHistory(ctx, 'template', templateId),
  ]);

  // Bound to this template here rather than passed as an id the client sends
  // back with every write — the matrix never needs to know which template it is
  // editing, and an id it cannot supply is an id it cannot get wrong.
  const writer: GrantWriter = {
    column: 'template',
    set: async (scopeKind, scopeId, level) => {
      'use server';
      return setTemplateGrantAction(templateId, scopeKind, scopeId, level, activeModuleId);
    },
    clear: async (scopeKind, scopeId) => {
      'use server';
      return clearTemplateGrantAction(templateId, scopeKind, scopeId, activeModuleId);
    },
    setMany: async (items) => {
      'use server';
      return setTemplateGrantsAction(templateId, items, activeModuleId);
    },
  };

  return (
    <div className="space-y-5 p-6">
      <div className="space-y-2">
        <MatrixBackLink href="/admin/templates" label="All user types" />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-ink-900">{subject.label}</h1>
          <OutlineChip>
            {subject.attachedUsers} user{subject.attachedUsers === 1 ? '' : 's'}
          </OutlineChip>
        </div>
        <p className="text-[13px] text-ink-500">
          Everyone of this type gets these settings, except where one person has their own override.
          A change applies on their next request.
        </p>
      </div>

      <SettingsPanel
        mode="template"
        ownerId={templateId}
        groups={groups}
        values={settings.values}
        ceiling={settings.ceiling}
        actorIsSuper={settings.actorIsSuper}
        locked={settings.locked}
      />

      <div>
        <h2 className="text-[14px] font-semibold text-ink-900">Tabs, sub-tabs and fields</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-500">Hidden, View or Edit for each one. A sub-tab or field can differ from its tab.</p>
      </div>

      <ModuleScopePicker
        modules={config.modules
          .filter((m) => !m.adminOnly)
          .map((m) => ({ id: m.id, label: m.label }))}
        activeModuleId={activeModuleId}
        basePath={`/admin/templates/${templateId}`}
      />

      <GrantMatrix matrix={matrix} writer={writer} />

      <PermissionHistory entries={history} />
    </div>
  );
}
