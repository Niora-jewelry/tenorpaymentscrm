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
import { after } from 'next/server';
import {
  listConversations,
  loadConversation,
  loadMailboxes,
  loadMessageBody,
  searchConversations,
  syncState,
} from '@/lib/mail/read';
import { drainSoon } from '@/lib/mail/sync/notify';
import type { ConversationRow, ListPage, MailboxView, MessageBody, MessageView, SyncState } from '@/lib/mail/viewTypes';

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

// ─────────────────────────────────────────────────────────────────────────
// Reading
//
// Every read goes through the same gate, then through the request-scoped
// client, so RLS (mail_visible_mailbox_ids) decides what exists. Ids the
// browser sends are only ever filters on top of that — naming a folder you
// cannot see returns nothing, not an error that confirms it exists.
// ─────────────────────────────────────────────────────────────────────────

type Read<T> = { ok: true; data: T } | { ok: false; message: string };

async function readGate(): Promise<{ ctx: Awaited<ReturnType<typeof authorize>> } | { message: string }> {
  const ctx = await authorize();
  if (await currentImpersonation()) return { message: MAIL_MESSAGES.impersonating };
  try {
    await requireEmailAccess(ctx, 'view');
  } catch (e) {
    if (e instanceof EmailAccessError) return { message: MAIL_MESSAGES.notPermitted };
    throw e;
  }
  return { ctx };
}

async function guarded<T>(fn: (ctx: Awaited<ReturnType<typeof authorize>>) => Promise<T>, area: string): Promise<Read<T>> {
  const g = await readGate();
  if ('message' in g) return { ok: false, message: g.message };
  try {
    return { ok: true, data: await fn(g.ctx) };
  } catch (e) {
    mailLog('error', 'actions', `${area}_failed`, { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    return { ok: false, message: MAIL_MESSAGES.generic };
  }
}

const Ids = (max: number) => z.array(z.uuid()).max(max);
const ListInput = z.object({
  folderIds: Ids(40).min(1),
  cursor: z.object({ at: z.string().max(40), key: z.string().min(1).max(600) }).nullable(),
  unreadOnly: z.boolean().optional(),
  withAttachments: z.boolean().optional(),
});

export async function listConversationsAction(input: z.input<typeof ListInput>): Promise<Read<ListPage>> {
  const parsed = ListInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  return guarded((ctx) => listConversations(ctx, parsed.data.folderIds, parsed.data.cursor, parsed.data), 'list');
}

const SearchInput = z.object({
  q: z.string().trim().min(1).max(200),
  mailboxIds: Ids(60).min(1),
  folderIds: Ids(40).nullable(),
});

export async function searchAction(input: z.input<typeof SearchInput>): Promise<Read<ConversationRow[]>> {
  const parsed = SearchInput.safeParse(input);
  if (!parsed.success) return { ok: true, data: [] };
  return guarded(async (ctx) => {
    const limit = await rateLimit(userKey('mail_search', ctx.userId), RATE_LIMITS.mailSearchPerUser);
    if (!limit.allowed) throw new Error('search rate limited');
    return searchConversations(ctx, parsed.data.q, parsed.data.mailboxIds, parsed.data.folderIds);
  }, 'search');
}

const ConversationInput = z.object({ mailboxId: z.uuid(), key: z.string().min(1).max(600) });

export async function conversationAction(input: z.input<typeof ConversationInput>): Promise<Read<MessageView[]>> {
  const parsed = ConversationInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.goneMessage };
  return guarded((ctx) => loadConversation(ctx, parsed.data.mailboxId, parsed.data.key), 'conversation');
}

export async function messageBodyAction(input: { messageId: string }): Promise<Read<MessageBody | null>> {
  const parsed = z.object({ messageId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: true, data: null };
  return guarded((ctx) => loadMessageBody(ctx, parsed.data.messageId), 'body');
}

export async function syncStateAction(input: { mailboxIds: string[] }): Promise<Read<SyncState>> {
  const parsed = z.object({ mailboxIds: Ids(60) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  return guarded((ctx) => syncState(ctx, parsed.data.mailboxIds), 'sync_state');
}

export async function mailboxesAction(): Promise<Read<MailboxView[]>> {
  return guarded((ctx) => loadMailboxes(ctx), 'mailboxes');
}

/** "I opened this folder": hot for ten minutes, and fetched right now if stale. */
export async function openFolderAction(input: { folderId: string }): Promise<Read<{ syncing: boolean }>> {
  const parsed = z.object({ folderId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: true, data: { syncing: false } };
  return guarded(async () => {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('mail_touch_folder', { p_folder_id: parsed.data.folderId });
    if (error) return { syncing: false };
    if (data) after(() => drainSoon([data as string]));
    return { syncing: Boolean(data) };
  }, 'open_folder');
}
