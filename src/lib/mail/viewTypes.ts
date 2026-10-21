/**
 * The shapes the Email UI receives. Plain data, no server imports, so client
 * components can share them with the server code that builds them.
 */
export type Health = 'ok' | 'setting_up' | 'needs_reconnect' | 'needs_permission' | 'stalled' | 'throttled';

export type FolderView = {
  id: string;
  mailboxId: string;
  parentId: string | null;
  name: string;
  wellKnown: string | null;
  depth: number;
  unread: number;
  total: number;
  hasChildren: boolean;
  seeded: boolean;
};

export type MailboxView = {
  id: string;
  address: string;
  displayName: string;
  kind: 'personal' | 'shared';
  /** Connected by this person (false = an admin seeing a member's personal mailbox). */
  own: boolean;
  health: Health;
  folders: FolderView[];
};

export type Addr = { name: string; address: string };

export type ConversationRow = {
  key: string;
  mailboxId: string;
  folderId: string | null;
  latestMessageId: string;
  subject: string;
  /** Who the row is "from": the sender, or the recipients for mail this mailbox sent. */
  who: string;
  whoAddress: string;
  outbound: boolean;
  preview: string;
  lastAt: string;
  count: number;
  unread: number;
  hasAttachments: boolean;
  firstAttachment: string | null;
  attachmentCount: number;
  important: boolean;
  hasDraft: boolean;
  pinned: boolean;
};

export type ListCursor = { at: string; key: string };

export type ListPage = {
  pinned: ConversationRow[];
  rows: ConversationRow[];
  next: ListCursor | null;
};

export type MessageView = {
  id: string;
  folderId: string | null;
  folderName: string | null;
  folderWellKnown: string | null;
  subject: string;
  fromName: string;
  fromAddress: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  at: string;
  isRead: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  preview: string;
  outbound: boolean;
  important: boolean;
  meetingType: string | null;
  externalImageCount: number;
};

export type AttachmentView = {
  id: string;
  name: string;
  contentType: string | null;
  size: number | null;
  kind: 'file' | 'item' | 'reference';
};

export type MessageBody = {
  html: string;
  quoted: string | null;
  externalImages: number;
  attachments: AttachmentView[];
  /** 'protected' = rights-managed mail Graph cannot show; 'unavailable' = could not be fetched. */
  state: 'ok' | 'protected' | 'unavailable';
};

export type Notice = { id: string; kind: string; body: string; at: string };

export type SyncState = {
  mailboxes: Array<{ id: string; seq: number; health: Health }>;
  unreadTotal: number;
  /** Undismissed "Outlook didn't…" notices for this person, newest first. */
  notices: Notice[];
};
