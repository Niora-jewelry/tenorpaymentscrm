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
 * ⚠️ **`assignTemplate` deletes every row in the override column.**
 * `adminUsers.ts` clears `user_grants` before upserting `user_templates`, and
 * the reasoning is sound and predates this phase — "Template: X" without
 * "(edited)" has to mean no overrides. What 6c changed is that the clear now
 * destroys something: it refuses unless the caller confirms, and `UsersTable`
 * says how many overrides it is about to delete before doing it. The banner
 * below is the same fact stated on the screen showing the rows at stake.
 */
import { notFound, redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { userGrantMatrix } from '@/lib/records/adminGrants';
import { OutlineChip } from '@/proto/ui/kit';
import { PlaceholderNotice } from '../../../PlaceholderNotice';
import { GrantMatrix, MatrixBackLink, type GrantWriter } from '../../../GrantMatrix';
import { setUserGrantAction, clearUserGrantAction } from '../../actions';
import { ModuleScopePicker } from '../../../ModuleScopePicker';
import { loadConfig } from '@/lib/records/config';

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
  if (!ctx.isAdmin) redirect('/dashboard');

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
  };

  return (
    <div className="space-y-5 p-6">
      <div className="space-y-2">
        <MatrixBackLink href="/admin/users" label="All users" />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-ink-900">{subject.label}</h1>
          <OutlineChip tone={subject.templateLabel ? 'brand' : 'neutral'}>{subject.permissionLabel}</OutlineChip>
          <OutlineChip>{subject.roleName}</OutlineChip>
        </div>
        <p className="text-[13px] text-ink-500">
          {subject.email} — the template&rsquo;s grant, this person&rsquo;s own override, and what each
          one resolves to. Every scope below is about a record this person can already see;{' '}
          {/* Two different permissions, one page apart, so each says where the other
              lives: this matrix decides what is shown OF a record, `record-access`
              decides which records are in the query result at all. */}
          <a href={`/admin/users/${userId}/record-access`} className="text-brand-700 hover:underline">
            record access
          </a>{' '}
          decides which records those are.
        </p>
      </div>

      {matrix.counts.userSet > 0 ? (
        <PlaceholderNotice title="Assigning a template on the Users screen deletes every override below">
          <p>
            Attaching a template clears this person&rsquo;s {matrix.counts.userSet} override
            {matrix.counts.userSet === 1 ? '' : 's'} first — that is what keeps &ldquo;Template: X&rdquo;
            meaning &ldquo;no personal changes&rdquo;. The assign control now asks before it does,
            naming the count, but there is no way back afterwards: rebuild them here.
          </p>
        </PlaceholderNotice>
      ) : null}

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
    </div>
  );
}
