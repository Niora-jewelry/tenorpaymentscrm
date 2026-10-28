/**
 * `Admin → Users → one person → Permissions` — the same matrix, with the
 * column that only a real person has: their own overrides.
 *
 * This route exists because of the 2026-09-05 scope decision
 * (`remaining-plan.md` § The scope question): per-user overrides are in scope,
 * because two of the client's three permission labels — "Template: X (edited)"
 * and "Custom" — are *defined by* `user_grants` rows. Phase 6c is where they
 * stop being unreachable states: this screen is the only thing in the build that
 * can write one.
 *
 * ── ONLY THE OVERRIDE COLUMN IS EDITABLE HERE ────────────────────────────
 * The template's own grants are shown and not touchable. Editing them from
 * inside one person's screen would silently change everyone else attached to the
 * same template, on a page whose entire framing is this one person; the link
 * above goes to the template, where that blast radius is stated.
 *
 * Changing a user's type (Users screen) KEEPS their overrides — Permissions
 * spec: "Only the settings that were overridden for them stay as they are".
 * "Reset to their type" in the Settings panel removes all of them, settings and
 * grants alike, each one logged (`perm_reset_user`, migration 9818).
 */
import { notFound, redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { userGrantMatrix } from '@/lib/records/adminGrants';
import { OutlineChip } from '@/proto/ui/kit';
import { GrantMatrix, MatrixBackLink, type GrantWriter } from '../../../GrantMatrix';
import { setUserGrantAction, clearUserGrantAction, setUserGrantsAction } from '../../actions';
import { ModuleScopePicker } from '../../../ModuleScopePicker';
import { loadConfig } from '@/lib/records/config';
import { permissionHistory, settingGroups, userSettings } from '@/lib/records/permissionSettings';
import { SettingsPanel } from '../../../SettingsPanel';
import { PermissionHistory } from '../../../PermissionHistory';

export default async function UserPermissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ module?: string }>;
}) {
  const { userId } = await params;
  const { module: moduleParam } = await searchParams;

  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'permissions'))) redirect('/dashboard');

  const config = await loadConfig();
  /*
   * Validated against the real module list rather than trusted from the URL.
   * An unknown id falls back to "All modules" — the safe reading, since a
   * mistyped link must not silently write a per-module grant nobody intended.
   */
  const activeModuleId = config.modules.some((m) => m.id === moduleParam) ? moduleParam! : null;

  const matrix = await userGrantMatrix(ctx, userId, activeModuleId);
  if (!matrix || matrix.subject.kind !== 'user') notFound();
  const { subject } = matrix;
  const [groups, settings, history] = await Promise.all([
    settingGroups(),
    userSettings(ctx, userId),
    permissionHistory(ctx, 'user', userId),
  ]);

  // Bound to this person here, so the matrix never carries a user id the client
  // could send back changed.
  const writer: GrantWriter = {
    column: 'user',
    set: async (scopeKind, scopeId, level) => {
      'use server';
      // Bound here alongside the user id, for the same reason: the client must
      // not be able to send back a different module than the one it was shown.
      return setUserGrantAction(userId, scopeKind, scopeId, level, activeModuleId);
    },
    clear: async (scopeKind, scopeId) => {
      'use server';
      return clearUserGrantAction(userId, scopeKind, scopeId, activeModuleId);
    },
    setMany: async (items) => {
      'use server';
      return setUserGrantsAction(userId, items, activeModuleId);
    },
  };

  return (
    <div className="space-y-5 p-6">
      <div className="space-y-2">
        <MatrixBackLink href="/admin/users" label="All users" />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-ink-900">{subject.label}</h1>
          <OutlineChip tone={settings.typeLabel ? 'brand' : 'warn'}>{settings.typeLabel ?? 'No user type'}</OutlineChip>
        </div>
        <p className="text-[13px] text-ink-500">
          {subject.email} — what their user type gives them, and where they differ. To let them see
          one colleague&rsquo;s records as well, use{' '}
          {/* Module access (Only mine / All records) is set here; a record
              visibility grant adds one colleague's records on top of it. */}
          <a href={`/admin/users/${userId}/record-access`} className="text-brand-700 hover:underline">
            record access
          </a>
          .
        </p>
      </div>

      <SettingsPanel
        mode="user"
        ownerId={userId}
        groups={groups}
        values={settings.values}
        typeValues={settings.typeValues}
        typeLabel={settings.typeLabel}
        ceiling={settings.ceiling}
        actorIsSuper={settings.actorIsSuper}
        locked={settings.locked}
        grantOverrides={settings.grantOverrides}
      />

      <div>
        <h2 className="text-[14px] font-semibold text-ink-900">Tabs, sub-tabs and fields</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-500">
          Their type&rsquo;s level, their own override, and what applies.
          {settings.grantOverrides ? ' “Reset to their type” above removes these overrides too.' : ''}
        </p>
      </div>

      <ModuleScopePicker
        modules={config.modules
          // Admin-only modules are never grantable to a non-admin, so offering
          // the Records List here would be a control with no effect.
          .filter((m) => !m.adminOnly)
          .map((m) => ({ id: m.id, label: m.label }))}
        activeModuleId={activeModuleId}
        basePath={`/admin/users/${userId}/permissions`}
      />

      <GrantMatrix matrix={matrix} writer={writer} />

      <PermissionHistory entries={history} />
    </div>
  );
}
