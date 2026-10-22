/**
 * /n/<notification id> — the link in a mention email.
 *
 * Signed out, the proxy sends the person to /login and brings them back here
 * after. Signed in, this forwards to the exact item; the record page marks
 * the mention read and opened when it lands (`?n=<id>`), which is also the
 * one place the previous value is shown — opening here as well spent it a
 * step early. A phone alert has no `?n=` landing, so it is marked here. When there is
 * nowhere to go — the update was removed, the record is in the Recycle Bin,
 * or the person has since lost access — it says so instead of opening a
 * record they may not see.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { markNotifications, peekNotification } from '@/lib/records/notifications';
import { Icon } from '@/proto/ui/icons';

export const dynamic = 'force-dynamic';

export default async function NotificationLink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await authorize();
  const ok = z.uuid().safeParse(id).success;
  const n = ok ? await peekNotification(ctx, id) : null;
  if (n?.href) {
    if (!n.href.includes('&n=')) await markNotifications(ctx, [n.id], true);
    redirect(n.href);
  }

  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-6">
      <div className="w-full max-w-[420px] rounded-2xl border border-line bg-white p-8 text-center shadow-[0_1px_3px_rgba(8,32,47,.05)]">
        <span className="mx-auto mb-4 grid size-11 place-items-center rounded-full bg-canvas text-ink-400">
          <Icon name="bell" size={20} />
        </span>
        <h1 className="text-[17px] font-semibold text-ink-900">This item is no longer available.</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">
          It was removed, or you no longer have access to it. Everything else you were mentioned on is in Notifications.
        </p>
        <Link
          href="/notifications"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] hover:bg-accent-dim"
        >
          Open Notifications <Icon name="arrow-right" size={14} />
        </Link>
      </div>
    </main>
  );
}
