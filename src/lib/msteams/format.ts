/**
 * Turning Microsoft's shapes into the CRM's, and back. Pure, so the rules that are
 * easy to get quietly wrong can be tested without a server.
 */
import type { CalEvent, ChatKind, RecurrenceInput } from './types';

/* ── recurrence ───────────────────────────────────────────────────────────── */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export const weekdayOf = (ymd: string): string => WEEKDAYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()]!;

/** Graph's recurrence for what the form chose. Null = a one-off event. */
export function toGraphRecurrence(r: RecurrenceInput, startYmd: string): Record<string, unknown> | null {
  if (r.kind === 'none') return null;
  const unit = r.kind === 'custom' ? (r.unit ?? 'week') : r.kind === 'daily' ? 'day' : r.kind === 'weekly' ? 'week' : 'month';
  const interval = r.kind === 'custom' ? Math.max(1, Math.min(99, Math.floor(r.interval ?? 1))) : 1;
  const pattern: Record<string, unknown> =
    unit === 'day'
      ? { type: 'daily', interval }
      : unit === 'week'
        ? { type: 'weekly', interval, daysOfWeek: r.kind === 'custom' && r.days?.length ? r.days : [weekdayOf(startYmd)], firstDayOfWeek: 'sunday' }
        : { type: 'absoluteMonthly', interval, dayOfMonth: Number(startYmd.slice(8, 10)) };
  const range = r.until ? { type: 'endDate', startDate: startYmd, endDate: r.until } : { type: 'noEnd', startDate: startYmd };
  return { pattern, range };
}

/** Back the other way, to fill the form when editing a series. */
export function fromGraphRecurrence(g: unknown): RecurrenceInput | null {
  const rec = g as { pattern?: { type?: string; interval?: number; daysOfWeek?: string[] }; range?: { type?: string; endDate?: string } } | null;
  const type = rec?.pattern?.type;
  if (!type) return null;
  const interval = rec?.pattern?.interval ?? 1;
  const until = rec?.range?.type === 'endDate' ? rec.range.endDate : undefined;
  const days = rec?.pattern?.daysOfWeek;
  if (type === 'daily') return interval === 1 ? { kind: 'daily', until } : { kind: 'custom', unit: 'day', interval, until };
  if (type === 'weekly') return interval === 1 && (days?.length ?? 0) <= 1 ? { kind: 'weekly', until } : { kind: 'custom', unit: 'week', interval, days, until };
  if (type === 'absoluteMonthly' || type === 'relativeMonthly') return interval === 1 ? { kind: 'monthly', until } : { kind: 'custom', unit: 'month', interval, until };
  return { kind: 'custom', unit: 'week', interval, until };
}

/** The day before, as yyyy-mm-dd: where a series ends for "this and following". */
export function dayBefore(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/* ── calendar ─────────────────────────────────────────────────────────────── */

/** yyyy-mm-ddThh:mm from Graph's 2026-11-04T09:30:00.0000000. */
export const wallClock = (dateTime: string | undefined | null): string => (dateTime ?? '').slice(0, 16);

export type GraphEventShape = {
  id?: string;
  subject?: string | null;
  bodyPreview?: string | null;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  sensitivity?: string;
  showAs?: string;
  type?: string;
  seriesMasterId?: string | null;
  responseStatus?: { response?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  attendees?: { type?: string; status?: { response?: string }; emailAddress?: { name?: string; address?: string } }[];
  location?: { displayName?: string };
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
};

/** Only a real https link ever becomes a Join button. */
export function safeHttps(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const isPrivateEvent = (e: GraphEventShape) => e.sensitivity === 'private' || e.sensitivity === 'confidential';

/**
 * One event for the screen.
 *
 * The token that reads someone else's calendar is the OWNER's, so Microsoft itself
 * would hand over a private event in full. The spec's rule, that anyone but the
 * owner sees only "Private", has to be applied here: an `isOwner` of false empties
 * every field that says anything about the event but its time.
 */
export function toCalEvent(e: GraphEventShape, ctx: { identityId: string; calendarKey: string; isOwner: boolean; readOnly: boolean }): CalEvent | null {
  if (!e.id || !e.start?.dateTime || !e.end?.dateTime) return null;
  const hide = !ctx.isOwner && isPrivateEvent(e);
  const base = {
    key: `${ctx.calendarKey}|${e.id}`,
    id: e.id,
    identityId: ctx.identityId,
    calendarKey: ctx.calendarKey,
    start: wallClock(e.start.dateTime),
    end: wallClock(e.end.dateTime),
    allDay: Boolean(e.isAllDay),
    isCancelled: Boolean(e.isCancelled),
    showAs: e.showAs ?? 'busy',
    type: e.type ?? 'singleInstance',
    seriesMasterId: e.seriesMasterId ?? null,
    readOnly: ctx.readOnly,
  };
  if (hide) {
    return { ...base, subject: 'Private', isOrganizer: false, response: 'none', organizer: '', organizerEmail: '', attendees: [], location: '', joinUrl: null, preview: '', isPrivate: true };
  }
  return {
    ...base,
    subject: e.subject?.trim() || '(No title)',
    isOrganizer: Boolean(e.isOrganizer),
    response: e.responseStatus?.response ?? 'none',
    organizer: e.organizer?.emailAddress?.name ?? '',
    organizerEmail: e.organizer?.emailAddress?.address ?? '',
    attendees: (e.attendees ?? []).map((a) => ({
      name: a.emailAddress?.name ?? a.emailAddress?.address ?? '',
      email: a.emailAddress?.address ?? '',
      response: a.status?.response ?? 'none',
      type: a.type ?? 'required',
    })),
    location: e.location?.displayName ?? '',
    joinUrl: safeHttps(e.onlineMeeting?.joinUrl ?? e.onlineMeetingUrl),
    preview: e.bodyPreview ?? '',
    isPrivate: false,
  };
}

/** An invitation still waiting on an answer, which is what the sidebar counts. */
export const awaitsAnswer = (e: GraphEventShape): boolean => !e.isOrganizer && !e.isCancelled && e.responseStatus?.response === 'notResponded';

/** How many invitations wait: a repeating meeting is one thing to answer, not ten. */
export function countUnanswered(events: GraphEventShape[]): number {
  const seen = new Set<string>();
  for (const e of events) {
    if (awaitsAnswer(e)) seen.add(e.seriesMasterId ?? e.id ?? '');
  }
  return seen.size;
}

/* ── chat ─────────────────────────────────────────────────────────────────── */

export const chatKindOf = (chatType: string | undefined): ChatKind => (chatType === 'oneOnOne' ? 'oneOnOne' : chatType === 'meeting' ? 'meeting' : 'group');

/**
 * Unread when something arrived after the person last read, unless they wrote it.
 * A chat they have never opened, with no read time, counts as unread if it has a
 * last message from someone else.
 */
export function isUnread(c: { lastAt: string | null; lastFromMe: boolean; readAt: string | null }): boolean {
  if (!c.lastAt || c.lastFromMe) return false;
  if (!c.readAt) return true;
  return Date.parse(c.lastAt) > Date.parse(c.readAt);
}

/** Someone in the chat from another organisation. */
export const isExternal = (memberTenant: string | null | undefined, myTenant: string | null | undefined): boolean =>
  Boolean(memberTenant && myTenant && memberTenant.toLowerCase() !== myTenant.toLowerCase());

/** The name of a chat with no topic: the other people in it. */
export function chatName(topic: string | null | undefined, names: string[]): string {
  if (topic?.trim()) return topic.trim();
  const list = names.filter(Boolean);
  if (list.length === 0) return 'Chat';
  return list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} +${list.length - 3}`;
}

/**
 * A conversation as a record stores it: no account in it, because Graph's ids are
 * the same for everyone in the conversation.
 */
export function conversationRefKey(ref: { kind: 'chat'; chatId: string } | { kind: 'channel'; teamId: string; channelId: string }): string {
  return ref.kind === 'chat' ? `chat|${ref.chatId}` : `channel|${ref.teamId}|${ref.channelId}`;
}

/**
 * The name a linked conversation shows on a record. The Chat list leaves the viewer
 * out of an untitled chat's name, which only works when there is one viewer; on a
 * record everyone reads the same card, so everyone in the chat is named.
 */
export function linkedChatTitle(topic: string | null | undefined, memberNames: string[]): string {
  return chatName(topic, memberNames).slice(0, 200);
}

/** Only the thumbs-up counts: the client wants no other reactions shown. */
export const THUMBS = '👍';
const isThumb = (type: string | undefined) => type === 'like' || type === THUMBS;

export function thumbsOf(reactions: { reactionType?: string; user?: { user?: { id?: string } } }[] | undefined, myId: string): { count: number; mine: boolean } {
  const list = (reactions ?? []).filter((r) => isThumb(r.reactionType));
  return { count: list.length, mine: list.some((r) => r.user?.user?.id === myId) };
}

/** The first web link in a message, for its preview card. */
export function firstLink(html: string): string | null {
  const m = /href="(https:\/\/[^"]+)"/i.exec(html) ?? /(https:\/\/[^\s<>"]+)/i.exec(html);
  return m?.[1] ?? null;
}

/** A driveItem's eTag is "{GUID},1"; a Teams file attachment wants that GUID. */
export function guidFromEtag(etag: string | null | undefined): string | null {
  const m = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(etag ?? '');
  return m?.[1] ?? null;
}

/** Graph's address for a file link: u! + unpadded base64url. */
export const shareIdFor = (url: string): string => `u!${Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;

/** Only the link types Teams itself keeps files behind. Nothing else is fetched. */
export function isTeamsFileUrl(url: string, extraHost?: string | null): boolean {
  try {
    const u = new URL(url);
    if (extraHost && u.host === extraHost) return true;
    return u.protocol === 'https:' && (/\.sharepoint\.(com|us|cn|de)$/i.test(u.hostname) || /(^|\.)sharepoint-df\.com$/i.test(u.hostname));
  } catch {
    return false;
  }
}

/** Opens someone (or several people) in Teams, where the call starts. */
export function teamsCallUrl(emails: string[]): string {
  return `https://teams.microsoft.com/l/call/0/0?users=${emails.map(encodeURIComponent).join(',')}`;
}

/** The two-week line that the first load stops at. */
export const twoWeeksBefore = (now: number): string => new Date(now - 14 * 24 * 3600 * 1000).toISOString();

/** What falls after the line. Microsoft cannot do this for a chat's created date, so it is done here. */
export function newerThan<T extends { createdDateTime?: string | null }>(messages: T[], line: string): T[] {
  const cut = Date.parse(line);
  return messages.filter((m) => Date.parse(m.createdDateTime ?? '') > cut);
}
