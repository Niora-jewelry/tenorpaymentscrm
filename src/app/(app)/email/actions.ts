'use server';

/**
 * Email module server actions.
 *
 * Every action: `authorize()` → refuse under impersonation → the Email
 * access gate → zod → rate limit → a SECURITY DEFINER RPC that re-checks
 * ownership against `auth.uid()` itself. The RPC is the boundary; the steps
 * before it only make the refusal friendlier and cheaper.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { MAIL_MESSAGES } from '@/lib/mail/messages';
import { mailLog } from '@/lib/mail/log';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';

export type MailActionResult = { ok: true; message?: string } | { ok: false; message: string };

const DisconnectInput = z.object({ connectionId: z.uuid() });

/** Disconnects one of MY mailbox connections. Outlook itself is not touched. */
export async function disconnectMailboxAction(input: { connectionId: string }): Promise<MailActionResult> {
  const ctx = await authorize();
  if (await currentImpersonation()) return { ok: false, message: MAIL_MESSAGES.impersonating };
  try {
    await requireEmailAccess(ctx, 'view');
  } catch (e) {
    if (e instanceof EmailAccessError) return { ok: false, message: MAIL_MESSAGES.notPermitted };
    throw e;
  }

  const parsed = DisconnectInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };

  const limit = await rateLimit(userKey('mail_action', ctx.userId), RATE_LIMITS.mailActionPerUser);
  if (!limit.allowed) return { ok: false, message: MAIL_MESSAGES.busy(limit.retryAfterSeconds) };

  const supabase = await createSupabaseServerClient();
  const { data: conn } = await supabase
    .from('mail_connections')
    .select('id, mail_mailboxes(address)')
    .eq('id', parsed.data.connectionId)
    .eq('user_id', ctx.userId)
    .is('disconnected_at', null)
    .maybeSingle<{ id: string; mail_mailboxes: { address: string } | null }>();
  if (!conn) return { ok: false, message: 'That mailbox is not connected.' };

  const { error } = await supabase.rpc('mail_disconnect_mailbox', { p_connection_id: conn.id });
  if (error) {
    mailLog('warn', 'actions', 'disconnect_failed', { code: error.code });
    return { ok: false, message: error.code === '42501' ? 'That mailbox is not connected.' : MAIL_MESSAGES.generic };
  }

  revalidatePath('/email', 'layout');
  return { ok: true, message: MAIL_MESSAGES.disconnected(conn.mail_mailboxes?.address ?? 'the mailbox') };
}
