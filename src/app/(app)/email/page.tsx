/**
 * /email — the Email module.
 *
 * Gated by the `communication/email` subtab grant (`lib/mail/access.ts`) and
 * by the module being configured at all; without both it does not exist.
 * The three-pane reader replaces this landing view once message sync ships;
 * until then it routes people to connect their mailboxes.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { authorize } from '@/lib/records/permissions';
import { emailAccess } from '@/lib/mail/access';
import { myMailboxes } from '@/lib/mail/mailboxes';
import { EmptyState } from '@/proto/ui/kit';

export default async function EmailPage() {
  const ctx = await authorize();
  if ((await emailAccess(ctx)) === 'hidden') redirect('/dashboard');

  const mailboxes = await myMailboxes(ctx);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-xl font-semibold text-ink-900">Email</h1>
        <Link href="/email/settings" className="text-[13px] font-semibold text-ink-500 hover:text-ink-900">
          Settings
        </Link>
      </div>
      {mailboxes.length === 0 ? (
        <EmptyState
          icon="mail"
          title="Connect your Outlook mailbox"
          body="Read, send and organise your Outlook mail here, kept in sync both ways."
          action={
            <Link
              href="/email/settings"
              className="inline-flex rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-accent-ink hover:bg-accent-dim"
            >
              Connect a mailbox
            </Link>
          }
        />
      ) : (
        <EmptyState
          icon="mail"
          title="Your mail is syncing"
          body={`${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'} connected. Manage them in settings.`}
        />
      )}
    </div>
  );
}
