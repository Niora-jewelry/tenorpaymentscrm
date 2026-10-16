/**
 * Permissions for somebody who does not exist yet.
 *
 * ── THE CLIENT'S ASK ─────────────────────────────────────────────────────
 *   "When creating a user the admin should be able to assign a template and
 *    also adjust permissions before sending invite — currently the admin can
 *    only do this afterward"
 *
 * The template half has been on the invite since migration 71. This screen is
 * the other half: the personal override, decided now and applied by
 * `complete_signup` in the same transaction that creates the profile.
 *
 * ── IT IS THE SAME SCREEN THEY WILL USE AFTERWARDS ───────────────────────
 * Deliberately identical to `users/[userId]/permissions` — same matrix, same
 * columns, same module picker, same wording. An admin who learns one has
 * learned the other, and `GrantMatrix` needed no changes to serve both, so the
 * screen that already worked is untouched.
 *
 * ── ONLY WHILE THE INVITE IS PENDING ─────────────────────────────────────
 * Once accepted, these rows have been copied into `user_grants` and are dead
 * weight: editing them would change nothing and would quietly disagree with
 * the person's real permissions. An accepted invite redirects to the user's
 * own permissions screen, which is the live one.
 */
import { redirect, notFound } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { loadConfig } from '@/lib/records/config';
import { inviteGrantMatrix } from '@/lib/records/adminGrants';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { OutlineChip } from '@/proto/ui/kit';
import { GrantMatrix, MatrixBackLink, type GrantWriter } from '../../../../GrantMatrix';
import { ModuleScopePicker } from '../../../../ModuleScopePicker';
import { setInviteGrantAction, clearInviteGrantAction, setInviteGrantsAction } from '../../../actions';

export default async function InvitePermissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ inviteId: string }>;
  searchParams: Promise<{ module?: string }>;
}) {
  const { inviteId } = await params;
  const { module: moduleParam } = await searchParams;

  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  const config = await loadConfig();
  // Validated against the real module list, never trusted from the URL — a
  // mistyped link must not silently write a per-module grant nobody intended.
  const activeModuleId = config.modules.some((m) => m.id === moduleParam) ? moduleParam! : null;

  /*
   * An invite that has already been accepted has a real user behind it, and
   * THAT is where permissions live from then on. Sending the admin there
   * beats letting them edit rows nothing will ever read again.
   */
  const { data: invite } = await supabaseAdmin()
    .from('invites')
    .select('status, email')
    .eq('id', inviteId)
    .maybeSingle();
  if (!invite) notFound();
  if (invite.status === 'accepted') {
    const { data: profile } = await supabaseAdmin()
      .from('profiles')
      .select('id')
      .eq('email', invite.email as string)
      .maybeSingle();
    redirect(profile ? `/admin/users/${profile.id}/permissions` : '/admin/users');
  }

  const matrix = await inviteGrantMatrix(ctx, inviteId, activeModuleId);
  if (!matrix || matrix.subject.kind !== 'user') notFound();
  const { subject } = matrix;

  // Bound to this invite here, so the matrix never carries an id the client
  // could send back changed — the same reason the user screen binds its own.
  const writer: GrantWriter = {
    column: 'user',
    set: async (scopeKind, scopeId, level) => {
      'use server';
      return setInviteGrantAction(inviteId, scopeKind, scopeId, level, activeModuleId);
    },
    clear: async (scopeKind, scopeId) => {
      'use server';
      return clearInviteGrantAction(inviteId, scopeKind, scopeId, activeModuleId);
    },
    setMany: async (items) => {
      'use server';
      return setInviteGrantsAction(inviteId, items, activeModuleId);
    },
  };

  return (
    <div className="space-y-5 p-6">
      <div className="space-y-2">
        <MatrixBackLink href="/admin/users" label="All users" />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-ink-900">{subject.label}</h1>
          <OutlineChip tone="warn">Invite pending</OutlineChip>
          <OutlineChip tone={subject.templateLabel ? 'brand' : 'neutral'}>
            {subject.permissionLabel}
          </OutlineChip>
          <OutlineChip>{subject.roleName}</OutlineChip>
        </div>
        <p className="text-[13px] text-ink-500">
          Set now, applied the moment they finish signing up — in the same step that creates their
          account, so there is never a window where they are live with only the template.
          {subject.templateLabel ? (
            <>
              {' '}
              The <strong className="font-medium text-ink-700">{subject.templateLabel}</strong>{' '}
              template supplies the starting value for every row; anything changed here overrides it
              for this person alone.
            </>
          ) : (
            <>
              {' '}
              No template was chosen, so every row starts at <strong className="font-medium text-ink-700">Edit</strong>{' '}
              — the documented default for an unset scope. Anything set here is a personal override.
            </>
          )}
        </p>
      </div>

      <ModuleScopePicker
        modules={config.modules
          .filter((m) => !m.adminOnly)
          .map((m) => ({ id: m.id, label: m.label }))}
        activeModuleId={activeModuleId}
        basePath={`/admin/users/invites/${inviteId}/permissions`}
      />

      <GrantMatrix matrix={matrix} writer={writer} />
    </div>
  );
}
