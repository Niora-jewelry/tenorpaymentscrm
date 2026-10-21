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
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { emailAccess } from '@/lib/mail/access';
import { myMailboxes, MAX_CONNECTIONS } from '@/lib/mail/mailboxes';
import { MAIL_MESSAGES, connectErrorMessage, isConnectErrorCode } from '@/lib/mail/messages';
import { MailboxSettings, type Banner } from './MailboxSettings';
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
  const err = first(sp.mail_error);
  const connected = first(sp.connected);
  if (isConnectErrorCode(err)) {
    banner = { tone: 'error', text: connectErrorMessage(err, { shared: asEmail(first(sp.shared)), isAdmin: ctx.isAdmin }) };
  } else if (connected) {
    // The id is only a pointer; the address shown comes from our own rows.
    const mb = mailboxes.find((m) => m.mailboxId === connected);
    if (mb) {
      banner =
        first(sp.degraded) === '1'
          ? { tone: 'warn', text: MAIL_MESSAGES.degraded }
          : { tone: 'ok', text: first(sp.reconnected) === '1' ? MAIL_MESSAGES.reconnected(mb.address) : MAIL_MESSAGES.connected(mb.address) };
    }
  }

  return (
    <div className="mx-auto max-w-[880px] space-y-6 p-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Email settings</h1>
          <p className="text-[13px] text-ink-500">
            Mailboxes sync both ways with Outlook. Disconnecting stops the sync; nothing in Outlook is changed.
          </p>
        </div>
        <Link href="/email" className="text-[13px] font-semibold text-ink-500 hover:text-ink-900">
          Back to Email
        </Link>
      </div>

      <MailboxSettings
        mailboxes={mailboxes}
        max={MAX_CONNECTIONS}
        readOnly={Boolean(impersonating)}
        banner={banner}
      />

      {!impersonating && access === 'edit' ? await writingSettings(ctx.userId, ctx.isAdmin, mailboxes) : null}
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
