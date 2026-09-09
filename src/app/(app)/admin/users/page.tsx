/**
 * Admin → Users. Real data throughout — `listUsers` reads live `profiles`/
 * `roles`/`user_templates`/`permission_templates`/`user_grants`, not the
 * prototype's `i % 4` fabricated badges. Invite/pause/resume/assign-template
 * are real writes (`./actions.ts`), gated the same way `/admin/recycle-bin`
 * is: `authorize()` then `redirect` if not admin, checked again inside every
 * action independently.
 *
 * Deliberately does not include a template GRANT editor (creating/editing a
 * template's own per-field Hidden/View/Edit matrix) — that's a separate,
 * larger UI, scoped out of this pass on purpose so this one ships and is
 * verified on its own first.
 */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { listUsers, listRoles, listInvites, sweepExpiredInvites } from '@/lib/records/adminUsers';
import { listTemplates } from '@/lib/records/adminTemplates';
import { UsersTable } from './UsersTable';
import { InviteUserDialog } from './InviteUserDialog';
import { InvitesTable } from './InvitesTable';

export default async function AdminUsersPage() {
  const ctx = await authorize();
  if (!ctx.isAdmin) redirect('/dashboard');

  /*
   * The expiry sweep runs BEFORE the list is read, not alongside it.
   *
   * `expire_stale_invites()` flips past-due pending rows to 'expired', and the
   * list below renders the status column. Running both in one `Promise.all`
   * would race: the read could land first and show a row as pending that the
   * sweep is in the middle of expiring. It is one statement against a table of
   * a few dozen rows, so the extra wave costs nothing worth measuring.
   */
  await sweepExpiredInvites(ctx);

  const [users, roles, templates, invites] = await Promise.all([
    listUsers(ctx),
    listRoles(ctx),
    listTemplates(ctx),
    listInvites(ctx),
  ]);
  const pendingInvites = invites.filter((i) => i.status === 'pending').length;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Users</h1>
          <p className="text-[13px] text-ink-500">
            {users.length} account{users.length === 1 ? '' : 's'}
            {pendingInvites ? ` · ${pendingInvites} invite${pendingInvites === 1 ? '' : 's'} outstanding` : ''}
          </p>
        </div>
        <InviteUserDialog roles={roles} />
      </div>

      <UsersTable users={users} templates={templates} currentUserId={ctx.userId} />

      {/* Invites sit under the accounts they will become. Login spec §2 makes
          them a distinct object with their own lifecycle — pending, accepted,
          revoked, expired — so they get their own table rather than being
          folded into the user list as ghost rows. */}
      <div className="mt-5">
        <InvitesTable invites={invites} />
      </div>
    </div>
  );
}
