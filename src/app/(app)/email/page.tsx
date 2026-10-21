/**
 * /email — the Email module: folders, conversations, reading pane.
 *
 * Gated by the `communication/email` subtab grant (`lib/mail/access.ts`) and
 * by the module being configured; without both it does not exist.
 *
 * The first list page is rendered on the server so the page paints with
 * mail in it; everything after that is the client shell talking to server
 * actions. Under "sign in as", only mailbox HEALTH is shown — never a
 * subject, sender or body of someone else's mail.
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { authorize } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { emailAccess } from '@/lib/mail/access';
import { listConversations, loadMailboxes } from '@/lib/mail/read';
import { MAIL_MESSAGES } from '@/lib/mail/messages';
import { Icon } from '@/proto/ui/icons';
import type { MailboxView } from '@/lib/mail/viewTypes';
import { EmailShell } from './ui/EmailShell';
import { folderIdsFor, parseOpen, resolveSelection } from './ui/selection';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function EmailPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await authorize();
  const access = await emailAccess(ctx);
  if (access === 'hidden') redirect('/dashboard');

  const [impersonating, mailboxes, sp] = await Promise.all([currentImpersonation(), loadMailboxes(ctx), searchParams]);

  if (impersonating) return <HealthView mailboxes={mailboxes.filter((m) => m.own)} />;
  if (mailboxes.length === 0) return <FirstRun />;

  const selection = resolveSelection(first(sp.f), mailboxes);
  let initialPage = null;
  try {
    initialPage = await listConversations(ctx, folderIdsFor(selection, mailboxes), null);
  } catch {
    // The shell shows its retry state.
  }

  return (
    <div className="h-full">
      <EmailShell
        initialMailboxes={mailboxes}
        initialSelection={selection}
        initialPage={initialPage}
        initialOpen={parseOpen(first(sp.c))}
        canEdit={access === 'edit'}
      />
    </div>
  );
}

function FirstRun() {
  return (
    <div className="grid h-full place-items-center bg-canvas px-6">
      <div className="w-full max-w-[460px] rounded-2xl border border-line bg-white p-8 shadow-[0_1px_3px_rgba(8,32,47,.05)]">
        <span className="grid size-11 place-items-center rounded-xl bg-brand-50 text-brand-700">
          <Icon name="mail" size={20} />
        </span>
        <h1 className="mt-5 text-[19px] font-semibold tracking-[-.01em] text-ink-900">Bring your Outlook mail into TapDash</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
          Connect your Microsoft 365 mailbox and it stays in sync both ways: read, file and answer mail here, and Outlook
          shows the same thing.
        </p>
        <ul className="mt-5 space-y-2 text-[13px] text-ink-600">
          {[
            'Your folders, exactly as they are in Outlook',
            'Shared mailboxes you already have access to',
            'Nothing is sent or changed until you do it',
          ].map((t) => (
            <li key={t} className="flex items-start gap-2">
              <Icon name="check" size={14} className="mt-[3px] shrink-0 text-brand-600" />
              {t}
            </li>
          ))}
        </ul>
        <Link
          href="/email/settings"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] transition-colors hover:bg-accent-dim"
        >
          Connect a mailbox
          <Icon name="arrow-right" size={15} />
        </Link>
      </div>
    </div>
  );
}

const HEALTH_LABEL: Record<MailboxView['health'], string> = {
  ok: 'Syncing',
  setting_up: 'Setting up',
  needs_reconnect: 'Needs reconnect',
  needs_permission: 'Needs permission',
  stalled: 'Stopped syncing',
  throttled: 'Outlook busy',
};

/** "Sign in as": whether this person's mail is healthy — never what is in it. */
function HealthView({ mailboxes }: { mailboxes: MailboxView[] }) {
  return (
    <div className="mx-auto max-w-[760px] space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Email</h1>
        <p className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-500">
          <Icon name="eye-off" size={14} />
          {MAIL_MESSAGES.impersonating} Mailbox health is shown below.
        </p>
      </div>
      {mailboxes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-white px-5 py-8 text-center text-[13px] text-ink-400">
          No mailboxes connected.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
          {mailboxes.map((m) => {
            const inbox = m.folders.find((f) => f.wellKnown === 'inbox');
            return (
              <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold text-ink-900">{m.address}</p>
                  <p className="text-[12px] text-ink-400">
                    {m.kind === 'shared' ? 'Shared · ' : ''}
                    {m.folders.length} folders{inbox ? ` · ${inbox.unread} unread in Inbox` : ''}
                  </p>
                </div>
                <span className="text-[12px] font-semibold text-ink-600">{HEALTH_LABEL[m.health]}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
