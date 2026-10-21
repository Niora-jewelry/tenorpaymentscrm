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
import { refreshFolderTree } from '@/lib/mail/sync/folders';
import { actingFor } from '@/lib/mail/acting';
import { GraphError } from '@/lib/mail/graph/transport';
import { messageFor } from '@/lib/mail/messages';
import { supabaseAdmin } from '@/lib/supabase/admin';
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

/**
 * "Load older mail": the 30 days before what this folder holds, fetched from
 * Outlook now. A read, so View is enough; limited per mailbox (6 an hour).
 */
export async function loadOlderAction(input: { folderId: string }): Promise<Read<{ queued: boolean; retryAfterSeconds?: number }>> {
  const parsed = z.object({ folderId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: true, data: { queued: false } };
  return guarded(async () => {
    const supabase = await createSupabaseServerClient();
    // RLS read: a folder of a mailbox this person can see.
    const { data: f } = await supabase.from('mail_folders').select('id, mailbox_id').eq('id', parsed.data.folderId).is('deleted_at', null).maybeSingle();
    if (!f) return { queued: false };
    const limit = await rateLimit(`mail_backfill:mailbox:${f.mailbox_id}`, RATE_LIMITS.mailBackfillPerMailbox);
    if (!limit.allowed) return { queued: false, retryAfterSeconds: limit.retryAfterSeconds };
    await supabaseAdmin().rpc('mail_enqueue', { p_mailbox_id: f.mailbox_id, p_kind: 'load_older', p_target: f.id, p_priority: 2 });
    after(() => drainSoon([f.mailbox_id as string], 45_000));
    return { queued: true };
  }, 'load_older');
}

// ─────────────────────────────────────────────────────────────────────────
// Changing mail
//
// Edit grant required. Each change is applied locally at once by
// mail_op_submit (the RLS-checked boundary) and carried to Outlook by the
// engine, which this kicks immediately rather than waiting for the cron.
// ─────────────────────────────────────────────────────────────────────────

type Write<T> = { ok: true; data: T } | { ok: false; message: string };

async function writeGate(): Promise<{ ctx: Awaited<ReturnType<typeof authorize>> } | { message: string }> {
  const ctx = await authorize();
  if (await currentImpersonation()) return { message: MAIL_MESSAGES.impersonating };
  try {
    await requireEmailAccess(ctx, 'edit');
  } catch (e) {
    if (e instanceof EmailAccessError) return { message: e.message };
    throw e;
  }
  const limit = await rateLimit(userKey('mail_action', ctx.userId), RATE_LIMITS.mailActionPerUser);
  if (!limit.allowed) return { message: MAIL_MESSAGES.busy(limit.retryAfterSeconds) };
  return { ctx };
}

const ConversationOp = z.object({
  items: z.array(z.object({ mailboxId: z.uuid(), key: z.string().min(1).max(600) })).min(1).max(200),
  /** Messages in these folders (the view the person is in). Empty = the whole conversation. */
  scopeFolderIds: Ids(40),
  op: z.enum(['read', 'unread', 'archive', 'delete', 'purge', 'junk', 'not_junk', 'move']),
  destFolderId: z.uuid().optional(),
  requestId: z.uuid(),
});

const DEST_WELL_KNOWN: Partial<Record<z.infer<typeof ConversationOp>['op'], string>> = {
  archive: 'archive',
  delete: 'deleteditems',
  junk: 'junkemail',
  not_junk: 'inbox',
};

const NO_FOLDER: Record<string, string> = {
  archive: 'This mailbox has no Archive folder in Outlook yet.',
  deleteditems: 'This mailbox has no Deleted Items folder.',
  junkemail: 'This mailbox has no Junk Email folder.',
  inbox: 'This mailbox has no Inbox.',
};

/** Read, unread, archive, delete, junk, not junk, move, or delete permanently — for whole conversations. */
export async function conversationOpAction(input: z.input<typeof ConversationOp>): Promise<Write<{ changed: number }>> {
  const parsed = ConversationOp.safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await writeGate();
  if ('message' in g) return { ok: false, message: g.message };
  const { items, scopeFolderIds, op, destFolderId, requestId } = parsed.data;
  if (op === 'move' && !destFolderId) return { ok: false, message: 'Choose a folder to move to.' };

  const supabase = await createSupabaseServerClient();
  const byMailbox = new Map<string, string[]>();
  for (const it of items) byMailbox.set(it.mailboxId, [...(byMailbox.get(it.mailboxId) ?? []), it.key]);

  let changed = 0;
  const touched: string[] = [];
  try {
    for (const [mailboxId, keys] of byMailbox) {
      const convIds = keys.filter((k) => !k.startsWith('msg:'));
      const msgIds = keys
        .filter((k) => k.startsWith('msg:'))
        .map((k) => k.slice(4))
        .filter((id) => z.uuid().safeParse(id).success);
      // The RLS read: only messages this person can see, in this mailbox.
      const found: Array<{ graph_id: string; folder_id: string | null; is_read: boolean }> = [];
      if (convIds.length) {
        const { data, error } = await supabase
          .from('mail_messages')
          .select('graph_id, folder_id, is_read')
          .eq('mailbox_id', mailboxId)
          .in('conversation_id', convIds);
        if (error) throw new Error(`messages read failed: ${error.code ?? 'db'}`);
        found.push(...((data ?? []) as typeof found));
      }
      if (msgIds.length) {
        const { data, error } = await supabase
          .from('mail_messages')
          .select('graph_id, folder_id, is_read')
          .eq('mailbox_id', mailboxId)
          .in('id', msgIds);
        if (error) throw new Error(`messages read failed: ${error.code ?? 'db'}`);
        found.push(...((data ?? []) as typeof found));
      }

      const scoped = found.filter(
        (r) => op === 'read' || op === 'unread' || scopeFolderIds.length === 0 || (r.folder_id !== null && scopeFolderIds.includes(r.folder_id)),
      );
      const targets = scoped.filter((r) => (op === 'read' ? !r.is_read : op === 'unread' ? r.is_read : true)).map((r) => r.graph_id);
      if (targets.length === 0) continue;

      let kind: 'mark_read' | 'mark_unread' | 'move' | 'hard_delete';
      let dest: string | null = null;
      if (op === 'read' || op === 'unread') kind = op === 'read' ? 'mark_read' : 'mark_unread';
      else if (op === 'purge') kind = 'hard_delete';
      else {
        kind = 'move';
        if (op === 'move') dest = destFolderId!;
        else {
          const wk = DEST_WELL_KNOWN[op]!;
          const { data: f } = await supabase.from('mail_folders').select('id').eq('mailbox_id', mailboxId).eq('well_known', wk).maybeSingle();
          if (!f) return { ok: false, message: NO_FOLDER[wk] };
          dest = f.id as string;
        }
      }

      for (let i = 0; i < targets.length; i += 500) {
        const { error: opErr } = await supabase.rpc('mail_op_submit', {
          p_mailbox_id: mailboxId,
          p_kind: kind,
          p_graph_ids: targets.slice(i, i + 500),
          p_dest_folder_id: dest,
          p_request_id: requestId,
        });
        if (opErr) {
          mailLog('warn', 'actions', 'op_submit_failed', { code: opErr.code });
          return { ok: false, message: opErr.code === 'P0001' ? MAIL_MESSAGES.reconnect('this mailbox') : MAIL_MESSAGES.generic };
        }
      }
      changed += targets.length;
      touched.push(mailboxId);
    }
  } catch (e) {
    mailLog('error', 'actions', 'conversation_op_failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    return { ok: false, message: MAIL_MESSAGES.generic };
  }
  if (touched.length) after(() => drainSoon(touched));
  return { ok: true, data: { changed } };
}

const PinInput = z.object({ mailboxId: z.uuid(), folderId: z.uuid(), key: z.string().min(1).max(512), pinned: z.boolean() });

/** Pins live in TapDash only (Outlook has no pin), per mailbox folder. */
export async function pinAction(input: z.input<typeof PinInput>): Promise<Write<null>> {
  const parsed = PinInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await writeGate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('mail_set_pin', {
    p_mailbox_id: parsed.data.mailboxId,
    p_folder_id: parsed.data.folderId,
    p_conversation_id: parsed.data.key,
    p_pinned: parsed.data.pinned,
  });
  if (error) return { ok: false, message: MAIL_MESSAGES.generic };
  await supabaseAdmin().rpc('mail_bump_seq', { p_mailbox_id: parsed.data.mailboxId });
  return { ok: true, data: null };
}

const FolderInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), mailboxId: z.uuid(), parentId: z.uuid().nullable(), name: z.string().trim().min(1).max(255) }),
  z.object({ op: z.literal('rename'), mailboxId: z.uuid(), folderId: z.uuid(), name: z.string().trim().min(1).max(255) }),
  z.object({ op: z.literal('delete'), mailboxId: z.uuid(), folderId: z.uuid() }),
]);

const MAX_FOLDERS = 500;

/**
 * Folder changes go to Outlook FIRST and the tree is re-read after — a
 * folder's id only exists once Microsoft has made it, and these are rare
 * enough that a one-second wait beats a placeholder that might never become
 * real. Deleting moves the folder to Deleted Items, as Outlook does; a
 * folder already there is deleted for good.
 */
export async function folderAction(input: z.input<typeof FolderInput>): Promise<Write<null>> {
  const parsed = FolderInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Folder names need 1 to 255 characters.' };
  const g = await writeGate();
  if ('message' in g) return { ok: false, message: g.message };
  const p = parsed.data;
  if ('name' in p && /[\\/]/.test(p.name)) return { ok: false, message: 'Folder names can’t contain / or \\.' };

  const supabase = await createSupabaseServerClient();
  const { data: folders } = await supabase
    .from('mail_folders')
    .select('id, graph_id, parent_folder_id, well_known, display_name')
    .eq('mailbox_id', p.mailboxId);
  if (!folders?.length) return { ok: false, message: 'That mailbox is not available.' };
  const byId = new Map(folders.map((f) => [f.id as string, f]));

  const acting = await actingFor(g.ctx, p.mailboxId);
  if (!acting) return { ok: false, message: MAIL_MESSAGES.reconnect('this mailbox') };

  try {
    if (p.op === 'create') {
      if (folders.length >= MAX_FOLDERS) return { ok: false, message: MAIL_MESSAGES.folderCap };
      const parent = p.parentId ? byId.get(p.parentId) : null;
      if (p.parentId && !parent) return { ok: false, message: 'That folder no longer exists.' };
      await acting.graph.request({
        method: 'POST',
        path: parent ? `${acting.root}/mailFolders/${encodeURIComponent(parent.graph_id as string)}/childFolders` : `${acting.root}/mailFolders`,
        body: { displayName: p.name },
      });
    } else {
      const folder = byId.get(p.folderId);
      if (!folder) return { ok: false, message: 'That folder no longer exists.' };
      if (folder.well_known) {
        return { ok: false, message: `${folder.display_name} is an Outlook system folder and can’t be ${p.op === 'rename' ? 'renamed' : 'deleted'}.` };
      }
      const path = `${acting.root}/mailFolders/${encodeURIComponent(folder.graph_id as string)}`;
      if (p.op === 'rename') {
        await acting.graph.request({ method: 'PATCH', path, body: { displayName: p.name } });
      } else {
        // Inside Deleted Items already? Then this is the permanent delete.
        let cur = folder.parent_folder_id ? byId.get(folder.parent_folder_id as string) : undefined;
        let inBin = false;
        for (let i = 0; cur && i < 32; i += 1) {
          if (cur.well_known === 'deleteditems') inBin = true;
          cur = cur.parent_folder_id ? byId.get(cur.parent_folder_id as string) : undefined;
        }
        if (inBin) await acting.graph.request({ method: 'DELETE', path });
        else await acting.graph.request({ method: 'POST', path: `${path}/move`, body: { destinationId: 'deleteditems' } });
      }
    }
  } catch (e) {
    if (e instanceof GraphError) {
      if (e.classified.code === 'conflict') return { ok: false, message: MAIL_MESSAGES.folderExists };
      return { ok: false, message: messageFor(e.classified.code, { retryAfter: e.classified.retryAfterSeconds }) };
    }
    throw e;
  }

  try {
    await refreshFolderTree(p.mailboxId, acting.graph);
  } catch {
    after(() => drainSoon([p.mailboxId]));
  }
  await supabaseAdmin().rpc('mail_bump_seq', { p_mailbox_id: p.mailboxId });
  return { ok: true, data: null };
}

export async function dismissNoticeAction(input: { id: string }): Promise<Write<null>> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: true, data: null };
  const g = await readGate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  await supabase.rpc('mail_dismiss_notice', { p_notice_id: parsed.data.id });
  return { ok: true, data: null };
}
