/**
 * The Chat module. As with Calendar, Microsoft holds everything; a send or an edit
 * goes straight there. A failure comes back with Teams' own reason and nothing is
 * queued, so "Not sent" on screen is always true.
 */
import 'server-only';
import DOMPurify from 'isomorphic-dompurify';
import { randomUUID } from 'node:crypto';
import { htmlToText, sanitizeOutgoing } from '@/lib/mail/content/sanitize';
import { batchItemError, GraphError, type GraphTransport } from '@/lib/mail/graph/transport';
import { graphForIdentity } from '@/lib/mail/tokens';
import type { AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { teamsGranted } from '@/lib/mail/scopes';
import { dataOwner, identitiesOf, ownIdentity, readableIdentity, TeamsError, usable, type Identity } from './access';
import { chatKindOf, chatName, firstLink, guidFromEtag, isExternal, isTeamsFileUrl, isUnread, shareIdFor, THUMBS, thumbsOf, twoWeeksBefore } from './format';
import { allPages, firstStale, readThrough, reasonFrom } from './snapshots';
import type { ChatFile, ChatKind, ChatList, ChatMember, ChatMessage, ChatQuote, ChatSummary, Mention, MessagesPage, SendInput, Staleness } from './types';

/* ── where a conversation lives ───────────────────────────────────────────── */

export type ChatRef = { identityId: string; kind: 'chat'; chatId: string } | { identityId: string; kind: 'channel'; teamId: string; channelId: string };

export function parseKey(key: string): ChatRef | null {
  const parts = key.split('|');
  if (parts[0] === 'chat' && parts.length === 3 && parts[1] && parts[2]) return { identityId: parts[1], kind: 'chat', chatId: parts[2] };
  if (parts[0] === 'channel' && parts.length === 4 && parts[1] && parts[2] && parts[3]) return { identityId: parts[1], kind: 'channel', teamId: parts[2], channelId: parts[3] };
  return null;
}

const chatKey = (identityId: string, chatId: string) => `chat|${identityId}|${chatId}`;
const channelKey = (identityId: string, teamId: string, channelId: string) => `channel|${identityId}|${teamId}|${channelId}`;

const requireRef = (key: string): ChatRef => {
  const ref = parseKey(key);
  if (!ref) throw new TeamsError('That conversation could not be found.');
  return ref;
};

const e = encodeURIComponent;

function messagesPath(ref: ChatRef, threadId?: string | null, messageId?: string | null): string {
  const base = ref.kind === 'chat' ? `/chats/${e(ref.chatId)}/messages` : `/teams/${e(ref.teamId)}/channels/${e(ref.channelId)}/messages`;
  if (!threadId) return messageId ? `${base}/${e(messageId)}` : base;
  return messageId ? `${base}/${e(threadId)}/replies/${e(messageId)}` : `${base}/${e(threadId)}/replies`;
}

/* ── the chat list ────────────────────────────────────────────────────────── */

type GraphMember = { userId?: string | null; displayName?: string | null; email?: string | null; tenantId?: string | null };
type GraphChat = {
  id: string;
  topic?: string | null;
  chatType?: string;
  webUrl?: string | null;
  viewpoint?: { isHidden?: boolean; lastMessageReadDateTime?: string | null };
  members?: GraphMember[];
  lastMessagePreview?: { createdDateTime?: string; isDeleted?: boolean; body?: { content?: string; contentType?: string }; from?: { user?: { id?: string } } | null } | null;
};

const previewOf = (body: { content?: string; contentType?: string } | undefined): string => {
  const raw = body?.content ?? '';
  return (body?.contentType === 'html' ? htmlToText(raw) : raw).replace(/\s+/g, ' ').trim().slice(0, 140);
};

function summaryOfChat(c: GraphChat, identity: Identity): ChatSummary {
  const members: ChatMember[] = (c.members ?? []).map((m) => ({
    id: m.userId ?? '',
    name: m.displayName ?? m.email ?? '',
    email: m.email ?? '',
    external: isExternal(m.tenantId, identity.tenantId),
  }));
  const others = members.filter((m) => m.id !== identity.microsoftUserId);
  const last = c.lastMessagePreview;
  const lastAt = last?.createdDateTime ?? null;
  return {
    key: chatKey(identity.id, c.id),
    identityId: identity.id,
    accountEmail: identity.email,
    kind: chatKindOf(c.chatType),
    chatId: c.id,
    teamId: null,
    channelId: null,
    name: chatName(c.topic, others.map((m) => m.name)),
    teamName: null,
    members,
    memberCount: members.length,
    external: members.some((m) => m.external),
    lastAt,
    preview: last?.isDeleted ? 'Message deleted' : previewOf(last?.body),
    unread: isUnread({ lastAt, lastFromMe: last?.from?.user?.id === identity.microsoftUserId, readAt: c.viewpoint?.lastMessageReadDateTime ?? null }),
    favorite: false,
    webUrl: c.webUrl ?? null,
  };
}

type GraphTeam = { id: string; displayName?: string };
type GraphChannel = { id: string; displayName?: string; webUrl?: string | null };
type GraphPost = { createdDateTime?: string; lastModifiedDateTime?: string; body?: { content?: string; contentType?: string }; from?: { user?: { id?: string } } | null };

/** Every channel the account belongs to, each with its newest post, in one go. */
async function channelsOf(graph: GraphTransport, identity: Identity): Promise<ChatSummary[]> {
  const teams = await allPages<GraphTeam>(graph, { path: '/me/joinedTeams', query: { $select: 'id,displayName' } }, 2);
  const listed = await graph.batch(teams.map((t) => ({ path: `/teams/${e(t.id)}/channels`, query: { $select: 'id,displayName,webUrl' } })));
  const channels = teams.flatMap((t, i) => {
    const item = listed[i];
    if (!item || batchItemError(item)) return [];
    return ((item.body as { value?: GraphChannel[] } | null)?.value ?? []).map((c) => ({ team: t, channel: c }));
  });
  const newest = await graph.batch(channels.map(({ team, channel }) => ({ path: `/teams/${e(team.id)}/channels/${e(channel.id)}/messages`, query: { $top: 1 } })));
  return channels.map(({ team, channel }, i) => {
    const item = newest[i];
    const post = item && !batchItemError(item) ? (item.body as { value?: GraphPost[] } | null)?.value?.[0] : undefined;
    return {
      key: channelKey(identity.id, team.id, channel.id),
      identityId: identity.id,
      accountEmail: identity.email,
      kind: 'channel' as ChatKind,
      chatId: null,
      teamId: team.id,
      channelId: channel.id,
      name: channel.displayName ?? 'Channel',
      teamName: team.displayName ?? '',
      members: [],
      memberCount: 0,
      external: false,
      lastAt: post?.createdDateTime ?? null,
      preview: previewOf(post?.body),
      // Worked out below against this CRM's own read marks.
      unread: post?.from?.user?.id === identity.microsoftUserId,
      favorite: false,
      webUrl: channel.webUrl ?? null,
    };
  });
}

async function loadList(identity: Identity): Promise<ChatSummary[]> {
  const graph = graphForIdentity(identity.id);
  const [chats, channels] = await Promise.all([
    allPages<GraphChat>(graph, { path: '/me/chats', query: { $expand: 'members,lastMessagePreview', $top: 50, $orderby: 'lastMessagePreview/createdDateTime desc' } }, 3),
    channelsOf(graph, identity).catch((err) => {
      // Chats still work if channels are refused.
      if (err instanceof GraphError && err.status === 403) return [] as ChatSummary[];
      throw err;
    }),
  ]);
  return [...chats.filter((c) => !c.viewpoint?.isHidden).map((c) => summaryOfChat(c, identity)), ...channels];
}

/** Graph has no read state for a channel, so the CRM keeps one per account. */
async function applyChannelReads(list: ChatSummary[], identity: Identity, own: boolean): Promise<ChatSummary[]> {
  const channels = list.filter((c) => c.kind === 'channel');
  if (channels.length === 0) return list;
  const admin = supabaseAdmin();
  const { data } = await admin.from('teams_channel_reads').select('channel_key, read_at').eq('identity_id', identity.id);
  const reads = new Map((data ?? []).map((r) => [r.channel_key as string, r.read_at as string]));
  // A channel seen for the first time starts read: a whole team's history is not news.
  const fresh = channels.filter((c) => !reads.has(c.key));
  if (fresh.length > 0 && own) {
    await admin.from('teams_channel_reads').upsert(fresh.map((c) => ({ identity_id: identity.id, channel_key: c.key })), { onConflict: 'identity_id,channel_key', ignoreDuplicates: true });
  }
  return list.map((c) => {
    if (c.kind !== 'channel') return c;
    const readAt = reads.get(c.key);
    // `unread` arrives from channelsOf meaning "the newest post is mine".
    return { ...c, unread: Boolean(readAt) && isUnread({ lastAt: c.lastAt, lastFromMe: c.unread, readAt: readAt ?? null }) };
  });
}

async function withFavorites(list: ChatSummary[], identityId: string): Promise<ChatSummary[]> {
  const { data } = await supabaseAdmin().from('teams_favorites').select('chat_key').eq('identity_id', identityId);
  const favorites = new Set((data ?? []).map((f) => f.chat_key as string));
  return list.map((c) => ({ ...c, favorite: favorites.has(c.key) }));
}

const byRecent = (a: ChatSummary, b: ChatSummary) => (b.lastAt ?? '').localeCompare(a.lastAt ?? '');

export async function listForIdentity(identity: Identity, own: boolean, maxAgeMs?: number): Promise<{ chats: ChatSummary[]; stale: Staleness }> {
  if (!teamsGranted(identity.scopes)) return { chats: [], stale: null };
  const result = usable(identity)
    ? await readThrough(identity.id, 'chats', 'all', () => loadList(identity), { maxAgeMs })
    : await readThrough<ChatSummary[]>(identity.id, 'chats', 'all', async () => {
        throw new GraphError(401, { code: 'reconnect_required', reaction: 'none', connection: 'broken', detail: '' }, null);
      });
  const chats = await withFavorites(await applyChannelReads(result.data ?? [], identity, own), identity.id);
  return { chats, stale: result.stale };
}

/**
 * One conversation read directly, for a link on a record. Null means Microsoft says
 * this account is not in it; an outage throws, because "not in it" and "could not
 * ask" must never read the same on screen.
 *
 * The list cannot answer this. It stops at 150 chats and leaves out hidden ones, so
 * an old chat linked to a record would look as if its members had lost it.
 *
 * For a channel the proof is reading its messages: the basic team and channel reads
 * can succeed for someone who is not in a private channel.
 */
export async function conversationFor(
  identity: Identity,
  ref: { kind: 'chat'; chatId: string } | { kind: 'channel'; teamId: string; channelId: string },
): Promise<{ summary: ChatSummary; topic: string | null } | null> {
  const graph = graphForIdentity(identity.id);
  try {
    if (ref.kind === 'chat') {
      const c = await graph.request<GraphChat>({ path: `/chats/${e(ref.chatId)}`, query: { $expand: 'members' } });
      return c ? { summary: summaryOfChat(c, identity), topic: c.topic?.trim() || null } : null;
    }
    const base = `/teams/${e(ref.teamId)}/channels/${e(ref.channelId)}`;
    const [team, channel, posts] = await Promise.all([
      graph.request<GraphTeam>({ path: `/teams/${e(ref.teamId)}`, query: { $select: 'id,displayName' } }),
      graph.request<GraphChannel>({ path: base, query: { $select: 'id,displayName,webUrl' } }),
      graph.request<{ value?: GraphPost[] }>({ path: `${base}/messages`, query: { $top: 1 } }),
    ]);
    if (!channel) return null;
    const post = posts?.value?.[0];
    return {
      topic: null,
      summary: {
        key: channelKey(identity.id, ref.teamId, ref.channelId),
        identityId: identity.id,
        accountEmail: identity.email,
        kind: 'channel',
        chatId: null,
        teamId: ref.teamId,
        channelId: ref.channelId,
        name: channel.displayName ?? 'Channel',
        teamName: team?.displayName ?? '',
        members: [],
        memberCount: 0,
        external: false,
        lastAt: post?.createdDateTime ?? null,
        preview: previewOf(post?.body),
        unread: false,
        favorite: false,
        webUrl: channel.webUrl ?? null,
      },
    };
  } catch (err) {
    if (err instanceof GraphError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

export async function chatList(ctx: AuthContext, ownerId?: string | null): Promise<ChatList> {
  const { ownerId: who, own } = await dataOwner(ctx, 'chat', ownerId);
  const identities = await identitiesOf(who);
  const lists = await Promise.all(identities.map((i) => listForIdentity(i, own)));
  return { chats: lists.flatMap((l) => l.chats).sort(byRecent), stale: firstStale(lists.map((l) => l.stale)) };
}

/* ── messages ─────────────────────────────────────────────────────────────── */

const ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'ul', 'ol', 'li', 'p', 'br', 'div', 'span', 'blockquote', 'code', 'pre'];

/**
 * A message goes straight into the page, not into a frame as an email does, so this
 * is a short allowlist: no images (they sit behind Microsoft sign-in), no styles,
 * nothing that could reach outside the bubble.
 */
export function sanitizeChatHtml(raw: string): string {
  const prepared = raw
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, '<strong>@$1</strong>')
    .replace(/<attachment\b[^>]*>\s*<\/attachment>/gi, '')
    .replace(/<img\b[^>]*>/gi, '<em>[Image: open it in Teams]</em>')
    .replace(/<emoji\b[^>]*alt="([^"]*)"[^>]*>\s*(<\/emoji>)?/gi, '$1');
  return DOMPurify.sanitize(prepared, { ALLOWED_TAGS, ALLOWED_ATTR: ['href', 'target', 'rel'], ALLOW_DATA_ATTR: false, ALLOW_UNKNOWN_PROTOCOLS: false }) as unknown as string;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type GraphAttachment = { id?: string; contentType?: string; content?: string | null; contentUrl?: string | null; name?: string | null };
type GraphMessage = {
  id: string;
  messageType?: string;
  createdDateTime?: string;
  lastEditedDateTime?: string | null;
  deletedDateTime?: string | null;
  from?: { user?: { id?: string; displayName?: string | null } | null; application?: { displayName?: string | null } | null } | null;
  body?: { content?: string; contentType?: string };
  attachments?: GraphAttachment[];
  reactions?: { reactionType?: string; user?: { user?: { id?: string } } }[];
  replies?: GraphMessage[];
};

function quoteOf(attachments: GraphAttachment[] | undefined): ChatQuote | null {
  const ref = (attachments ?? []).find((a) => a.contentType === 'messageReference');
  if (!ref?.content) return null;
  try {
    const c = JSON.parse(ref.content) as { messageId?: string; messagePreview?: string; messageSender?: { user?: { displayName?: string } } };
    return { id: c.messageId ?? ref.id ?? '', author: c.messageSender?.user?.displayName ?? '', preview: (c.messagePreview ?? '').slice(0, 200) };
  } catch {
    return null;
  }
}

export function toMessage(m: GraphMessage, myId: string, sizes: ReadonlyMap<string, number> = new Map()): ChatMessage {
  const deleted = Boolean(m.deletedDateTime);
  const raw = m.body?.content ?? '';
  const html = deleted ? '' : m.body?.contentType === 'text' ? escapeHtml(raw).replace(/\n/g, '<br>') : sanitizeChatHtml(raw);
  const thumbs = thumbsOf(m.reactions, myId);
  const files: ChatFile[] = deleted
    ? []
    : (m.attachments ?? []).flatMap((a) => (a.contentType === 'reference' && a.contentUrl ? [{ id: a.id ?? a.contentUrl, name: a.name ?? 'File', size: sizes.get(a.contentUrl) ?? null, url: a.contentUrl }] : []));
  return {
    id: m.id,
    authorId: m.from?.user?.id ?? null,
    authorName: m.from?.user?.displayName ?? m.from?.application?.displayName ?? '',
    mine: m.from?.user?.id === myId,
    at: m.createdDateTime ?? '',
    html,
    text: deleted ? '' : htmlToText(html),
    edited: Boolean(m.lastEditedDateTime) && !deleted,
    deleted,
    system: Boolean(m.messageType) && m.messageType !== 'message',
    thumbs: thumbs.count,
    thumbedByMe: thumbs.mine,
    files,
    quote: deleted ? null : quoteOf(m.attachments),
    replies: (m.replies ?? []).map((r) => toMessage(r, myId, sizes)).sort((a, b) => a.at.localeCompare(b.at)),
    replyCount: m.replies?.length ?? 0,
    link: deleted ? null : firstLink(html),
  };
}

/** File sizes, in one batch: a message only says the name and where it lives. */
async function fileSizes(graph: GraphTransport, messages: GraphMessage[]): Promise<Map<string, number>> {
  const urls = [...new Set(messages.flatMap((m) => [...(m.attachments ?? []), ...(m.replies ?? []).flatMap((r) => r.attachments ?? [])]).flatMap((a) => (a.contentType === 'reference' && a.contentUrl ? [a.contentUrl] : [])))].slice(0, 40);
  const sizes = new Map<string, number>();
  if (urls.length === 0) return sizes;
  try {
    const answers = await graph.batch(urls.map((u) => ({ path: `/shares/${shareIdFor(u)}/driveItem`, query: { $select: 'size' } })));
    answers.forEach((a, i) => {
      const size = (a.body as { size?: unknown } | null)?.size;
      if (!batchItemError(a) && typeof size === 'number') sizes.set(urls[i]!, size);
    });
  } catch {
    // The card still shows the name, and the download still works.
  }
  return sizes;
}

/**
 * The paging cursor comes back from the browser and is then used with the account
 * owner's token, so it has to be exactly what this module handed out: a date for a
 * chat, or Graph's next-page link for THIS channel's messages. Anything else could
 * read other things from that person's account, their mail included.
 */
export function cursorIsValid(ref: ChatRef, cursor: string, graphBase: string): boolean {
  if (ref.kind === 'chat') return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(cursor) && !Number.isNaN(Date.parse(cursor));
  try {
    const url = new URL(cursor);
    const base = new URL(graphBase);
    return url.origin === base.origin && decodeURIComponent(url.pathname) === decodeURIComponent(`${base.pathname}${messagesPath(ref)}`);
  } catch {
    return false;
  }
}

/**
 * The last two weeks first. A chat can ask Graph for a date range; a channel cannot,
 * so its older pages follow Graph's own link instead.
 */
export async function messagesPage(ctx: AuthContext, args: { key: string; cursor?: string | null }): Promise<MessagesPage> {
  const ref = requireRef(args.key);
  const { identity } = await readableIdentity(ctx, 'chat', ref.identityId);
  const graph = graphForIdentity(identity.id);
  if (args.cursor && !cursorIsValid(ref, args.cursor, graph.baseUrl)) throw new TeamsError('That conversation could not be found.');
  const first = !args.cursor;

  const load = async (): Promise<{ raw: GraphMessage[]; next: string | null }> => {
    if (ref.kind === 'chat') {
      const line = args.cursor ?? twoWeeksBefore(Date.now());
      const filter = first ? `createdDateTime gt ${line}` : `createdDateTime lt ${line}`;
      const body = await graph.request<{ value?: GraphMessage[] }>({ path: messagesPath(ref), query: { $top: 50, $orderby: 'createdDateTime desc', $filter: filter } });
      const raw = body?.value ?? [];
      const oldest = raw[raw.length - 1]?.createdDateTime;
      // After the first page there is always possibly more, until a page comes back empty.
      return { raw, next: raw.length === 0 ? (first ? line : null) : (oldest ?? null) };
    }
    const body = await graph.request<{ value?: GraphMessage[]; '@odata.nextLink'?: string }>(args.cursor ? { path: args.cursor } : { path: messagesPath(ref), query: { $top: 30, $expand: 'replies' } });
    return { raw: body?.value ?? [], next: body?.['@odata.nextLink'] ?? null };
  };

  const shape = async ({ raw, next }: { raw: GraphMessage[]; next: string | null }) => {
    const sizes = await fileSizes(graph, raw);
    return { messages: raw.map((m) => toMessage(m, identity.microsoftUserId, sizes)).sort((a, b) => a.at.localeCompare(b.at)), olderCursor: next };
  };

  // Only the first page is kept: that is what an outage has to fall back on.
  const { data, stale } = await readThrough(identity.id, 'messages', first ? args.key : `${args.key}|${args.cursor}`.slice(0, 500), async () => shape(await load()), { keep: first });
  return { messages: data?.messages ?? [], olderCursor: data?.olderCursor ?? null, stale };
}

/** Marks a conversation read, for its owner only: someone looking on changes nothing. */
export async function markRead(ctx: AuthContext, key: string): Promise<void> {
  const ref = requireRef(key);
  const identity = await ownIdentity(ctx, ref.identityId);
  if (ref.kind === 'channel') {
    await supabaseAdmin().from('teams_channel_reads').upsert({ identity_id: identity.id, channel_key: key, read_at: new Date().toISOString() }, { onConflict: 'identity_id,channel_key' });
    return;
  }
  await graphForIdentity(identity.id)
    .request({ method: 'POST', path: `/chats/${e(ref.chatId)}/markChatReadForUser`, body: { user: { id: identity.microsoftUserId, tenantId: identity.tenantId } } })
    .catch((err) => {
      if (!(err instanceof GraphError)) throw err;
    });
}

/** The people an @ can name in a channel. A chat already carries its members. */
export async function channelMembers(ctx: AuthContext, key: string): Promise<ChatMember[]> {
  const ref = requireRef(key);
  if (ref.kind !== 'channel') return [];
  const { identity } = await readableIdentity(ctx, 'chat', ref.identityId);
  try {
    const list = await allPages<GraphMember>(graphForIdentity(identity.id), { path: `/teams/${e(ref.teamId)}/channels/${e(ref.channelId)}/members` }, 2);
    return list.map((m) => ({ id: m.userId ?? '', name: m.displayName ?? m.email ?? '', email: m.email ?? '', external: isExternal(m.tenantId, identity.tenantId) }));
  } catch {
    return [];
  }
}

/* ── sending ──────────────────────────────────────────────────────────────── */

/**
 * Turns "@Name" typed in the box into what Teams notifies from. A person named but
 * no longer in the text is dropped rather than notified.
 */
export function applyMentions(html: string, mentions: Mention[]): { html: string; mentions: Record<string, unknown>[] } {
  let out = html;
  const used: Record<string, unknown>[] = [];
  for (const m of mentions) {
    const token = `@${escapeHtml(m.name)}`;
    if (!out.includes(token)) continue;
    const id = used.length;
    out = out.replace(token, `<at id="${id}">${escapeHtml(m.name)}</at>`);
    used.push({ id, mentionText: m.name, mentioned: { user: { id: m.id, displayName: m.name, userIdentityType: 'aadUser' } } });
  }
  return { html: out, mentions: used };
}

export async function sendMessage(ctx: AuthContext, input: SendInput): Promise<ChatMessage> {
  const ref = requireRef(input.key);
  const identity = await ownIdentity(ctx, ref.identityId);
  const graph = graphForIdentity(identity.id);
  const clean = sanitizeOutgoing(input.html);
  const { html, mentions } = applyMentions(clean, input.mentions ?? []);
  const attachments: Record<string, unknown>[] = (input.files ?? []).map((f) => ({ id: f.id, contentType: 'reference', contentUrl: f.url, name: f.name }));
  let prefix = '';
  try {
    if (input.replyToId) {
      const quoted = await graph.request<GraphMessage>({ path: messagesPath(ref, input.threadId, input.replyToId) });
      attachments.push({
        id: input.replyToId,
        contentType: 'messageReference',
        content: JSON.stringify({
          messageId: input.replyToId,
          messagePreview: htmlToText(quoted?.body?.content ?? '').slice(0, 200),
          messageSender: { user: { id: quoted?.from?.user?.id ?? null, displayName: quoted?.from?.user?.displayName ?? null, userIdentityType: 'aadUser' } },
        }),
      });
      prefix = `<attachment id="${escapeHtml(input.replyToId)}"></attachment>`;
    }
    const files = (input.files ?? []).map((f) => `<attachment id="${escapeHtml(f.id)}"></attachment>`).join('');
    const made = await graph.request<GraphMessage>({
      method: 'POST',
      path: messagesPath(ref, input.threadId),
      body: { body: { contentType: 'html', content: `${prefix}${html}${files}` }, ...(mentions.length ? { mentions } : {}), ...(attachments.length ? { attachments } : {}) },
    });
    return toMessage(made, identity.microsoftUserId);
  } catch (err) {
    throw new TeamsError(reasonFrom(err, 'The message could not be sent.'));
  }
}

export async function editMessage(ctx: AuthContext, args: { key: string; messageId: string; threadId?: string | null; html: string }): Promise<void> {
  const ref = requireRef(args.key);
  const identity = await ownIdentity(ctx, ref.identityId);
  try {
    await graphForIdentity(identity.id).request({ method: 'PATCH', path: messagesPath(ref, args.threadId, args.messageId), body: { body: { contentType: 'html', content: sanitizeOutgoing(args.html) } } });
  } catch (err) {
    throw new TeamsError(reasonFrom(err, 'The message could not be changed.'));
  }
}

export async function deleteMessage(ctx: AuthContext, args: { key: string; messageId: string; threadId?: string | null }): Promise<void> {
  const ref = requireRef(args.key);
  const identity = await ownIdentity(ctx, ref.identityId);
  try {
    await graphForIdentity(identity.id).request({ method: 'POST', path: `${messagesPath(ref, args.threadId, args.messageId)}/softDelete`, body: {} });
  } catch (err) {
    throw new TeamsError(reasonFrom(err, 'The message could not be deleted.'));
  }
}

/** The thumbs-up, the only reaction this version has. */
export async function setThumb(ctx: AuthContext, args: { key: string; messageId: string; threadId?: string | null; on: boolean }): Promise<void> {
  const ref = requireRef(args.key);
  const identity = await ownIdentity(ctx, ref.identityId);
  const graph = graphForIdentity(identity.id);
  const path = `${messagesPath(ref, args.threadId, args.messageId)}/${args.on ? 'setReaction' : 'unsetReaction'}`;
  try {
    await graph.request({ method: 'POST', path, body: { reactionType: THUMBS } });
    // A thumbs-up given in Teams before emoji reactions is stored as the legacy "like".
    if (!args.on) await graph.request({ method: 'POST', path, body: { reactionType: 'like' } }).catch(() => undefined);
  } catch (err) {
    throw new TeamsError(reasonFrom(err, 'The reaction could not be saved.'));
  }
}

export async function setFavorite(ctx: AuthContext, args: { key: string; on: boolean }): Promise<void> {
  const ref = requireRef(args.key);
  const identity = await ownIdentity(ctx, ref.identityId);
  const table = supabaseAdmin().from('teams_favorites');
  const { error } = args.on
    ? await table.upsert({ identity_id: identity.id, chat_key: args.key }, { onConflict: 'identity_id,chat_key' })
    : await table.delete().eq('identity_id', identity.id).eq('chat_key', args.key);
  if (error) throw new TeamsError('That could not be saved.');
}

/* ── new conversations ────────────────────────────────────────────────────── */

async function userIdOf(graph: GraphTransport, email: string): Promise<string> {
  try {
    const u = await graph.request<{ id?: string }>({ path: `/users/${e(email)}`, query: { $select: 'id' } });
    if (u?.id) return u.id;
  } catch {
    // Falls through to the one message below.
  }
  throw new TeamsError(`Microsoft does not know ${email} from this account.`);
}

const binding = (graphBase: string, id: string) => `${graphBase}/users('${id}')`;

export async function newChat(ctx: AuthContext, args: { identityId: string; emails: string[]; topic?: string }): Promise<string> {
  const identity = await ownIdentity(ctx, args.identityId);
  const graph = graphForIdentity(identity.id);
  if (args.emails.length === 0) throw new TeamsError('Pick at least one person.');
  const others = await Promise.all(args.emails.map((m) => userIdOf(graph, m)));
  const ids = [...new Set([identity.microsoftUserId, ...others])];
  if (ids.length < 2) throw new TeamsError('Pick someone other than yourself.');
  const group = ids.length > 2;
  try {
    const made = await graph.request<{ id?: string }>({
      method: 'POST',
      path: '/chats',
      body: {
        chatType: group ? 'group' : 'oneOnOne',
        ...(group && args.topic?.trim() ? { topic: args.topic.trim() } : {}),
        members: ids.map((id) => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': binding(graph.baseUrl, id) })),
      },
    });
    if (!made?.id) throw new TeamsError('Microsoft did not return the new chat.');
    return chatKey(identity.id, made.id);
  } catch (err) {
    if (err instanceof TeamsError) throw err;
    throw new TeamsError(reasonFrom(err, 'The chat could not be created.'));
  }
}

const TEAM_WAIT_MS = 20_000;

/** A team is built in the background at Microsoft; members can only join once it exists. */
export async function newTeam(ctx: AuthContext, args: { identityId: string; name: string; description?: string; emails: string[] }): Promise<{ note: string | null }> {
  const identity = await ownIdentity(ctx, args.identityId);
  const graph = graphForIdentity(identity.id);
  if (!args.name.trim()) throw new TeamsError('Give the team a name.');
  const members = await Promise.all(args.emails.map((m) => userIdOf(graph, m)));
  let location: string | null;
  try {
    const res = await graph.raw({
      method: 'POST',
      path: '/teams',
      body: {
        'template@odata.bind': `${graph.baseUrl}/teamsTemplates('standard')`,
        displayName: args.name.trim(),
        description: args.description?.trim() || args.name.trim(),
        members: [{ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': binding(graph.baseUrl, identity.microsoftUserId) }],
      },
    });
    location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
  } catch (err) {
    throw new TeamsError(reasonFrom(err, 'The team could not be created.'));
  }
  const teamId = /teams\('([^']+)'\)/.exec(location ?? '')?.[1];
  const others = members.filter((id) => id !== identity.microsoftUserId);
  if (others.length === 0) return { note: null };
  if (!teamId) return { note: 'The team was created. Add its members in Teams.' };

  const until = Date.now() + TEAM_WAIT_MS;
  while (Date.now() < until) {
    try {
      const added = await graph.request<{ value?: { error?: unknown }[] }>({
        method: 'POST',
        path: `/teams/${e(teamId)}/members/add`,
        body: { values: others.map((id) => ({ '@odata.type': 'microsoft.graph.aadUserConversationMember', roles: [], 'user@odata.bind': binding(graph.baseUrl, id) })) },
      });
      const failed = (added?.value ?? []).filter((v) => v.error).length;
      return { note: failed ? `The team was created, but ${failed} of the members could not be added.` : null };
    } catch (err) {
      // 404 until Microsoft has finished building it.
      if (!(err instanceof GraphError) || (err.status !== 404 && err.status !== 409 && err.status !== 400)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { note: 'The team was created. Microsoft is still setting it up, so add its members in Teams.' };
}

export async function newChannel(ctx: AuthContext, args: { key: string; name: string }): Promise<void> {
  const ref = requireRef(args.key);
  if (ref.kind !== 'channel') throw new TeamsError('Channels belong to a team.');
  const identity = await ownIdentity(ctx, ref.identityId);
  if (!args.name.trim()) throw new TeamsError('Give the channel a name.');
  try {
    await graphForIdentity(identity.id).request({ method: 'POST', path: `/teams/${e(ref.teamId)}/channels`, body: { displayName: args.name.trim(), membershipType: 'standard' } });
  } catch (err) {
    throw new TeamsError(reasonFrom(err, 'The channel could not be created.'));
  }
}

/* ── files ────────────────────────────────────────────────────────────────── */

/** Local runs keep their files on the mock server. Production has no such host. */
const mockHost = (): string | null => {
  if (process.env.MAIL_PROVIDER !== 'mock' || !process.env.MAIL_MOCK_BASE_URL) return null;
  return new URL(process.env.MAIL_MOCK_BASE_URL).host;
};

const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|#%]/g, '_').trim().slice(0, 200) || `file-${randomUUID()}`;

/**
 * Where the browser sends the file. It goes straight to Microsoft, in pieces, so the
 * only size limit is Teams' own and not this server's.
 */
export async function startUpload(ctx: AuthContext, args: { key: string; name: string }): Promise<string> {
  const ref = requireRef(args.key);
  const identity = await ownIdentity(ctx, ref.identityId);
  const graph = graphForIdentity(identity.id);
  const name = safeFileName(args.name);
  const item = { item: { '@microsoft.graph.conflictBehavior': 'rename' } };
  try {
    let path: string;
    if (ref.kind === 'chat') {
      path = `/me/drive/root:/Microsoft Teams Chat Files/${e(name)}:/createUploadSession`;
    } else {
      const folder = await graph.request<{ id?: string; parentReference?: { driveId?: string } }>({ path: `/teams/${e(ref.teamId)}/channels/${e(ref.channelId)}/filesFolder` });
      if (!folder?.id || !folder.parentReference?.driveId) throw new TeamsError('This channel has no file folder yet. Open it once in Teams.');
      path = `/drives/${e(folder.parentReference.driveId)}/items/${e(folder.id)}:/${e(name)}:/createUploadSession`;
    }
    const session = await graph.request<{ uploadUrl?: string }>({ method: 'POST', path, body: item });
    if (!session?.uploadUrl) throw new TeamsError('Microsoft did not accept the file.');
    return session.uploadUrl;
  } catch (err) {
    if (err instanceof TeamsError) throw err;
    throw new TeamsError(reasonFrom(err, 'The file could not be uploaded.'));
  }
}

/**
 * After the upload. A chat's file lives in the sender's OneDrive, so the people in
 * the chat have to be given access to it, as Teams itself does. A channel's already
 * belongs to the team.
 */
export async function finishUpload(ctx: AuthContext, args: { key: string; itemId: string; driveId?: string | null; etag: string; webUrl: string; name: string; memberEmails: string[] }): Promise<{ id: string; name: string; url: string }> {
  const ref = requireRef(args.key);
  const identity = await ownIdentity(ctx, ref.identityId);
  const id = guidFromEtag(args.etag);
  if (!id) throw new TeamsError('Microsoft did not return the file properly.');
  if (ref.kind === 'chat' && args.memberEmails.length > 0) {
    try {
      await graphForIdentity(identity.id).request({
        method: 'POST',
        path: `/me/drive/items/${e(args.itemId)}/invite`,
        body: { requireSignIn: true, sendInvitation: false, roles: ['read'], recipients: args.memberEmails.map((email) => ({ email })) },
      });
    } catch (err) {
      throw new TeamsError(reasonFrom(err, 'The file could not be shared with the chat.'));
    }
  }
  return { id, name: args.name, url: args.webUrl };
}

/** A short-lived link to the file itself, for one download. */
export async function fileDownloadUrl(ctx: AuthContext, args: { key: string; url: string }): Promise<string | null> {
  const ref = requireRef(args.key);
  const { identity } = await readableIdentity(ctx, 'chat', ref.identityId);
  if (!isTeamsFileUrl(args.url, mockHost())) return null;
  try {
    const item = await graphForIdentity(identity.id).request<Record<string, unknown>>({ path: `/shares/${shareIdFor(args.url)}/driveItem` });
    const link = item?.['@microsoft.graph.downloadUrl'];
    return typeof link === 'string' ? link : null;
  } catch {
    return null;
  }
}
