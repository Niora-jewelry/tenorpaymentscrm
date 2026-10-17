/**
 * One Graph message → one `mail_messages` row. Pure, unit-tested.
 *
 * Everything that reaches the row is bounded here (subjects, recipient
 * lists, previews), so a pathological message can never fail an insert on a
 * length CHECK or bloat a page of results.
 */
import { sanitizeEmail, MAX_STORED_HTML } from '../content/sanitize';

/** Asked for on every delta seed and single-message fetch. Graph bakes it into nextLink/deltaLink. */
export const MESSAGE_SELECT = [
  'id', 'conversationId', 'conversationIndex', 'internetMessageId', 'changeKey', 'subject', 'bodyPreview', 'body',
  'from', 'sender', 'toRecipients', 'ccRecipients', 'bccRecipients', 'replyTo', 'receivedDateTime', 'sentDateTime',
  'isRead', 'isDraft', 'hasAttachments', 'importance', 'parentFolderId', 'lastModifiedDateTime',
].join(',');

type Recipient = { emailAddress?: { name?: string | null; address?: string | null } | null } | null;

export type GraphMessage = {
  id: string;
  '@odata.type'?: string;
  '@removed'?: { reason?: string };
  conversationId?: string | null;
  conversationIndex?: string | null;
  internetMessageId?: string | null;
  changeKey?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  from?: Recipient;
  sender?: Recipient;
  toRecipients?: Recipient[] | null;
  ccRecipients?: Recipient[] | null;
  bccRecipients?: Recipient[] | null;
  replyTo?: Recipient[] | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  isRead?: boolean | null;
  isDraft?: boolean | null;
  hasAttachments?: boolean | null;
  importance?: string | null;
  parentFolderId?: string | null;
  lastModifiedDateTime?: string | null;
};

export type MessageRow = {
  mailbox_id: string;
  folder_id: string | null;
  graph_id: string;
  conversation_id: string | null;
  conversation_index: string | null;
  internet_message_id: string | null;
  change_key: string | null;
  subject: string | null;
  from_address: string | null;
  from_name: string | null;
  sender_address: string | null;
  to_recipients: Addr[];
  cc_recipients: Addr[];
  bcc_recipients: Addr[];
  reply_to: Addr[];
  recipients_text: string;
  preview: string | null;
  body_html: string | null;
  body_text: string | null;
  body_state: 'stored' | 'evicted';
  external_images: string[];
  has_attachments: boolean;
  importance: string | null;
  received_at: string | null;
  sent_at: string | null;
  is_read: boolean;
  is_draft: boolean;
  direction: 'inbound' | 'outbound';
  meeting_message_type: string | null;
  graph_last_modified: string | null;
  synced_at: string;
  updated_at: string;
  deleted_at: null;
};

export type Addr = { name: string; address: string };

const MAX_RECIPIENTS = 500;
const cap = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? s.slice(0, n) : s);

function addr(r: Recipient): Addr | null {
  const a = r?.emailAddress?.address?.trim();
  const name = r?.emailAddress?.name?.trim() ?? '';
  if (!a && !name) return null;
  return { name: name.slice(0, 200), address: (a ?? '').toLowerCase().slice(0, 254) };
}

function list(rs: Recipient[] | null | undefined): Addr[] {
  const out: Addr[] = [];
  for (const r of rs ?? []) {
    const a = addr(r);
    if (a) out.push(a);
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

/** Meeting messages arrive as subtypes; the kind decides the invite card. */
export function meetingType(odataType: string | undefined): string | null {
  switch (odataType) {
    case '#microsoft.graph.eventMessageRequest':
      return 'meetingRequest';
    case '#microsoft.graph.eventMessageResponse':
      return 'meetingResponse';
    case '#microsoft.graph.eventMessage':
      return 'meetingMessage';
    default:
      return null;
  }
}

const OUTBOUND_FOLDERS = new Set(['sentitems', 'drafts', 'outbox']);

export function toMessageRow(
  m: GraphMessage,
  ctx: {
    mailboxId: string;
    mailboxAddress: string;
    folderId: string | null;
    folderWellKnown: string | null;
    now?: string;
  },
): MessageRow {
  const now = ctx.now ?? new Date().toISOString();
  const from = addr(m.from ?? null);
  const sender = addr(m.sender ?? null);
  const to = list(m.toRecipients);
  const cc = list(m.ccRecipients);
  const bcc = list(m.bccRecipients);
  const recipientsText = [...to, ...cc, ...bcc]
    .map((r) => `${r.name} ${r.address}`.trim())
    .join(' ')
    .slice(0, 10_000);

  const raw = m.body?.content ?? '';
  const tooBig = raw.length > MAX_STORED_HTML;
  const s = tooBig ? null : sanitizeEmail(raw, m.body?.contentType ?? 'html');

  const outbound =
    (ctx.folderWellKnown !== null && OUTBOUND_FOLDERS.has(ctx.folderWellKnown)) ||
    Boolean(m.isDraft) ||
    (from?.address !== undefined && from.address === ctx.mailboxAddress.toLowerCase());

  return {
    mailbox_id: ctx.mailboxId,
    folder_id: ctx.folderId,
    graph_id: m.id,
    conversation_id: cap(m.conversationId, 500),
    conversation_index: cap(m.conversationIndex, 1000),
    internet_message_id: cap(m.internetMessageId, 1000),
    change_key: cap(m.changeKey, 200),
    subject: cap(m.subject, 1000),
    from_address: from?.address || null,
    from_name: from?.name || null,
    sender_address: sender?.address || null,
    to_recipients: to,
    cc_recipients: cc,
    bcc_recipients: bcc,
    reply_to: list(m.replyTo),
    recipients_text: recipientsText,
    preview: cap(m.bodyPreview?.replace(/\s+/g, ' ').trim() ?? null, 300),
    body_html: s ? s.html : null,
    body_text: s ? s.text : cap(m.bodyPreview ?? null, 300),
    body_state: s ? 'stored' : 'evicted',
    external_images: s ? s.externalImages : [],
    has_attachments: Boolean(m.hasAttachments),
    importance: cap(m.importance, 20),
    received_at: m.receivedDateTime ?? null,
    sent_at: m.sentDateTime ?? null,
    is_read: Boolean(m.isRead),
    is_draft: Boolean(m.isDraft),
    direction: outbound ? 'outbound' : 'inbound',
    meeting_message_type: meetingType(m['@odata.type']),
    graph_last_modified: m.lastModifiedDateTime ?? null,
    synced_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

/** Inline images can exist when `hasAttachments` is false — Graph only counts files. */
export function needsAttachmentList(m: GraphMessage): boolean {
  return Boolean(m.hasAttachments) || /src\s*=\s*["']?cid:/i.test(m.body?.content ?? '');
}
