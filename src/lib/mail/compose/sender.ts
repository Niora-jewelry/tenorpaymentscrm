/**
 * Who a person can send AS, and their signature — shared by the Email
 * composer and anything else that sends from the CRM through Outlook
 * (Send Application). Reads through the person's own RLS-bound client, so a
 * mailbox they did not connect is never offered.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { sanitizeOutgoing } from '@/lib/mail/content/sanitize';
import type { AuthContext } from '@/lib/records/permissions';
import type { FromOption } from '@/lib/mail/viewTypes';

/** Mailboxes this person can write from, each with its signature. */
export async function fromOptions(ctx: AuthContext): Promise<FromOption[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('mail_connections')
    .select('mailbox_id, status, mail_mailboxes(address, display_name)')
    .eq('user_id', ctx.userId)
    .is('disconnected_at', null)
    .order('connected_at')
    .returns<Array<{ mailbox_id: string; status: string; mail_mailboxes: { address: string; display_name: string } | null }>>();
  const boxes = (data ?? []).filter((c) => c.mail_mailboxes && c.status !== 'disconnected');
  const { data: sigs } = boxes.length
    ? await supabase.from('mail_signatures').select('mailbox_id, body_html').in('mailbox_id', boxes.map((b) => b.mailbox_id))
    : { data: [] };
  const sig = new Map((sigs ?? []).map((x) => [x.mailbox_id as string, x.body_html as string]));
  return boxes.map((b) => ({
    mailboxId: b.mailbox_id,
    address: b.mail_mailboxes!.address,
    displayName: b.mail_mailboxes!.display_name,
    signatureHtml: sig.get(b.mailbox_id) ?? '',
  }));
}

async function signatureFor(mailboxId: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from('mail_signatures').select('body_html').eq('mailbox_id', mailboxId).maybeSingle();
  return (data?.body_html as string | undefined) ?? '';
}

/** The person's words, then (optionally) their signature, kept apart from the editor. */
export async function withSignature(html: string, mailboxId: string, include: boolean): Promise<string> {
  const clean = sanitizeOutgoing(html);
  if (!include) return clean;
  const sig = await signatureFor(mailboxId);
  return sig ? `${clean}<br><div class="tapdash-signature">${sig}</div>` : clean;
}
