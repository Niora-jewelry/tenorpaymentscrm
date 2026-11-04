/**
 * What the Calendar and Chat screens are given. Plain data, safe to send to the
 * browser: chat HTML has been sanitized, and a private event seen by anyone but its
 * owner has already lost its details.
 */

export type TeamsKind = 'calendar' | 'chat';

/** Why what is on screen may be old. Null = this is live from Microsoft. */
export type Staleness = null | 'reconnect' | 'down';

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
};

export type MessagesPage = { messages: ChatMessage[]; olderCursor: string | null; stale: Staleness };

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
};

export type PersonResult = { name: string; email: string; source: 'microsoft' | 'crm' };
