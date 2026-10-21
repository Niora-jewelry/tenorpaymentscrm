/**
 * /email/settings — the mailboxes this person has connected, and connecting
 * more. Later phases add undo-send, signatures and templates here.
 *
 * Under "sign in as", the list renders read-only: an admin may look at
 * whether someone's mailboxes are healthy, never act in them (the OAuth
 * routes and the actions refuse independently of this page).
 */
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { emailAccess } from '@/lib/mail/access';
import { myMailboxes, MAX_CONNECTIONS } from '@/lib/mail/mailboxes';
import { connectErrorMessage, isConnectErrorCode } from '@/lib/mail/messages';
import { MailboxSettings, type Banner, type JustConnected } from './MailboxSettings';
import { SettingsNav } from './SettingsNav';
import { ComposeSettings } from './ComposeSettings';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { templatesAction } from '../composeActions';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const asEmail = (v: string | undefined) => (v && z.email().max(254).safeParse(v).success ? v : undefined);

export default async function EmailSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await authorize();
  const access = await emailAccess(ctx);
  if (access === 'hidden') redirect('/dashboard');

  const [impersonating, mailboxes, sp] = await Promise.all([currentImpersonation(), myMailboxes(ctx), searchParams]);

  let banner: Banner | null = null;
  let justConnected: JustConnected | null = null;
  const err = first(sp.mail_error);
  const connected = first(sp.connected);
  if (isConnectErrorCode(err)) {
    banner = { tone: 'error', text: connectErrorMessage(err, { shared: asEmail(first(sp.shared)), isAdmin: ctx.isAdmin }) };
  } else if (connected) {
    // The id is only a pointer: it must be one of this person's own connections.
    const mb = mailboxes.find((m) => m.mailboxId === connected);
    if (mb) justConnected = { mailboxId: mb.mailboxId, reconnected: first(sp.reconnected) === '1', degraded: first(sp.degraded) === '1' };
  }
  const writing = !impersonating && access === 'edit';

  return (
    <div className="mx-auto max-w-[1120px] p-6 lg:p-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-.01em] text-ink-900">Email settings</h1>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-ink-500">
            Mailboxes sync both ways with Outlook. Disconnecting stops the sync; nothing in Outlook is changed.
          </p>
        </div>
        <Link
          href="/email"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink-700 hover:border-ink-400 hover:bg-canvas"
        >
          <Icon name="mail" size={14} /> Open Email
        </Link>
      </div>

      <div className="grid gap-8 lg:grid-cols-[190px_minmax(0,1fr)]">
        <SettingsNav
          sections={[
            { id: 'mailboxes', label: 'Mailboxes', icon: 'inbox' },
            ...(impersonating ? [] : [{ id: 'connect', label: 'Connect', icon: 'plus' as const }]),
            ...(writing
              ? [
                  { id: 'sending', label: 'Sending', icon: 'send' as const },
                  { id: 'signatures', label: 'Signatures', icon: 'pencil' as const },
                  { id: 'templates', label: 'Templates', icon: 'file-text' as const },
                  ...(ctx.isAdmin ? [{ id: 'privacy', label: 'Privacy', icon: 'lock' as const }] : []),
                ]
              : []),
          ]}
        />
        <div className="min-w-0 space-y-10 pb-[30vh]">
          <MailboxSettings
            mailboxes={mailboxes}
            max={MAX_CONNECTIONS}
            readOnly={Boolean(impersonating)}
            banner={banner}
            justConnected={justConnected}
          />
          {writing ? await writingSettings(ctx.userId, ctx.isAdmin, mailboxes) : null}
        </div>
      </div>
    </div>
  );
}

/** Undo window, signatures and templates — only for people who can write mail. */
async function writingSettings(userId: string, isAdmin: boolean, mailboxes: Array<{ mailboxId: string; address: string }>) {
  const supabase = await createSupabaseServerClient();
  const [{ data: settings }, { data: sigs }, templates] = await Promise.all([
    supabase.from('mail_user_settings').select('undo_send_seconds, hide_my_mailboxes_from_admins').eq('user_id', userId).maybeSingle(),
    mailboxes.length
      ? supabase.from('mail_signatures').select('mailbox_id, body_html').in('mailbox_id', mailboxes.map((m) => m.mailboxId))
      : Promise.resolve({ data: [] as Array<{ mailbox_id: string; body_html: string }> }),
    templatesAction(),
  ]);
  const byBox = new Map((sigs ?? []).map((s) => [s.mailbox_id as string, s.body_html as string]));
  return (
    <ComposeSettings
      undoSeconds={Number(settings?.undo_send_seconds ?? 5)}
      signatures={mailboxes.map((m) => ({ mailboxId: m.mailboxId, address: m.address, html: byBox.get(m.mailboxId) ?? '' }))}
      templates={templates.ok ? templates.data : []}
      isAdmin={isAdmin}
      hideFromAdmins={Boolean(settings?.hide_my_mailboxes_from_admins)}
    />
  );
}
