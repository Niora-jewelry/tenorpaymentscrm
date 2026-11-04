/**
 * The Calendar module. Microsoft holds the events; this reads them for a range and
 * passes changes straight through, so Microsoft's version always wins and its own
 * invitations and cancellation notices go out as they do from Teams.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { sanitizeEmail, sanitizeOutgoing } from '@/lib/mail/content/sanitize';
import { GraphError } from '@/lib/mail/graph/transport';
import { teamsGranted } from '@/lib/mail/scopes';
import { graphForIdentity } from '@/lib/mail/tokens';
import type { AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { dataOwner, identitiesOf, ownIdentity, readableIdentity, TeamsError, usable, type Identity } from './access';
import { dayBefore, fromGraphRecurrence, safeHttps, toCalEvent, toGraphRecurrence, wallClock, type GraphEventShape } from './format';
import { allPages, firstStale, readThrough, reasonFrom } from './snapshots';
import type { CalEvent, CalendarData, CalendarEntry, EventDetail, EventInput, SeriesScope, Staleness } from './types';

const EVENT_FIELDS = 'id,subject,bodyPreview,start,end,isAllDay,isCancelled,isOrganizer,sensitivity,showAs,type,seriesMasterId,responseStatus,organizer,attendees,location,isOnlineMeeting,onlineMeeting,onlineMeetingUrl';

const PALETTE = ['#2752a3', '#0b6b5d', '#8a5a09', '#7c3aed', '#a12a20', '#0e7490', '#be185d', '#4d7c0f'];

const preferZone = (timeZone: string) => ({ Prefer: `outlook.timezone="${timeZone}"` });

type GraphCalendar = { id: string; name?: string; hexColor?: string; isDefaultCalendar?: boolean; canEdit?: boolean; owner?: { address?: string } };

const calendarKey = (identityId: string, id: string) => `${identityId}|${id}`;

async function calendarsOf(identity: Identity, own: boolean): Promise<{ calendars: CalendarEntry[]; stale: Staleness }> {
  const graph = graphForIdentity(identity.id);
  const { data, stale } = await readThrough(identity.id, 'calendars', 'all', async () => allPages<GraphCalendar>(graph, { path: '/me/calendars', query: { $select: 'id,name,hexColor,isDefaultCalendar,canEdit,owner', $top: 100 } }, 2));
  const mine = identity.email.toLowerCase();
  const calendars: CalendarEntry[] = (data ?? []).map((c, i) => ({
    key: calendarKey(identity.id, c.id),
    identityId: identity.id,
    accountEmail: identity.email,
    calendarId: c.id,
    address: null,
    name: c.name?.trim() || 'Calendar',
    color: c.hexColor && /^#[0-9a-f]{6}$/i.test(c.hexColor) ? c.hexColor : PALETTE[i % PALETTE.length]!,
    isDefault: Boolean(c.isDefaultCalendar),
    canEdit: own && Boolean(c.canEdit),
    shared: Boolean(c.owner?.address && c.owner.address.toLowerCase() !== mine),
    addedId: null,
  }));

  const { data: added } = await supabaseAdmin().from('teams_added_calendars').select('id, address, name').eq('identity_id', identity.id).order('created_at');
  (added ?? []).forEach((a, i) => {
    calendars.push({
      key: calendarKey(identity.id, `user:${a.address as string}`),
      identityId: identity.id,
      accountEmail: identity.email,
      calendarId: null,
      address: a.address as string,
      name: (a.name as string) || (a.address as string),
      color: PALETTE[(calendars.length + i) % PALETTE.length]!,
      isDefault: false,
      canEdit: false,
      shared: true,
      addedId: a.id as string,
    });
  });
  return { calendars, stale };
}

async function eventsOf(identity: Identity, cal: CalendarEntry, range: { start: string; end: string; timeZone: string }, own: boolean): Promise<{ events: CalEvent[]; stale: Staleness }> {
  const graph = graphForIdentity(identity.id);
  const root = cal.address ? `/users/${encodeURIComponent(cal.address)}` : '/me';
  const path = cal.calendarId ? `${root}/calendars/${encodeURIComponent(cal.calendarId)}/calendarView` : `${root}/calendar/calendarView`;
  const { data, stale } = await readThrough(identity.id, 'events', `${cal.key}|${range.start}|${range.end}|${range.timeZone}`.slice(0, 500), () =>
    allPages<GraphEventShape>(graph, { path, query: { startDateTime: range.start, endDateTime: range.end, $select: EVENT_FIELDS, $top: 200, $orderby: 'start/dateTime' }, headers: preferZone(range.timeZone) }),
  );
  const readOnly = !own || !cal.canEdit;
  const events = (data ?? []).flatMap((e) => toCalEvent(e, { identityId: identity.id, calendarKey: cal.key, isOwner: own, readOnly }) ?? []);
  return { events, stale };
}

/** Every event on every calendar of every connected account of this person. */
export async function calendarData(ctx: AuthContext, args: { ownerId?: string | null; start: string; end: string; timeZone: string }): Promise<CalendarData> {
  const { ownerId, own } = await dataOwner(ctx, 'calendar', args.ownerId);
  // An account only feeds this module once it has approved calendar and chat access.
  const identities = (await identitiesOf(ownerId)).filter((i) => teamsGranted(i.scopes));
  const perAccount = await Promise.all(
    identities.map(async (identity) => {
      if (!usable(identity)) {
        // Nothing is asked of a broken connection; the kept data is what there is.
        const kept = await readKept(identity, args, own);
        return { calendars: kept.calendars, events: kept.events, stale: 'reconnect' as Staleness };
      }
      const { calendars, stale } = await calendarsOf(identity, own);
      const lists = await Promise.all(calendars.map((c) => eventsOf(identity, c, args, own)));
      return { calendars, events: lists.flatMap((l) => l.events), stale: firstStale([stale, ...lists.map((l) => l.stale)]) };
    }),
  );
  return {
    calendars: perAccount.flatMap((a) => a.calendars),
    events: perAccount.flatMap((a) => a.events),
    stale: firstStale(perAccount.map((a) => a.stale)),
  };
}

async function readKept(identity: Identity, range: { start: string; end: string; timeZone: string }, own: boolean): Promise<{ calendars: CalendarEntry[]; events: CalEvent[] }> {
  const admin = supabaseAdmin();
  const { data } = await admin.from('teams_snapshots').select('data').eq('identity_id', identity.id).eq('kind', 'calendars').eq('key', 'all').maybeSingle();
  const calendars: CalendarEntry[] = ((data?.data as GraphCalendar[] | null) ?? []).map((c, i) => ({
    key: calendarKey(identity.id, c.id),
    identityId: identity.id,
    accountEmail: identity.email,
    calendarId: c.id,
    address: null,
    name: c.name?.trim() || 'Calendar',
    color: PALETTE[i % PALETTE.length]!,
    isDefault: Boolean(c.isDefaultCalendar),
    canEdit: false,
    shared: false,
    addedId: null,
  }));
  const events: CalEvent[] = [];
  for (const cal of calendars) {
    const { data: row } = await admin.from('teams_snapshots').select('data').eq('identity_id', identity.id).eq('kind', 'events').eq('key', `${cal.key}|${range.start}|${range.end}|${range.timeZone}`.slice(0, 500)).maybeSingle();
    for (const e of (row?.data as GraphEventShape[] | null) ?? []) {
      const ev = toCalEvent(e, { identityId: identity.id, calendarKey: cal.key, isOwner: own, readOnly: true });
      if (ev) events.push(ev);
    }
  }
  return { calendars, events };
}

/** The rest of the card: only read when someone opens it. */
export async function eventDetail(ctx: AuthContext, args: { identityId: string; eventId: string; address?: string | null }): Promise<EventDetail> {
  const { identity, own } = await readableIdentity(ctx, 'calendar', args.identityId);
  const root = args.address ? `/users/${encodeURIComponent(args.address)}` : '/me';
  const graph = graphForIdentity(identity.id);
  try {
    const e = await graph.request<{ body?: { content?: string; contentType?: string }; sensitivity?: string; recurrence?: unknown; seriesMasterId?: string | null }>({
      path: `${root}/events/${encodeURIComponent(args.eventId)}`,
      query: { $select: 'body,sensitivity,recurrence,seriesMasterId' },
    });
    if (!own && (e?.sensitivity === 'private' || e?.sensitivity === 'confidential')) return { bodyHtml: '', recurrence: null };
    let recurrence = fromGraphRecurrence(e?.recurrence);
    if (!recurrence && e?.seriesMasterId) {
      const master = await graph.request<{ recurrence?: unknown }>({ path: `${root}/events/${encodeURIComponent(e.seriesMasterId)}`, query: { $select: 'recurrence' } });
      recurrence = fromGraphRecurrence(master?.recurrence);
    }
    return { bodyHtml: sanitizeEmail(e?.body?.content ?? '', e?.body?.contentType ?? 'html').html, recurrence };
  } catch (err) {
    if (err instanceof GraphError) return { bodyHtml: '', recurrence: null };
    throw err;
  }
}

/* ── changes ──────────────────────────────────────────────────────────────── */

function checkInput(input: EventInput): void {
  if (!input.subject.trim()) throw new TeamsError('Give the event a title.');
  if (Date.parse(`${input.end}:00Z`) <= Date.parse(`${input.start}:00Z`)) throw new TeamsError('The end has to be after the start.');
}

function graphBody(input: EventInput): Record<string, unknown> {
  return {
    subject: input.subject.trim(),
    ...(input.bodyHtml === null ? {} : { body: { contentType: 'HTML', content: sanitizeOutgoing(input.bodyHtml) } }),
    start: { dateTime: `${input.start}:00`, timeZone: input.timeZone },
    end: { dateTime: `${input.end}:00`, timeZone: input.timeZone },
    isAllDay: input.allDay,
    location: { displayName: input.location.trim() },
    attendees: input.attendees.map((a) => ({ type: 'required', emailAddress: { address: a.email, name: a.name ?? a.email } })),
    ...(input.teamsLink ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' } : {}),
  };
}

const ownCalendar = (identityId: string, eventCalendarKey: string) => ({ calendarKey: eventCalendarKey, identityId, isOwner: true, readOnly: false });

export async function createEvent(ctx: AuthContext, args: { identityId: string; calendarId: string; input: EventInput }): Promise<CalEvent> {
  const identity = await ownIdentity(ctx, args.identityId);
  checkInput(args.input);
  const recurrence = toGraphRecurrence(args.input.recurrence, args.input.start.slice(0, 10));
  try {
    const made = await graphForIdentity(identity.id).request<GraphEventShape>({
      method: 'POST',
      path: `/me/calendars/${encodeURIComponent(args.calendarId)}/events`,
      headers: preferZone(args.input.timeZone),
      // Sent twice on a network hiccup, this is still one event.
      body: { ...graphBody(args.input), ...(recurrence ? { recurrence } : {}), transactionId: randomUUID() },
    });
    const ev = toCalEvent(made, ownCalendar(identity.id, calendarKey(identity.id, args.calendarId)));
    if (!ev) throw new TeamsError('Microsoft did not return the new event.');
    return ev;
  } catch (e) {
    if (e instanceof TeamsError) throw e;
    throw new TeamsError(reasonFrom(e, 'The event could not be saved.'));
  }
}

type Current = GraphEventShape & { recurrence?: { pattern?: unknown; range?: { startDate?: string; endDate?: string; type?: string } } };

async function readEvent(identity: Identity, eventId: string, timeZone: string): Promise<Current> {
  const e = await graphForIdentity(identity.id).request<Current>({
    path: `/me/events/${encodeURIComponent(eventId)}`,
    query: { $select: 'id,start,end,isOrganizer,type,seriesMasterId,recurrence' },
    headers: preferZone(timeZone),
  });
  if (!e?.id) throw new TeamsError('That event is no longer there.');
  return e;
}

/** Only the organizer changes an event: Microsoft would let an attendee alter their own copy. */
async function requireOrganizer(identity: Identity, eventId: string, timeZone: string): Promise<Current> {
  const e = await readEvent(identity, eventId, timeZone);
  if (!e.isOrganizer) throw new TeamsError('Only the organizer can change this event. You can answer it instead.');
  return e;
}

/** Moves a time of day onto another date, keeping how many days the event spans. */
function onDate(ymd: string, input: { start: string; end: string }): { start: string; end: string } {
  const days = Math.round((Date.parse(`${input.end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${input.start.slice(0, 10)}T00:00:00Z`)) / 86400_000);
  const end = new Date(`${ymd}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + days);
  return { start: `${ymd}T${input.start.slice(11)}`, end: `${end.toISOString().slice(0, 10)}T${input.end.slice(11)}` };
}

const calendarOf = async (identity: Identity, eventId: string) =>
  (await graphForIdentity(identity.id).request<{ id?: string }>({ path: `/me/events/${encodeURIComponent(eventId)}/calendar`, query: { $select: 'id' } }))?.id;

export async function updateEvent(ctx: AuthContext, args: { identityId: string; eventId: string; scope: SeriesScope; input: EventInput }): Promise<void> {
  const identity = await ownIdentity(ctx, args.identityId);
  checkInput(args.input);
  const graph = graphForIdentity(identity.id);
  const { input } = args;
  try {
    const event = await requireOrganizer(identity, args.eventId, input.timeZone);
    const masterId = event.seriesMasterId ?? (event.type === 'seriesMaster' ? event.id! : null);

    if (args.scope === 'this' || !masterId) {
      const recurrence = !masterId ? toGraphRecurrence(input.recurrence, input.start.slice(0, 10)) : null;
      await graph.request({ method: 'PATCH', path: `/me/events/${encodeURIComponent(args.eventId)}`, headers: preferZone(input.timeZone), body: { ...graphBody(input), ...(!masterId ? { recurrence } : {}) } });
      return;
    }

    const master = await readEvent(identity, masterId, input.timeZone);
    const seriesStart = master.recurrence?.range?.startDate ?? wallClock(master.start?.dateTime).slice(0, 10);
    const thisDay = wallClock(event.start?.dateTime).slice(0, 10);

    if (args.scope === 'all' || thisDay <= seriesStart) {
      // A series starts where it starts: the form's date belongs to this occurrence.
      const times = onDate(seriesStart, input);
      const recurrence = input.recurrence.kind === 'none' ? null : toGraphRecurrence(input.recurrence, seriesStart);
      await graph.request({
        method: 'PATCH',
        path: `/me/events/${encodeURIComponent(masterId)}`,
        headers: preferZone(input.timeZone),
        body: { ...graphBody({ ...input, ...times }), ...(recurrence ? { recurrence } : {}) },
      });
      return;
    }

    // "This and following": Graph has no such operation. The old series ends the day
    // before, and a new one takes over from this date, with attendees told by Microsoft.
    const calendarId = await calendarOf(identity, masterId);
    await graph.request({
      method: 'PATCH',
      path: `/me/events/${encodeURIComponent(masterId)}`,
      body: { recurrence: { pattern: master.recurrence?.pattern, range: { type: 'endDate', startDate: seriesStart, endDate: dayBefore(thisDay) } } },
    });
    const next = input.recurrence.kind === 'none' ? { pattern: master.recurrence?.pattern, range: { ...master.recurrence?.range, startDate: input.start.slice(0, 10) } } : toGraphRecurrence(input.recurrence, input.start.slice(0, 10));
    await graph.request({
      method: 'POST',
      path: calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/events` : '/me/events',
      headers: preferZone(input.timeZone),
      body: { ...graphBody(input), recurrence: next, transactionId: randomUUID() },
    });
  } catch (e) {
    if (e instanceof TeamsError) throw e;
    throw new TeamsError(reasonFrom(e, 'The event could not be saved.'));
  }
}

/**
 * Dragging on the grid: the same as editing the time, and only the time, so nothing
 * else about the event is sent back to Microsoft.
 */
export async function moveEvent(ctx: AuthContext, args: { identityId: string; eventId: string; scope: SeriesScope; start: string; end: string; timeZone: string }): Promise<void> {
  const identity = await ownIdentity(ctx, args.identityId);
  const graph = graphForIdentity(identity.id);
  const when = (start: string, end: string) => ({ start: { dateTime: `${start}:00`, timeZone: args.timeZone }, end: { dateTime: `${end}:00`, timeZone: args.timeZone } });
  try {
    const event = await requireOrganizer(identity, args.eventId, args.timeZone);
    const masterId = event.seriesMasterId ?? (event.type === 'seriesMaster' ? event.id! : null);
    if (args.scope === 'this' || !masterId) {
      await graph.request({ method: 'PATCH', path: `/me/events/${encodeURIComponent(args.eventId)}`, headers: preferZone(args.timeZone), body: when(args.start, args.end) });
      return;
    }
    const master = await readEvent(identity, masterId, args.timeZone);
    const seriesStart = master.recurrence?.range?.startDate ?? wallClock(master.start?.dateTime).slice(0, 10);
    const thisDay = wallClock(event.start?.dateTime).slice(0, 10);
    if (args.scope === 'all' || thisDay <= seriesStart) {
      const times = onDate(seriesStart, { start: args.start, end: args.end });
      await graph.request({ method: 'PATCH', path: `/me/events/${encodeURIComponent(masterId)}`, headers: preferZone(args.timeZone), body: when(times.start, times.end) });
      return;
    }
    const full = await graph.request<Record<string, unknown>>({ path: `/me/events/${encodeURIComponent(masterId)}`, query: { $select: 'subject,body,attendees,location,isOnlineMeeting,onlineMeetingProvider' } });
    const calendarId = await calendarOf(identity, masterId);
    await graph.request({
      method: 'PATCH',
      path: `/me/events/${encodeURIComponent(masterId)}`,
      body: { recurrence: { pattern: master.recurrence?.pattern, range: { type: 'endDate', startDate: seriesStart, endDate: dayBefore(thisDay) } } },
    });
    await graph.request({
      method: 'POST',
      path: calendarId ? `/me/calendars/${encodeURIComponent(calendarId)}/events` : '/me/events',
      headers: preferZone(args.timeZone),
      body: {
        subject: full?.subject,
        body: full?.body,
        attendees: full?.attendees,
        location: full?.location,
        isOnlineMeeting: full?.isOnlineMeeting,
        ...(full?.onlineMeetingProvider ? { onlineMeetingProvider: full.onlineMeetingProvider } : {}),
        ...when(args.start, args.end),
        recurrence: { pattern: master.recurrence?.pattern, range: { ...master.recurrence?.range, startDate: args.start.slice(0, 10) } },
        transactionId: randomUUID(),
      },
    });
  } catch (e) {
    if (e instanceof TeamsError) throw e;
    throw new TeamsError(reasonFrom(e, 'The event could not be moved.'));
  }
}

export async function cancelEvent(ctx: AuthContext, args: { identityId: string; eventId: string; scope: SeriesScope; timeZone: string }): Promise<void> {
  const identity = await ownIdentity(ctx, args.identityId);
  const graph = graphForIdentity(identity.id);
  try {
    const event = await requireOrganizer(identity, args.eventId, args.timeZone);
    const masterId = event.seriesMasterId ?? (event.type === 'seriesMaster' ? event.id! : null);
    if (args.scope === 'this' || !masterId) {
      await graph.request({ method: 'POST', path: `/me/events/${encodeURIComponent(args.eventId)}/cancel`, body: {} });
      return;
    }
    const master = await readEvent(identity, masterId, args.timeZone);
    const seriesStart = master.recurrence?.range?.startDate ?? wallClock(master.start?.dateTime).slice(0, 10);
    const thisDay = wallClock(event.start?.dateTime).slice(0, 10);
    if (args.scope === 'all' || thisDay <= seriesStart) {
      await graph.request({ method: 'POST', path: `/me/events/${encodeURIComponent(masterId)}/cancel`, body: {} });
      return;
    }
    await graph.request({
      method: 'PATCH',
      path: `/me/events/${encodeURIComponent(masterId)}`,
      body: { recurrence: { pattern: master.recurrence?.pattern, range: { type: 'endDate', startDate: seriesStart, endDate: dayBefore(thisDay) } } },
    });
  } catch (e) {
    if (e instanceof TeamsError) throw e;
    throw new TeamsError(reasonFrom(e, 'The event could not be cancelled.'));
  }
}

const ANSWERS = { accepted: 'accept', tentativelyAccepted: 'tentativelyAccept', declined: 'decline' } as const;

export async function answerEvent(ctx: AuthContext, args: { identityId: string; eventId: string; answer: keyof typeof ANSWERS }): Promise<void> {
  const identity = await ownIdentity(ctx, args.identityId);
  try {
    await graphForIdentity(identity.id).request({ method: 'POST', path: `/me/events/${encodeURIComponent(args.eventId)}/${ANSWERS[args.answer]}`, body: { sendResponse: true } });
  } catch (e) {
    throw new TeamsError(reasonFrom(e, 'Your answer could not be sent.'));
  }
}

/** An instant meeting. Teams opens it; if Graph refuses, Teams' own start page does. */
export async function meetNow(ctx: AuthContext, identityId: string): Promise<string> {
  const identity = await ownIdentity(ctx, identityId);
  const now = new Date();
  try {
    const m = await graphForIdentity(identity.id).request<{ joinWebUrl?: string }>({
      method: 'POST',
      path: '/me/onlineMeetings',
      body: { subject: 'Meet now', startDateTime: now.toISOString(), endDateTime: new Date(now.getTime() + 3600_000).toISOString() },
    });
    return safeHttps(m?.joinWebUrl) ?? 'https://teams.microsoft.com/l/meeting/new';
  } catch {
    return 'https://teams.microsoft.com/l/meeting/new';
  }
}

/** "Add calendar": a teammate's, if Microsoft says this account may read it. */
export async function addCalendar(ctx: AuthContext, args: { identityId: string; address: string }): Promise<void> {
  const identity = await ownIdentity(ctx, args.identityId);
  const address = args.address.trim().toLowerCase();
  let name = '';
  try {
    const owner = encodeURIComponent(address);
    await graphForIdentity(identity.id).request({ path: `/users/${owner}/calendar`, query: { $select: 'id' } });
    const person = await graphForIdentity(identity.id).request<{ displayName?: string }>({ path: `/users/${owner}`, query: { $select: 'displayName' } }).catch(() => null);
    name = person?.displayName ?? '';
  } catch (e) {
    if (e instanceof GraphError && (e.status === 403 || e.status === 404)) throw new TeamsError('That calendar has not been shared with this account. Ask them to share it in Outlook or Teams first.');
    throw new TeamsError(reasonFrom(e, 'That calendar could not be added.'));
  }
  const { error } = await supabaseAdmin().from('teams_added_calendars').upsert({ identity_id: identity.id, address, name }, { onConflict: 'identity_id,address' });
  if (error) throw new TeamsError('That calendar could not be added.');
}

export async function removeAddedCalendar(ctx: AuthContext, args: { identityId: string; addedId: string }): Promise<void> {
  const identity = await ownIdentity(ctx, args.identityId);
  await supabaseAdmin().from('teams_added_calendars').delete().eq('id', args.addedId).eq('identity_id', identity.id);
}
