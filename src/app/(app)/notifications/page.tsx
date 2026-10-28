/**
 * /notifications — every @mention this person received in the last 90 days,
 * newest first, plus the phone alerts the bell used to hold. Any signed-in
 * person; the list is theirs alone (the RPCs are keyed on auth.uid(), and
 * admins see nobody else's).
 */
import { authorize, seesAll } from '@/lib/records/permissions';
import { listNotifications, unreadCounts } from '@/lib/records/notifications';
import { NotificationsList } from './NotificationsList';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const ctx = await authorize();
  const [first, counts, canSeeAll] = await Promise.all([
    listNotifications(ctx, 'unread', null),
    unreadCounts(ctx),
    seesAll(ctx, 'notifications'),
  ]);
  return (
    <div className="mx-auto max-w-[1000px] p-6 lg:p-8">
      <NotificationsList
        initial={first}
        initialUnread={counts.mentions + counts.phone}
        canSeeAll={canSeeAll}
        viewerId={ctx.userId}
      />
    </div>
  );
}
