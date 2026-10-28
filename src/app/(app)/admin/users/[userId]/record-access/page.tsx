/**
 * `Admin → Users → one person → Record access` — the screen for
 * `record_visibility_grants`.
 *
 * The table has existed since migration 7 and has been read by
 * `can_see_record()` since migration 1. It had ZERO references anywhere in
 * `src/`: the client's "an admin can grant User A access to User B's records"
 * was fully built in the database and completely unreachable from the product.
 * With the team-member field also having no picker, the two halves of "who can
 * see this record" were both mechanism with no UI, and every record was visible
 * to its creator and to admins and to nobody else, permanently.
 *
 * ── WHY IT IS ITS OWN ROUTE, NOT A THIRD COLUMN ON /permissions ──────────
 * The permissions matrix answers "what may this person see OF a record" —
 * Hidden/View/Edit over 148 scopes, resolved in the app layer. This answers
 * "which records exist for this person at all", resolved inside an RLS
 * predicate. Same person, same admin, genuinely different question, different
 * enforcement layer. Folding this into that matrix as another column would put
 * a row-visibility switch in a grid whose every other control is about fields,
 * which is how a mis-click becomes a data leak.
 */
import { notFound, redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { listUsers } from '@/lib/records/adminUsers';
import { listVisibilityGrants, listVisibilityPeople } from '@/lib/records/adminVisibility';
import { OutlineChip } from '@/proto/ui/kit';
import { MatrixBackLink } from '../../../GrantMatrix';
import { RecordAccessPanel } from './RecordAccessPanel';

export default async function RecordAccessPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;

  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'permissions'))) redirect('/dashboard');

  // `listUsers` rather than a one-row read: it already resolves the role and
  // admin flag this page needs, and there is no second function to keep in step
  // with it. The list is small (it is the account list) and this is an admin
  // screen, not a hot path.
  const [users, people, grants] = await Promise.all([
    listUsers(ctx),
    listVisibilityPeople(ctx),
    listVisibilityGrants(ctx, userId),
  ]);

  const subject = users.find((u) => u.id === userId);
  if (!subject) notFound();

  const name = subject.fullName ?? subject.email;

  return (
    <div className="space-y-5 p-6">
      <div className="space-y-2">
        <MatrixBackLink href="/admin/users" label="All users" />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-ink-900">{name}</h1>
          <OutlineChip>{subject.roleName}</OutlineChip>
        </div>
        <p className="text-[13px] text-ink-500">
          {subject.email} — record visibility. Separate from the{' '}
          <a href={`/admin/users/${userId}/permissions`} className="text-brand-700 hover:underline">
            Hidden/View/Edit permissions
          </a>
          , which decide what is shown of a record this person can already see.
        </p>
      </div>

      <RecordAccessPanel
        subject={{ id: subject.id, name, email: subject.email, isAdmin: subject.isAdmin }}
        people={people}
        sees={grants.sees}
        seenBy={grants.seenBy}
      />
    </div>
  );
}
