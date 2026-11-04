'use client';

/** The two grids: hours by days, and the month. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import type { CalEvent, CalendarEntry } from '@/lib/msteams/types';
import { clockFrom, dateOf, formatClock, minutesOf, occursOn, placeDay, shiftClock, spanMinutes, ymdOf } from './dates';

const HOUR = 52;
const SNAP = 15;
const FALLBACK = '#2752a3';

const colorOf = (calendars: CalendarEntry[]) => {
  const map = new Map(calendars.map((c) => [c.key, c.color]));
  return (e: CalEvent) => map.get(e.calendarKey) ?? FALLBACK;
};

/** Faded while unanswered, struck through when declined, as Teams shows them. */
const answerStyle = (e: CalEvent): string => (e.response === 'declined' ? 'line-through opacity-60' : e.response === 'notResponded' ? 'opacity-80' : '');

const hourLabel = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

type Drag = { event: CalEvent; startY: number; startX: number; dayIndex: number; offsetMinutes: number; moved: boolean; dayDelta: number; minuteDelta: number };

export function WeekGrid({ days, events, calendars, canChange, onOpen, onSlot, onDrop }: { days: string[]; events: CalEvent[]; calendars: CalendarEntry[]; canChange: boolean; onOpen: (e: CalEvent) => void; onSlot: (start: string, end: string, allDay: boolean) => void; onDrop: (e: CalEvent, start: string, end: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const today = ymdOf(new Date());
  const color = useMemo(() => colorOf(calendars), [calendars]);

  // Opens at the start of the working day, as Teams does.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = HOUR * 7.5;
  }, []);

  const [nowMinutes, setNowMinutes] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setNowMinutes(d.getHours() * 60 + d.getMinutes());
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);

  const allDay = (ymd: string) => events.filter((e) => e.allDay && occursOn(e, ymd));
  const timed = (ymd: string) => events.filter((e) => !e.allDay && occursOn(e, ymd));
  const hasAllDay = days.some((d) => allDay(d).length > 0);

  const canDrag = (e: CalEvent) => canChange && e.isOrganizer && !e.readOnly;

  const startDrag = (event: CalEvent, dayIndex: number, ev: React.PointerEvent) => {
    if (!canDrag(event) || ev.button !== 0) return;
    ev.stopPropagation();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    const d: Drag = { event, startY: ev.clientY, startX: ev.clientX, dayIndex, offsetMinutes: 0, moved: false, dayDelta: 0, minuteDelta: 0 };
    dragRef.current = d;
    setDrag(d);
  };

  const moveDrag = (ev: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = ev.clientY - d.startY;
    const dx = ev.clientX - d.startX;
    if (!d.moved && Math.abs(dy) < 5 && Math.abs(dx) < 5) return;
    const width = (columns.current?.clientWidth ?? 1) / days.length;
    const dayDelta = Math.max(-d.dayIndex, Math.min(days.length - 1 - d.dayIndex, Math.round(dx / width)));
    const minuteDelta = Math.round(((dy / HOUR) * 60) / SNAP) * SNAP;
    const next = { ...d, moved: true, dayDelta, minuteDelta };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    if (!d.moved) {
      onOpen(d.event);
      return;
    }
    const by = d.dayDelta * 1440 + d.minuteDelta;
    if (by === 0) return;
    onDrop(d.event, shiftClock(d.event.start, by), shiftClock(d.event.end, by));
  };

  const slotClick = (ymd: string, ev: React.MouseEvent<HTMLDivElement>) => {
    if (!canChange || ev.target !== ev.currentTarget) return;
    const y = ev.clientY - ev.currentTarget.getBoundingClientRect().top;
    const minutes = Math.min(1410, Math.floor(((y / HOUR) * 60) / 30) * 30);
    onSlot(clockFrom(ymd, minutes), clockFrom(ymd, Math.min(1439, minutes + 30)), false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex border-b border-line pr-[10px]">
        <div className="w-[60px] shrink-0" />
        <div className="grid min-w-0 flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
          {days.map((ymd) => {
            const d = dateOf(ymd);
            const isToday = ymd === today;
            return (
              <div key={ymd} className="border-l border-line-faint px-2 py-1.5">
                <div className={`flex items-baseline gap-1.5 ${isToday ? 'text-brand-700' : 'text-ink-700'}`}>
                  <span className={`text-[18px] font-semibold ${isToday ? 'underline decoration-2 underline-offset-4' : ''}`}>{d.getDate()}</span>
                  <span className="text-[12px] font-medium">{d.toLocaleDateString('en-US', { weekday: 'long' })}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hasAllDay ? (
        <div className="flex border-b border-line pr-[10px]">
          <div className="w-[60px] shrink-0 px-1 py-1 text-right text-[10.5px] text-ink-400">All day</div>
          <div className="grid min-w-0 flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((ymd) => (
              <div key={ymd} className="flex min-w-0 flex-col gap-0.5 border-l border-line-faint p-0.5">
                {allDay(ymd).map((e) => (
                  <button key={e.key} type="button" onClick={() => onOpen(e)} style={{ background: `${color(e)}22`, borderLeftColor: color(e) }} className={`cursor-pointer truncate rounded-sm border-l-[3px] px-1.5 py-0.5 text-left text-[11.5px] font-medium text-ink-800 ${answerStyle(e)}`}>
                    {e.subject}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-scroll">
        <div className="flex" style={{ height: HOUR * 24 }}>
          <div className="w-[60px] shrink-0">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} style={{ height: HOUR }} className="-translate-y-2 pr-2 text-right text-[10.5px] text-ink-400">
                {h === 0 ? '' : hourLabel(h)}
              </div>
            ))}
          </div>
          <div ref={columns} className="grid min-w-0 flex-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((ymd, dayIndex) => (
              <div
                key={ymd}
                data-day={ymd}
                onClick={(ev) => slotClick(ymd, ev)}
                className={`relative border-l border-line-faint ${canChange ? 'cursor-pointer' : ''}`}
                style={{ backgroundImage: `repeating-linear-gradient(to bottom, var(--color-line-faint) 0, var(--color-line-faint) 1px, transparent 1px, transparent ${HOUR / 2}px)` }}
              >
                {placeDay(timed(ymd), ymd, HOUR).map((p) => {
                  const e = p.event;
                  const dragging = drag?.event.key === e.key && drag.moved;
                  const width = 100 / p.columns;
                  return (
                    <div
                      key={e.key}
                      data-event={e.subject}
                      role="button"
                      tabIndex={0}
                      onPointerDown={(ev) => {
                        if (canDrag(e)) startDrag(e, dayIndex, ev);
                      }}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (!canDrag(e)) onOpen(e);
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') onOpen(e);
                      }}
                      style={{
                        top: p.top + (dragging ? (drag.minuteDelta / 60) * HOUR : 0),
                        height: p.height,
                        left: `calc(${p.column * width}% + 1px)`,
                        width: `calc(${width}% - 3px)`,
                        background: `${color(e)}22`,
                        borderLeftColor: color(e),
                        transform: dragging ? `translateX(${drag.dayDelta * 100 * p.columns}%)` : undefined,
                        zIndex: dragging ? 20 : 1,
                      }}
                      className={`absolute touch-none overflow-hidden rounded-sm border-l-[3px] px-1.5 py-0.5 text-left text-[11.5px] leading-tight text-ink-800 hover:brightness-95 ${canDrag(e) ? 'cursor-grab' : 'cursor-pointer'} ${answerStyle(e)}`}
                    >
                      <div className="truncate font-semibold">{e.subject}</div>
                      {p.height > 34 ? <div className="truncate text-[10.5px] text-ink-500">{dragging ? `${formatClock(shiftClock(e.start, drag.dayDelta * 1440 + drag.minuteDelta))}` : `${formatClock(e.start)} – ${formatClock(e.end)}`}</div> : null}
                      {e.joinUrl && p.height > 50 ? (
                        <a href={e.joinUrl} target="_blank" rel="noopener noreferrer" onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => ev.stopPropagation()} className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-semibold text-brand-700 hover:underline">
                          <Icon name="video" size={10} /> Join
                        </a>
                      ) : null}
                    </div>
                  );
                })}
                {ymd === today && nowMinutes !== null ? (
                  <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-bad" style={{ top: (nowMinutes / 60) * HOUR }}>
                    <span className="absolute -left-1 -top-[3px] size-2 rounded-full bg-bad" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MonthGrid({ days, anchor, events, calendars, onOpen, onSlot, onDay }: { days: string[]; anchor: string; events: CalEvent[]; calendars: CalendarEntry[]; onOpen: (e: CalEvent) => void; onSlot: (ymd: string) => void; onDay: (ymd: string) => void }) {
  const color = useMemo(() => colorOf(calendars), [calendars]);
  const today = ymdOf(new Date());
  const month = dateOf(anchor).getMonth();
  const MAX_SHOWN = 3;
  return (
    <div className="flex h-full flex-col">
      <div className="grid grid-cols-7 border-b border-line">
        {days.slice(0, 7).map((ymd) => (
          <div key={ymd} className="border-l border-line-faint px-2 py-1 text-[11.5px] font-semibold text-ink-500">
            {dateOf(ymd).toLocaleDateString('en-US', { weekday: 'short' })}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((ymd) => {
          const list = events.filter((e) => occursOn(e, ymd)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || minutesOf(a.start) - minutesOf(b.start));
          const inMonth = dateOf(ymd).getMonth() === month;
          return (
            <div
              key={ymd}
              data-day={ymd}
              onClick={(ev) => {
                if (ev.target === ev.currentTarget) onSlot(ymd);
              }}
              className={`min-h-0 overflow-hidden border-b border-l border-line-faint p-1 ${inMonth ? '' : 'bg-canvas'}`}
            >
              <button type="button" onClick={() => onDay(ymd)} className={`mb-0.5 cursor-pointer rounded px-1 text-[12px] hover:bg-canvas ${ymd === today ? 'bg-brand-900 font-semibold text-white hover:bg-brand-800' : inMonth ? 'font-medium text-ink-700' : 'text-ink-400'}`}>
                {dateOf(ymd).getDate()}
              </button>
              <div className="flex flex-col gap-0.5">
                {list.slice(0, MAX_SHOWN).map((e) => (
                  <button key={e.key} type="button" data-event={e.subject} onClick={() => onOpen(e)} style={{ background: `${color(e)}22`, borderLeftColor: color(e) }} className={`cursor-pointer truncate rounded-sm border-l-[3px] px-1 text-left text-[11px] text-ink-800 ${answerStyle(e)}`}>
                    {e.allDay ? '' : `${formatClock(e.start)} `}
                    {e.subject}
                  </button>
                ))}
                {list.length > MAX_SHOWN ? (
                  <button type="button" onClick={() => onDay(ymd)} className="cursor-pointer px-1 text-left text-[10.5px] font-semibold text-brand-700 hover:underline">
                    {list.length - MAX_SHOWN} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const durationOf = spanMinutes;
