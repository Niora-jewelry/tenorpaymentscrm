/**
 * What the Calendar and Chat screens are given. Plain data, safe to send to the
 * browser: chat HTML has been sanitized, and a private event seen by anyone but its
 * owner has already lost its details.
 */

export type TeamsKind = 'calendar' | 'chat';

/** Why what is on screen may be old. Null = this is live from Microsoft. */
/** 'down' = Microsoft did not answer. 'refused' = it answered, and said no. Never call one the other. */
export type Staleness = null | 'reconnect' | 'down' | 'refused';

export type AccountView = {
  identityId: string;
  email: string;
  name: string;
  status: 'ok' | 'reconnect';
  /** This sign-in approved calendar and chat access. */
  approved: boolean;
};

export type PersonChoice = { userId: string; name: string; own: boolean };

/* ── Calendar ─────────────────────────────────────────────────────────────── */

export type CalendarEntry = {
  /** Unique across accounts. */
  key: string;
  identityId: string;
  accountEmail: string;
  /** Graph id; null for a teammate's calendar, which is read by address. */
  calendarId: string | null;
  /** The teammate's address, for one added to the list. */
  address: string | null;
  name: string;
  color: string;
  isDefault: boolean;
  canEdit: boolean;
  /** A calendar someone shared, or a teammate's added by hand. */
  shared: boolean;
  /** Row id of a teammate's calendar added by hand, so it can be taken off the list. */
  addedId: string | null;
};

export type Attendee = { name: string; email: string; response: string; type: string };

export type RecurrenceInput = {
  /** none, daily, weekly and monthly are the presets; custom says which unit and days. */
  kind: 'none' | 'daily' | 'weekly' | 'monthly' | 'custom';
  interval?: number;
  unit?: 'day' | 'week' | 'month';
  days?: string[];
  /** yyyy-mm-dd; empty = no end. */
  until?: string;
};

export type CalEvent = {
  /** Unique across calendars, because the same event can be on two accounts. */
  key: string;
  id: string;
  identityId: string;
  calendarKey: string;
  subject: string;
  /** Wall-clock in the viewer's zone, yyyy-mm-ddThh:mm. */
  start: string;
  end: string;
  allDay: boolean;
  isOrganizer: boolean;
  isCancelled: boolean;
  /** none, organizer, accepted, tentativelyAccepted, declined, notResponded. */
  response: string;
  organizer: string;
  organizerEmail: string;
  attendees: Attendee[];
  location: string;
  joinUrl: string | null;
  preview: string;
  showAs: string;
  /** Private to its owner, and the viewer is not the owner. Nothing else is filled in. */
  isPrivate: boolean;
  /** singleInstance, occurrence, exception or seriesMaster. */
  type: string;
  seriesMasterId: string | null;
  /** A teammate's calendar: it can be looked at, not changed from here. */
  readOnly: boolean;
};

export type EventDetail = { bodyHtml: string; recurrence: RecurrenceInput | null };

export type CalendarData = { calendars: CalendarEntry[]; events: CalEvent[]; stale: Staleness };

export type EventInput = {
  subject: string;
  /** yyyy-mm-ddThh:mm, wall clock in `timeZone`. */
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  attendees: { email: string; name?: string }[];
  /** Null = leave the description as it is, which keeps Teams' own join block intact. */
  bodyHtml: string | null;
  teamsLink: boolean;
  location: string;
  recurrence: RecurrenceInput;
};

export type SeriesScope = 'this' | 'following' | 'all';

/* ── Chat ─────────────────────────────────────────────────────────────────── */

export type ChatKind = 'oneOnOne' | 'group' | 'meeting' | 'channel';

export type ChatMember = { id: string; name: string; email: string; external: boolean };

export type ChatSummary = {
  /** chat|<account>|<id> or channel|<account>|<team>|<channel>. */
  key: string;
  identityId: string;
  accountEmail: string;
  /** The account's organisation at Microsoft, so a call opens on the right account. */
  accountTenantId: string | null;
  kind: ChatKind;
  chatId: string | null;
  teamId: string | null;
  channelId: string | null;
  name: string;
  teamName: string | null;
  members: ChatMember[];
  memberCount: number;
  external: boolean;
  lastAt: string | null;
  preview: string;
  unread: boolean;
  favorite: boolean;
  webUrl: string | null;
};

export type ChatFile = { id: string; name: string; size: number | null; url: string };

export type ChatQuote = { id: string; author: string; preview: string };

export type LinkPreview = { url: string; title: string; description: string; site: string };

export type ChatMessage = {
  id: string;
  authorId: string | null;
  authorName: string;
  mine: boolean;
  at: string;
  html: string;
  text: string;
  edited: boolean;
  deleted: boolean;
  /** A system line, such as someone being added. */
  system: boolean;
  thumbs: number;
  thumbedByMe: boolean;
  files: ChatFile[];
  quote: ChatQuote | null;
  /** Channel posts only. */
  replies: ChatMessage[];
  replyCount: number;
  /** First link in the message, for its preview card. */
  link: string | null;
  /** Pictures shown in the message. Editing the words keeps them. */
  images: number;
};

/** A picture pasted or dropped into the box, ready to go with the message. */
export type OutgoingImage = { contentType: 'image/png' | 'image/jpeg' | 'image/gif'; data: string; width: number; height: number };

export type MessagesPage = {
  messages: ChatMessage[];
  olderCursor: string | null;
  stale: Staleness;
  /** Microsoft's status and error code when it refused, such as "400 BadRequest". Never its message. */
  staleReason: string | null;
};

export type ChatList = { chats: ChatSummary[]; stale: Staleness };

export type Mention = { id: string; name: string };

export type SendInput = {
  key: string;
  html: string;
  replyToId?: string | null;
  /** A channel thread: answers this post. */
  threadId?: string | null;
  mentions?: Mention[];
  files?: { id: string; name: string; url: string }[];
  images?: OutgoingImage[];
};

export type PersonResult = { name: string; email: string; source: 'microsoft' | 'crm' };

/* ── Teams on a record ──────────────────────────────────────────────────── */

/**
 * What this viewer gets of a linked conversation.
 *   member: they are in it, through their own account.
 *   look: All users, through the account that linked it, read only.
 *   none: the card only. Nothing of the conversation is read.
 *   unavailable: Microsoft did not answer, so whether they are in it is unknown.
 */
export type RecordChatAccess = 'member' | 'look' | 'none' | 'unavailable';

export type RecordChatLink = {
  id: string;
  kind: ChatKind;
  /** Stored when linked, so it can be shown without asking Microsoft. */
  title: string;
  teamName: string | null;
  linkedByName: string;
  linkedAt: string;
  access: RecordChatAccess;
  /** Only for member and look. Its key decides whose account reads the messages. */
  chat: ChatSummary | null;
  /** Whose account a look-only view reads through. */
  lookingThrough: string | null;
};

export type RecordChats = {
  configured: boolean;
  impersonating: boolean;
  /** Communication and its Teams sub-tab are Edit for this viewer on this record. */
  canEdit: boolean;
  /** The viewer's own accounts: they decide the connect prompt, and what can be linked. */
  accounts: AccountView[];
  links: RecordChatLink[];
  /** Own only, Microsoft down: a chat they are in may be missing from `links`. */
  someUnavailable: boolean;
};

/** A record a conversation is linked to, as the Chat module shows it. */
export type ChatRecordLink = { recordId: string; name: string; href: string };

export type ChatRecords = {
  records: ChatRecordLink[];
  /** The viewer's own conversation, on an account that can link it. */
  canLink: boolean;
};
