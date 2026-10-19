/**
 * Everything the Email UI reads, through the request-scoped client so RLS
 * decides visibility (CLAUDE.md rules 2 and 3). Each function takes the
 * `AuthContext` only `authorize()` can produce.
 *
 * Message bodies are the one place Graph is called on a read: mail whose body
 * was too large to store (`body_state = 'evicted'`) is fetched live, sanitised
 * on the way through, and not stored.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from '@/lib/records/permissions';
import { healthOf } from './mailboxes';
import { actingFor } from './acting';
import { sanitizeEmail } from './content/sanitize';
import { splitQuotedHtml } from './content/quoted';
import { toPrefixTsquery } from './searchQuery';
import { GraphError } from './graph/transport';
import { mailLog } from './log';
import type {
  Addr,
  AttachmentView,
  ConversationRow,
  FolderView,
  ListCursor,
  ListPage,
  MailboxView,
  MessageBody,
  MessageView,
  SyncState,
} from './viewTypes';

const PAGE = 50;
const WELL_KNOWN_ORDER = ['inbox', 'drafts', 'sentitems', 'archive', 'deleteditems', 'junkemail'];

type FolderRow = {
  id: string;
  mailbox_id: string;
  parent_folder_id: string | null;
  display_name: string;
  well_known: string | null;
  depth: number;
  unread_count: number;
  total_count: number;
  child_count: number;
  seeded_at: string | null;
};

/** Depth-first: well-known folders first in Outlook's order, then the rest A–Z, children under parents. */
export function orderFolders(rows: FolderRow[]): FolderView[] {
  const visible = rows.filter((r) => r.well_known !== 'outbox');
  const ids = new Set(visible.map((r) => r.id));
  const kids = new Map<string | null, FolderRow[]>();
  for (const r of visible) {
    const parent = r.parent_folder_id && ids.has(r.parent_folder_id) ? r.parent_folder_id : null;
    const list = kids.get(parent) ?? [];
    list.push(r);
    kids.set(parent, list);
  }
  const rank = (r: FolderRow) => {
    const i = r.well_known ? WELL_KNOWN_ORDER.indexOf(r.well_known) : -1;
    return i === -1 ? WELL_KNOWN_ORDER.length : i;
  };
  const out: FolderView[] = [];
  const walk = (parent: string | null, depth: number) => {
    const list = (kids.get(parent) ?? []).sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name));
    for (const r of list) {
      out.push({
        id: r.id,
        mailboxId: r.mailbox_id,
        parentId: parent,
        name: r.display_name || 'Untitled folder',
        wellKnown: r.well_known,
        depth,
        unread: r.unread_count,
        total: r.total_count,
        hasChildren: (kids.get(r.id) ?? []).length > 0,
        seeded: Boolean(r.seeded_at),
      });
      if (depth < 12) walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export async function loadMailboxes(ctx: AuthContext): Promise<MailboxView[]> {
  const supabase = await createSupabaseServerClient();
  const { data: conns, error } = await supabase
    .from('mail_connections')
    .select('mailbox_id, status, mail_mailboxes(id, address, display_name, kind, sync_status, seeded_at)')
    .eq('user_id', ctx.userId)
    .is('disconnected_at', null)
    .order('connected_at', { ascending: true })
    .returns<Array<{ mailbox_id: string; status: 'ok' | 'degraded' | 'broken' | 'paused_user' | 'disconnected'; mail_mailboxes: { id: string; address: string; display_name: string; kind: 'personal' | 'shared'; sync_status: 'pending' | 'ok' | 'throttled' | 'degraded' | 'broken' | 'stalled' | 'paused'; seeded_at: string | null } | null }>>();
  if (error) throw new Error(`mailboxes read failed: ${error.code ?? 'db'}`);

  const boxes: MailboxView[] = (conns ?? [])
    .filter((c) => c.mail_mailboxes)
    .map((c) => ({
      id: c.mailbox_id,
      address: c.mail_mailboxes!.address,
      displayName: c.mail_mailboxes!.display_name,
      kind: c.mail_mailboxes!.kind,
      own: true,
      health: healthOf({ status: c.status, mb: c.mail_mailboxes! }),
      folders: [],
    }));

  // Admins also see members' personal mailboxes (spec): whatever RLS shows
  // beyond their own connections.
  if (ctx.isAdmin) {
    const { data: team } = await supabase
      .from('mail_mailboxes')
      .select('id, address, display_name, kind, sync_status, seeded_at')
      .is('deactivated_at', null)
      .order('address');
    for (const m of team ?? []) {
      if (boxes.some((b) => b.id === m.id)) continue;
      boxes.push({
        id: m.id as string,
        address: m.address as string,
        displayName: m.display_name as string,
        kind: m.kind as 'personal' | 'shared',
        own: false,
        health: healthOf({ status: 'ok', mb: { sync_status: m.sync_status as string, seeded_at: m.seeded_at as string | null } }),
        folders: [],
      });
    }
  }
  if (boxes.length === 0) return boxes;

  const { data: folders, error: fErr } = await supabase
    .from('mail_folders')
    .select('id, mailbox_id, parent_folder_id, display_name, well_known, depth, unread_count, total_count, child_count, seeded_at')
    .in('mailbox_id', boxes.map((b) => b.id))
    .returns<FolderRow[]>();
  if (fErr) throw new Error(`folders read failed: ${fErr.code ?? 'db'}`);
  for (const b of boxes) b.folders = orderFolders((folders ?? []).filter((f) => f.mailbox_id === b.id));
  return boxes;
}

type ListRow = {
  mailbox_id: string;
  folder_id: string | null;
  conversation_key: string;
  latest_message_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  to_recipients: Addr[] | null;
  direction: 'inbound' | 'outbound';
  preview: string | null;
  last_at: string;
  message_count: number;
  unread_count: number;
  has_attachments: boolean;
  important: boolean;
  has_draft: boolean;
  is_pinned: boolean;
};

async function toRows(rows: ListRow[]): Promise<ConversationRow[]> {
  if (rows.length === 0) return [];
  const supabase = await createSupabaseServerClient();
  const withFiles = rows.filter((r) => r.has_attachments).map((r) => r.latest_message_id);
  const files = new Map<string, string[]>();
  if (withFiles.length) {
    const { data } = await supabase
      .from('mail_attachments')
      .select('message_id, name')
      .in('message_id', withFiles)
      .eq('is_inline', false)
      .order('created_at');
    for (const a of data ?? []) {
      const list = files.get(a.message_id as string) ?? [];
      list.push(a.name as string);
      files.set(a.message_id as string, list);
    }
  }
  return rows.map((r) => {
    const to = r.to_recipients ?? [];
    const outbound = r.direction === 'outbound';
    const who = outbound
      ? to.map((t) => t.name || t.address).filter(Boolean).slice(0, 3).join(', ') || '(no recipients)'
      : r.from_name || r.from_address || '(unknown sender)';
    const names = files.get(r.latest_message_id) ?? [];
    return {
      key: r.conversation_key,
      mailboxId: r.mailbox_id,
      folderId: r.folder_id,
      latestMessageId: r.latest_message_id,
      subject: r.subject?.trim() || '(no subject)',
      who,
      whoAddress: outbound ? (to[0]?.address ?? '') : (r.from_address ?? ''),
      outbound,
      preview: r.preview ?? '',
      lastAt: r.last_at,
      count: r.message_count,
      unread: r.unread_count,
      hasAttachments: r.has_attachments,
      firstAttachment: names[0] ?? null,
      attachmentCount: names.length,
      important: r.important,
      hasDraft: r.has_draft,
      pinned: r.is_pinned,
    };
  });
}

export type ListFilters = { unreadOnly?: boolean; withAttachments?: boolean };

export async function listConversations(
  ctx: AuthContext,
  folderIds: string[],
  cursor: ListCursor | null,
  filters: ListFilters = {},
): Promise<ListPage> {
  void ctx;
  if (folderIds.length === 0) return { pinned: [], rows: [], next: null };
  const supabase = await createSupabaseServerClient();
  const base = {
    p_folder_ids: folderIds,
    p_unread_only: Boolean(filters.unreadOnly),
    p_with_attachments: Boolean(filters.withAttachments),
  };
  const [pinned, page] = await Promise.all([
    cursor ? Promise.resolve({ data: [] as ListRow[], error: null }) : supabase.rpc('mail_list', { ...base, p_pinned: true, p_limit: 50 }),
    supabase.rpc('mail_list', {
      ...base,
      p_pinned: false,
      p_limit: PAGE + 1,
      p_cursor_at: cursor?.at ?? null,
      p_cursor_key: cursor?.key ?? null,
    }),
  ]);
  if (pinned.error || page.error) throw new Error(`mail_list failed: ${(pinned.error ?? page.error)?.code ?? 'db'}`);
  const raw = (page.data ?? []) as ListRow[];
  const more = raw.length > PAGE;
  const rows = await toRows(raw.slice(0, PAGE));
  const last = rows[rows.length - 1];
  return {
    pinned: await toRows((pinned.data ?? []) as ListRow[]),
    rows,
    next: more && last ? { at: last.lastAt, key: last.key } : null,
  };
}

export async function searchConversations(
  ctx: AuthContext,
  query: string,
  mailboxIds: string[],
  folderIds: string[] | null,
): Promise<ConversationRow[]> {
  void ctx;
  const ts = toPrefixTsquery(query);
  if (!ts || mailboxIds.length === 0) return [];
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('mail_search', {
    p_tsquery: ts,
    p_mailbox_ids: mailboxIds,
    p_folder_ids: folderIds,
    p_limit: 50,
  });
  if (error) throw new Error(`mail_search failed: ${error.code ?? 'db'}`);
  return toRows((data ?? []) as ListRow[]);
}

type MessageRow = {
  id: string;
  folder_id: string | null;
  folder_name: string | null;
  folder_well_known: string | null;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  to_recipients: Addr[] | null;
  cc_recipients: Addr[] | null;
  bcc_recipients: Addr[] | null;
  received_at: string | null;
  sent_at: string | null;
  is_read: boolean;
  is_draft: boolean;
  has_attachments: boolean;
  preview: string | null;
  direction: 'inbound' | 'outbound';
  importance: string | null;
  meeting_message_type: string | null;
  external_image_count: number;
};

export async function loadConversation(ctx: AuthContext, mailboxId: string, key: string): Promise<MessageView[]> {
  void ctx;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('mail_conversation', { p_mailbox_id: mailboxId, p_key: key });
  if (error) throw new Error(`mail_conversation failed: ${error.code ?? 'db'}`);
  return ((data ?? []) as MessageRow[]).map((m) => ({
    id: m.id,
    folderId: m.folder_id,
    folderName: m.folder_name,
    folderWellKnown: m.folder_well_known,
    subject: m.subject?.trim() || '(no subject)',
    fromName: m.from_name ?? '',
    fromAddress: m.from_address ?? '',
    to: m.to_recipients ?? [],
    cc: m.cc_recipients ?? [],
    bcc: m.bcc_recipients ?? [],
    at: m.received_at ?? m.sent_at ?? '',
    isRead: m.is_read,
    isDraft: m.is_draft,
    hasAttachments: m.has_attachments,
    preview: m.preview ?? '',
    outbound: m.direction === 'outbound',
    important: m.importance === 'high',
    meetingType: m.meeting_message_type,
    externalImageCount: m.external_image_count,
  }));
}

export async function loadMessageBody(ctx: AuthContext, messageId: string): Promise<MessageBody | null> {
  const supabase = await createSupabaseServerClient();
  // The RLS read is the visibility check: no row, no body.
  const { data: m, error } = await supabase
    .from('mail_messages')
    .select('id, mailbox_id, graph_id, body_html, body_state, external_images')
    .eq('id', messageId)
    .maybeSingle();
  if (error) throw new Error(`message read failed: ${error.code ?? 'db'}`);
  if (!m) return null;

  const { data: atts } = await supabase
    .from('mail_attachments')
    .select('id, name, content_type, size_bytes, kind')
    .eq('message_id', messageId)
    .eq('is_inline', false)
    .order('created_at');
  const attachments: AttachmentView[] = (atts ?? []).map((a) => ({
    id: a.id as string,
    name: a.name as string,
    contentType: (a.content_type as string | null) ?? null,
    size: a.size_bytes == null ? null : Number(a.size_bytes),
    kind: a.kind as AttachmentView['kind'],
  }));

  if (m.body_state === 'protected') return { html: '', quoted: null, externalImages: 0, attachments, state: 'protected' };

  let html = (m.body_html as string | null) ?? '';
  let externalImages = Array.isArray(m.external_images) ? m.external_images.length : 0;

  if (m.body_state === 'evicted') {
    try {
      const acting = await actingFor(ctx, m.mailbox_id as string);
      if (!acting) return { html: '', quoted: null, externalImages: 0, attachments, state: 'unavailable' };
      const live = await acting.graph.request<{ body?: { content?: string; contentType?: string } }>({
        path: `${acting.root}/messages/${encodeURIComponent(m.graph_id as string)}`,
        query: { $select: 'body' },
        headers: { Prefer: 'outlook.body-content-type="html"' },
      });
      const s = sanitizeEmail(live?.body?.content ?? '', live?.body?.contentType ?? 'html');
      html = s.html;
      // Live bodies are not stored, so their images cannot go through the proxy (it reads the stored list).
      externalImages = 0;
      html = html.replace(/ data-mail-img="\d+"/g, '');
    } catch (e) {
      mailLog('warn', 'read', 'live_body_failed', { code: e instanceof GraphError ? e.classified.code : 'internal' });
      return { html: '', quoted: null, externalImages: 0, attachments, state: 'unavailable' };
    }
  }

  const { main, quoted } = splitQuotedHtml(html);
  return { html: main, quoted, externalImages, attachments, state: 'ok' };
}

export async function syncState(ctx: AuthContext, mailboxIds: string[]): Promise<SyncState> {
  const supabase = await createSupabaseServerClient();
  const [{ data: boxes }, { data: conns }, { data: total }] = await Promise.all([
    supabase.from('mail_mailboxes').select('id, change_seq, sync_status, seeded_at').in('id', mailboxIds),
    supabase.from('mail_connections').select('mailbox_id, status').eq('user_id', ctx.userId).is('disconnected_at', null),
    supabase.rpc('mail_unread_total'),
  ]);
  const status = new Map((conns ?? []).map((c) => [c.mailbox_id as string, c.status as 'ok']));
  return {
    mailboxes: (boxes ?? []).map((b) => ({
      id: b.id as string,
      seq: Number(b.change_seq ?? 0),
      health: healthOf({ status: status.get(b.id as string) ?? 'ok', mb: { sync_status: b.sync_status as string, seeded_at: b.seeded_at as string | null } }),
    })),
    unreadTotal: Number(total ?? 0),
  };
}
