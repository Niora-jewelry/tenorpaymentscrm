/**
 * /email/rules/<mailboxId> — Outlook's rules for one mailbox.
 *
 * Any mailbox the person can see (RLS) can be read; changing rules needs
 * the Email Edit grant. Under "sign in as" the screen is not shown at all:
 * rules are mailbox content, and impersonation sees health only.
 */
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { emailAccess } from '@/lib/mail/access';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { rulesAction } from '../ruleActions';
import { RulesHeader, RulesManager } from '../RulesManager';

export default async function RulesPage({ params }: { params: Promise<{ mailboxId: string }> }) {
  const ctx = await authorize();
  const access = await emailAccess(ctx);
  if (access === 'hidden') redirect('/dashboard');
  if (await currentImpersonation()) redirect('/email');

  const { mailboxId } = await params;
  if (!z.uuid().safeParse(mailboxId).success) notFound();
  const supabase = await createSupabaseServerClient();
  const { data: mb } = await supabase.from('mail_mailboxes').select('id, address, kind').eq('id', mailboxId).maybeSingle();
  if (!mb) notFound();

  const snap = await rulesAction({ mailboxId });
  return (
    <div className="mx-auto max-w-[920px] space-y-6 p-6">
      <RulesHeader address={mb.address as string} kind={mb.kind as 'personal' | 'shared'} />
      {snap.ok ? (
        <RulesManager mailboxId={mailboxId} address={mb.address as string} initial={snap.data} canEdit={access === 'edit'} />
      ) : (
        <p role="alert" className="rounded-lg border border-[#f7cfd1] bg-[#fce9ea] px-3.5 py-2.5 text-[13px] font-medium text-[#b02a30]">
          {snap.message}
        </p>
      )}
    </div>
  );
}
