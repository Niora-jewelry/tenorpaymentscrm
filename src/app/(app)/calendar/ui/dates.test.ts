import { describe, expect, it } from 'vitest';
import { addMonths, daysInView, occursOn, placeDay, rangeLabel, shiftClock, spanMinutes, stepView } from './dates';
import type { CalEvent } from '@/lib/msteams/types';

const ev = (start: string, end: string, extra: Partial<CalEvent> = {}) => ({ key: start + end, start, end, allDay: false, ...extra }) as CalEvent;

describe('views', () => {
  it('work week is Monday to Friday, week is Sunday to Saturday, month is six weeks', () => {
    expect(daysInView('workweek', '2026-11-04')).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    expect(daysInView('week', '2026-11-04')[0]).toBe('2026-11-01');
    expect(daysInView('week', '2026-11-04')).toHaveLength(7);
    const month = daysInView('month', '2026-11-18');
    expect(month).toHaveLength(42);
    expect(month[0]).toBe('2026-11-01');
    expect(daysInView('day', '2026-11-04')).toEqual(['2026-11-04']);
  });

  it('steps by the view, and a month step keeps the day where it can', () => {
    expect(stepView('workweek', '2026-11-04', 1)).toBe('2026-11-11');
    expect(stepView('day', '2026-11-30', 1)).toBe('2026-12-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});

describe('range label', () => {
  it('reads like Teams in a month, across months and across years', () => {
    expect(rangeLabel('workweek', '2026-11-04')).toBe('November 2 – 6, 2026');
    expect(rangeLabel('week', '2026-11-30')).toBe('November 29 – December 5, 2026');
    expect(rangeLabel('week', '2026-12-30')).toBe('December 27, 2026 – January 2, 2027');
    expect(rangeLabel('month', '2026-11-18')).toBe('November 2026');
    expect(rangeLabel('day', '2026-11-04')).toBe('Wednesday, November 4, 2026');
  });
});

describe('moving and lengths', () => {
  it('moves across midnight and across days', () => {
    expect(shiftClock('2026-11-04T23:30', 45)).toBe('2026-11-05T00:15');
    expect(shiftClock('2026-11-04T00:15', -30)).toBe('2026-11-03T23:45');
    expect(shiftClock('2026-11-04T09:00', 1440 * 2 + 60)).toBe('2026-11-06T10:00');
    expect(spanMinutes('2026-11-04T23:00', '2026-11-05T01:00')).toBe(120);
  });

  it('puts an all-day event on its days only, not the day its end midnight falls on', () => {
    const allDay = ev('2026-11-04T00:00', '2026-11-06T00:00', { allDay: true });
    expect(occursOn(allDay, '2026-11-04')).toBe(true);
    expect(occursOn(allDay, '2026-11-05')).toBe(true);
    expect(occursOn(allDay, '2026-11-06')).toBe(false);
  });
});

describe('placeDay', () => {
  it('puts overlapping events side by side and a later one back to full width', () => {
    const placed = placeDay([ev('2026-11-04T09:00', '2026-11-04T10:00'), ev('2026-11-04T09:30', '2026-11-04T10:30'), ev('2026-11-04T11:00', '2026-11-04T12:00')], '2026-11-04', 60);
    expect(placed.map((p) => [p.column, p.columns])).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
    expect(placed[0]!.top).toBe(540);
  });
});
