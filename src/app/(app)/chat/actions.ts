'use server';

/** Chat's changes. Each one parses, authorizes and goes through `ownIdentity`. */
import { z } from 'zod';
import { authorize, type AuthContext } from '@/lib/records/permissions';
import { TeamsError } from '@/lib/msteams/access';
import { channelMembers, deleteMessage, editMessage, finishUpload, markRead, newChannel, newChat, newTeam, sendMessage, setFavorite, setThumb, startUpload } from '@/lib/msteams/chat';
import { CHAT_IMAGE_TYPES, CHAT_IMAGES_MAX_BYTES, CHAT_IMAGES_MAX_COUNT } from '@/lib/msteams/format';
import { linkPreview } from '@/lib/msteams/linkPreview';
import { findRecordsToLink, linkConversation, unlinkConversation } from '@/lib/msteams/recordLinks';
import type { ChatMember, ChatMessage, LinkPreview } from '@/lib/msteams/types';
import { rateLimit, RATE_LIMITS, userKey, type RateLimitRule } from '@/lib/security/rate-limit';

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

async function run<T>(rule: RateLimitRule, scope: string, work: (ctx: AuthContext) => Promise<T>, fallback: string): Promise<Result<T>> {
  try {
    const ctx = await authorize();
    const limit = await rateLimit(userKey(scope, ctx.userId), rule);
    if (!limit.allowed) return { ok: false, message: 'Too many at once. Wait a moment and try again.' };
    return { ok: true, data: await work(ctx) };
  } catch (e) {
    if (e instanceof TeamsError) return { ok: false, message: e.message };
    console.error('[chat] action failed', e instanceof Error ? e.name : 'unknown');
    return { ok: false, message: fallback };
  }
}

const action = RATE_LIMITS.teamsActionPerUser;
const Key = z.string().min(1).max(600);
const MessageId = z.string().min(1).max(200);
const Thread = MessageId.nullable().optional();
const Html = z.string().max(100_000);
const Emails = z.array(z.email().max(254)).max(100);
const INVALID = 'Check the details and try again.';

export async function sendMessageAction(raw: unknown): Promise<Result<ChatMessage>> {
  const p = z
    .object({
      key: Key,
      html: Html,
      replyToId: Thread,
      threadId: Thread,
      mentions: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(200) })).max(50).optional(),
      files: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(255), url: z.url().max(2048) })).max(10).optional(),
      images: z
        .array(
          z.object({
            contentType: z.enum(CHAT_IMAGE_TYPES),
            // Base64 of at most the whole message's allowance; the server checks the bytes too.
            data: z.string().min(4).max(Math.ceil((CHAT_IMAGES_MAX_BYTES * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/),
            width: z.number().int().min(1).max(20_000),
            height: z.number().int().min(1).max(20_000),
          }),
        )
        .max(CHAT_IMAGES_MAX_COUNT)
        .optional(),
    })
    .safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(RATE_LIMITS.teamsSendPerUserMinute, 'teams_send', (ctx) => sendMessage(ctx, p.data), 'The message could not be sent.');
}

export async function editMessageAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ key: Key, messageId: MessageId, threadId: Thread, html: Html }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', async (ctx) => {
    await editMessage(ctx, p.data);
    return null;
  }, 'The message could not be changed.');
}

export async function deleteMessageAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ key: Key, messageId: MessageId, threadId: Thread }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', async (ctx) => {
    await deleteMessage(ctx, p.data);
    return null;
  }, 'The message could not be deleted.');
}

export async function thumbAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ key: Key, messageId: MessageId, threadId: Thread, on: z.boolean() }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', async (ctx) => {
    await setThumb(ctx, p.data);
    return null;
  }, 'The reaction could not be saved.');
}

export async function favoriteAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ key: Key, on: z.boolean() }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', async (ctx) => {
    await setFavorite(ctx, p.data);
    return null;
  }, 'That could not be saved.');
}

export async function markReadAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ key: Key }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', async (ctx) => {
    await markRead(ctx, p.data.key);
    return null;
  }, 'That could not be saved.');
}

export async function membersAction(raw: unknown): Promise<Result<ChatMember[]>> {
  const p = z.object({ key: Key }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', (ctx) => channelMembers(ctx, p.data.key), 'The people could not be listed.');
}

export async function newChatAction(raw: unknown): Promise<Result<string>> {
  const p = z.object({ identityId: z.uuid(), emails: Emails.min(1), topic: z.string().max(200).optional() }).safeParse(raw);
  if (!p.success) return { ok: false, message: 'Pick at least one person.' };
  return run(action, 'teams_action', (ctx) => newChat(ctx, p.data), 'The chat could not be created.');
}

export async function newTeamAction(raw: unknown): Promise<Result<{ note: string | null }>> {
  const p = z.object({ identityId: z.uuid(), name: z.string().trim().min(1).max(256), description: z.string().max(1024).optional(), emails: Emails }).safeParse(raw);
  if (!p.success) return { ok: false, message: 'Give the team a name.' };
  return run(RATE_LIMITS.teamsNewTeamPerUserHour, 'teams_new_team', (ctx) => newTeam(ctx, p.data), 'The team could not be created.');
}

export async function newChannelAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ key: Key, name: z.string().trim().min(1).max(50) }).safeParse(raw);
  if (!p.success) return { ok: false, message: 'Give the channel a name.' };
  return run(action, 'teams_action', async (ctx) => {
    await newChannel(ctx, p.data);
    return null;
  }, 'The channel could not be created.');
}

export async function startUploadAction(raw: unknown): Promise<Result<string>> {
  const p = z.object({ key: Key, name: z.string().min(1).max(255) }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', (ctx) => startUpload(ctx, p.data), 'The file could not be uploaded.');
}

export async function finishUploadAction(raw: unknown): Promise<Result<{ id: string; name: string; url: string }>> {
  const p = z
    .object({ key: Key, itemId: z.string().min(1).max(300), driveId: z.string().max(300).nullable().optional(), etag: z.string().min(1).max(300), webUrl: z.url().max(2048), name: z.string().min(1).max(255), memberEmails: Emails })
    .safeParse(raw);
  if (!p.success) return { ok: false, message: 'Microsoft did not return the file properly.' };
  return run(action, 'teams_action', (ctx) => finishUpload(ctx, p.data), 'The file could not be uploaded.');
}

export async function linkPreviewAction(raw: unknown): Promise<Result<LinkPreview | null>> {
  const p = z.object({ url: z.url().max(2048) }).safeParse(raw);
  if (!p.success) return { ok: true, data: null };
  return run(RATE_LIMITS.teamsLinkPreviewPerUser, 'teams_link', () => linkPreview(p.data.url), 'No preview.');
}

/* ── Teams on a record ──────────────────────────────────────────────────── */

export async function linkChatToRecordAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ recordId: z.uuid(), key: Key }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', async (ctx) => {
    if (!(await linkConversation(ctx, p.data))) throw new TeamsError('This chat is already linked to this record.');
    return null;
  }, 'The chat could not be linked.');
}

export async function unlinkChatFromRecordAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ linkId: z.uuid() }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(action, 'teams_action', async (ctx) => {
    await unlinkConversation(ctx, p.data.linkId);
    return null;
  }, 'The chat could not be unlinked.');
}

export async function findRecordsToLinkAction(raw: unknown): Promise<Result<{ id: string; name: string }[]>> {
  const p = z.object({ q: z.string().max(80) }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(RATE_LIMITS.teamsReadPerUser, 'teams_read', (ctx) => findRecordsToLink(ctx, p.data.q), 'Records could not be searched.');
}
