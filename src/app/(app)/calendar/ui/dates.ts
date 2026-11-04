/**
 * Dates for the grid. Events arrive as wall-clock strings in the viewer's zone, so this
 * is arithmetic on yyyy-mm-dd and minutes. Going through `Date` with a time would bring
 * daylight saving back in. Pure, so it is tested without a browser.
 */
import type { CalEvent } from '@/lib/msteams/types';

export type CalView = 'workweek' | 'day' | 'week' | 'month';

export const VIEW_LABEL: Record<CalView, string> = { workweek: 'Work week', day: 'Day', week: 'Week', month: 'Month' };

const pad = (n: number) => String(n).padStart(2, '0');

export const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Noon, so no daylight-saving change can move it onto another day. */
export const dateOf = (ymd: string) => new Date(`${ymd}T12:00:00`);

export function addDays(ymd: string, n: number): string {
  const d = dateOf(ymd);
  d.setDate(d.getDate() + n);
  return ymdOf(d);
}

export function addMonths(ymd: string, n: number): string {
  const d = dateOf(ymd);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return ymdOf(d);
}

const startOfWeek = (ymd: string) => addDays(ymd, -dateOf(ymd).getDay());

export function daysInView(view: CalView, anchor: string): string[] {
  if (view === 'day') return [anchor];
  if (view === 'month') {
    const d = dateOf(anchor);
    const first = ymdOf(new Date(d.getFullYear(), d.getMonth(), 1, 12));
    const start = startOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }
  const start = startOfWeek(anchor);
  return view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(start, i)) : Array.from({ length: 5 }, (_, i) => addDays(start, i + 1));
}

export function stepView(view: CalView, anchor: string, dir: 1 | -1): string {
  if (view === 'month') return addMonths(anchor, dir);
  return addDays(anchor, view === 'day' ? dir : dir * 7);
}

export function rangeLabel(view: CalView, anchor: string): string {
  const days = daysInView(view, anchor);
  const a = dateOf(days[0]!);
  const b = dateOf(days[days.length - 1]!);
  if (view === 'month') return dateOf(anchor).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  if (view === 'day') return a.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  // Put together by hand: asking Intl for just a day and a year gives "2026 (day: 6)".
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'long' });
  if (a.getFullYear() !== b.getFullYear()) return `${month(a)} ${a.getDate()}, ${a.getFullYear()} – ${month(b)} ${b.getDate()}, ${b.getFullYear()}`;
  if (a.getMonth() !== b.getMonth()) return `${month(a)} ${a.getDate()} – ${month(b)} ${b.getDate()}, ${b.getFullYear()}`;
  return `${month(a)} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`;
}

/** What to ask Microsoft for: the whole local days on screen, in UTC. */
export function fetchRange(view: CalView, anchor: string): { start: string; end: string } {
  const days = daysInView(view, anchor);
  return { start: new Date(`${days[0]}T00:00:00`).toISOString(), end: new Date(`${addDays(days[days.length - 1]!, 1)}T00:00:00`).toISOString() };
}

export const minutesOf = (clock: string) => Number(clock.slice(11, 13)) * 60 + Number(clock.slice(14, 16));

export const clockFrom = (ymd: string, minutes: number) => `${ymd}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** Whole minutes from one wall clock to another, across days. */
export function spanMinutes(start: string, end: string): number {
  const days = Math.round((Date.parse(`${end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${start.slice(0, 10)}T00:00:00Z`)) / 86400_000);
  return days * 1440 + minutesOf(end) - minutesOf(start);
}

/** A wall clock moved by some minutes, across days if it has to. */
export function shiftClock(clock: string, by: number): string {
  const total = minutesOf(clock) + by;
  const days = Math.floor(total / 1440);
  return clockFrom(addDays(clock.slice(0, 10), days), ((total % 1440) + 1440) % 1440);
}

export function formatClock(clock: string): string {
  const m = minutesOf(clock);
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(m % 60)} ${h < 12 ? 'AM' : 'PM'}`;
}

export function formatWhen(e: Pick<CalEvent, 'start' | 'end' | 'allDay'>): string {
  const day = dateOf(e.start.slice(0, 10)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (e.allDay) return `${day}, all day`;
  const sameDay = e.start.slice(0, 10) === e.end.slice(0, 10);
  return sameDay ? `${day}, ${formatClock(e.start)} – ${formatClock(e.end)}` : `${day}, ${formatClock(e.start)} – ${dateOf(e.end.slice(0, 10)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${formatClock(e.end)}`;
}

/** Does this event show on this day? An all-day event's end is the midnight after it. */
export function occursOn(e: Pick<CalEvent, 'start' | 'end' | 'allDay'>, ymd: string): boolean {
  const first = e.start.slice(0, 10);
  const last = e.allDay || minutesOf(e.end) === 0 ? addDays(e.end.slice(0, 10), -1) : e.end.slice(0, 10);
  return first <= ymd && ymd <= (last < first ? first : last);
}

export type Placed = { event: CalEvent; top: number; height: number; column: number; columns: number };

/** Lays one day's timed events side by side where they overlap, as Teams does. */
export function placeDay(events: CalEvent[], ymd: string, hourHeight: number): Placed[] {
  const parts = events
    .map((event) => {
      const from = event.start.slice(0, 10) < ymd ? 0 : minutesOf(event.start);
      const to = event.end.slice(0, 10) > ymd ? 1440 : minutesOf(event.end);
      return { event, from, to: Math.max(to, from + 15) };
    })
    .sort((a, b) => a.from - b.from || b.to - a.to);

  const placed: Placed[] = [];
  let group: typeof parts = [];
  let groupEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    const cols = group.map((p) => {
      let col = ends.findIndex((end) => end <= p.from);
      if (col === -1) col = ends.length;
      ends[col] = p.to;
      return col;
    });
    group.forEach((p, i) => {
      placed.push({ event: p.event, top: (p.from / 60) * hourHeight, height: Math.max(((p.to - p.from) / 60) * hourHeight - 2, 18), column: cols[i]!, columns: ends.length });
    });
    group = [];
  };
  for (const part of parts) {
    if (group.length > 0 && part.from >= groupEnd) {
      flush();
      groupEnd = -1;
    }
    group.push(part);
    groupEnd = Math.max(groupEnd, part.to);
  }
  if (group.length > 0) flush();
  return placed;
}
