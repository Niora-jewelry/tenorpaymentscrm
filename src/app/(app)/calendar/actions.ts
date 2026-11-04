'use server';

/** Calendar's changes. Each one parses, authorizes and goes through `ownIdentity`. */
import { z } from 'zod';
import { authorize, type AuthContext } from '@/lib/records/permissions';
import { TeamsError } from '@/lib/msteams/access';
import { addCalendar, answerEvent, cancelEvent, createEvent, eventDetail, meetNow, moveEvent, removeAddedCalendar, updateEvent } from '@/lib/msteams/calendar';
import { searchPeople } from '@/lib/msteams/people';
import type { CalEvent, EventDetail, PersonResult } from '@/lib/msteams/types';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';

export type Result<T> = { ok: true; data: T } | { ok: false; message: string };

async function run<T>(work: (ctx: AuthContext) => Promise<T>, fallback: string): Promise<Result<T>> {
  try {
    const ctx = await authorize();
    const limit = await rateLimit(userKey('teams_action', ctx.userId), RATE_LIMITS.teamsActionPerUser);
    if (!limit.allowed) return { ok: false, message: 'Too many changes at once. Wait a moment and try again.' };
    return { ok: true, data: await work(ctx) };
  } catch (e) {
    if (e instanceof TeamsError) return { ok: false, message: e.message };
    console.error('[calendar] action failed', e instanceof Error ? e.name : 'unknown');
    return { ok: false, message: fallback };
  }
}

const Id = z.string().min(1).max(1024);
const Identity = z.uuid();
const Scope = z.enum(['this', 'following', 'all']);
const Zone = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/);
const Clock = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const Ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Recurrence = z.object({
  kind: z.enum(['none', 'daily', 'weekly', 'monthly', 'custom']),
  interval: z.number().int().min(1).max(99).optional(),
  unit: z.enum(['day', 'week', 'month']).optional(),
  days: z.array(z.enum(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'])).max(7).optional(),
  until: Ymd.or(z.literal('')).optional().transform((v) => v || undefined),
});

const Input = z.object({
  subject: z.string().max(255),
  start: Clock,
  end: Clock,
  allDay: z.boolean(),
  timeZone: Zone,
  attendees: z.array(z.object({ email: z.email().max(254), name: z.string().max(200).optional() })).max(200),
  bodyHtml: z.string().max(200_000).nullable(),
  teamsLink: z.boolean(),
  location: z.string().max(255),
  recurrence: Recurrence,
});

const INVALID = 'Check the details and try again.';

export async function createEventAction(raw: unknown): Promise<Result<CalEvent>> {
  const p = z.object({ identityId: Identity, calendarId: Id, input: Input }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run((ctx) => createEvent(ctx, p.data), 'The event could not be saved.');
}

export async function updateEventAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ identityId: Identity, eventId: Id, scope: Scope, input: Input }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(async (ctx) => {
    await updateEvent(ctx, p.data);
    return null;
  }, 'The event could not be saved.');
}

export async function moveEventAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ identityId: Identity, eventId: Id, scope: Scope, start: Clock, end: Clock, timeZone: Zone }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(async (ctx) => {
    await moveEvent(ctx, p.data);
    return null;
  }, 'The event could not be moved.');
}

export async function cancelEventAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ identityId: Identity, eventId: Id, scope: Scope, timeZone: Zone }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(async (ctx) => {
    await cancelEvent(ctx, p.data);
    return null;
  }, 'The event could not be cancelled.');
}

export async function answerEventAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ identityId: Identity, eventId: Id, answer: z.enum(['accepted', 'tentativelyAccepted', 'declined']) }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(async (ctx) => {
    await answerEvent(ctx, p.data);
    return null;
  }, 'Your answer could not be sent.');
}

export async function eventDetailAction(raw: unknown): Promise<Result<EventDetail>> {
  const p = z.object({ identityId: Identity, eventId: Id, address: z.email().max(254).nullable().optional() }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run((ctx) => eventDetail(ctx, p.data), 'The event could not be opened.');
}

export async function meetNowAction(raw: unknown): Promise<Result<string>> {
  const p = z.object({ identityId: Identity }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run((ctx) => meetNow(ctx, p.data.identityId), 'The meeting could not be started.');
}

export async function addCalendarAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ identityId: Identity, address: z.email().max(254) }).safeParse(raw);
  if (!p.success) return { ok: false, message: 'Enter the person’s email address.' };
  return run(async (ctx) => {
    await addCalendar(ctx, p.data);
    return null;
  }, 'That calendar could not be added.');
}

export async function removeCalendarAction(raw: unknown): Promise<Result<null>> {
  const p = z.object({ identityId: Identity, addedId: z.uuid() }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run(async (ctx) => {
    await removeAddedCalendar(ctx, p.data);
    return null;
  }, 'That calendar could not be removed.');
}

export async function searchPeopleAction(raw: unknown): Promise<Result<PersonResult[]>> {
  const p = z.object({ identityId: Identity, q: z.string().max(100) }).safeParse(raw);
  if (!p.success) return { ok: false, message: INVALID };
  return run((ctx) => searchPeople(ctx, p.data), 'People could not be searched.');
}
