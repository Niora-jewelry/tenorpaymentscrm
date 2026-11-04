'use client';

/**
 * Scheduling a call, and editing one. A failed save keeps everything the person typed
 * and shows why: the form only closes once Microsoft has the event.
 */
import dynamic from 'next/dynamic';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, Dialog } from '@/proto/ui/kit';
import type { CalEvent, CalendarEntry, EventInput, RecurrenceInput, SeriesScope } from '@/lib/msteams/types';
import type { EditorHandle } from '@/app/(app)/email/ui/Editor';
import { PeoplePicker } from '../../msteams-ui/shared';
import { createEventAction, searchPeopleAction, updateEventAction } from '../actions';
import { addDays, clockFrom, formatClock, minutesOf, spanMinutes } from './dates';
import { ScopeDialog } from './ScopeDialog';

const Editor = dynamic(() => import('@/app/(app)/email/ui/Editor'), { ssr: false, loading: () => <div className="h-[120px] rounded-md border border-line bg-canvas" /> });

export type FormSeed = {
  mode: 'new' | 'edit';
  start: string;
  end: string;
  allDay: boolean;
  teamsLink: boolean;
  eventId?: string;
  identityId?: string;
  calendarKey?: string;
  recurring?: boolean;
  subject?: string;
  location?: string;
  attendees?: { email: string; name?: string }[];
  bodyHtml?: string;
  recurrence?: RecurrenceInput;
};

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const TIME_OPTIONS = Array.from({ length: 96 }, (_, i) => i * 15);

const field = 'mt-1 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[13px] text-ink-800 outline-none focus:border-ink-500';
const labelClass = 'block text-[12px] font-semibold text-ink-600';

function TimeSelect({ label, value, onChange }: { label: string; value: number; onChange: (m: number) => void }) {
  // Keeps a time like 10:07 that came from Outlook instead of quietly rounding it.
  const options = TIME_OPTIONS.includes(value) ? TIME_OPTIONS : [...TIME_OPTIONS, value].sort((a, b) => a - b);
  return (
    <label className={labelClass}>
      {label}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} className={field}>
        {options.map((m) => (
          <option key={m} value={m}>
            {formatClock(clockFrom('2000-01-01', m))}
          </option>
        ))}
      </select>
    </label>
  );
}

export function EventForm({ seed, calendars, canSave, onClose, onSaved }: { seed: FormSeed; calendars: CalendarEntry[]; canSave: boolean; onClose: () => void; onSaved: (made: CalEvent | null) => void }) {
  const editing = seed.mode === 'edit';
  const defaultCalendar = useMemo(() => {
    if (seed.calendarKey) return seed.calendarKey;
    return (calendars.find((c) => c.isDefault) ?? calendars[0])?.key ?? '';
  }, [calendars, seed.calendarKey]);

  const [subject, setSubject] = useState(seed.subject ?? '');
  const [date, setDate] = useState(seed.start.slice(0, 10));
  const [allDay, setAllDay] = useState(seed.allDay);
  const [startMin, setStartMin] = useState(minutesOf(seed.start));
  const [length, setLength] = useState(() => Math.max(15, spanMinutes(seed.start, seed.end)));
  const [calendarKey, setCalendarKey] = useState(defaultCalendar);
  const [attendees, setAttendees] = useState(seed.attendees ?? []);
  const [location, setLocation] = useState(seed.location ?? '');
  const [teamsLink, setTeamsLink] = useState(seed.teamsLink);
  const [recurrence, setRecurrence] = useState<RecurrenceInput>(seed.recurrence ?? { kind: 'none' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [askScope, setAskScope] = useState(false);

  const editor = useRef<EditorHandle>(null);
  const bodyChanged = useRef(false);

  const calendar = calendars.find((c) => c.key === calendarKey);
  const identityId = seed.identityId ?? calendar?.identityId ?? '';

  const search = useCallback(
    async (q: string) => {
      const r = await searchPeopleAction({ identityId, q });
      return r.ok ? r.data : [];
    },
    [identityId],
  );

  const input = (): EventInput => {
    const start = allDay ? `${date}T00:00` : clockFrom(date, startMin);
    const endTotal = startMin + length;
    const end = allDay ? `${addDays(date, Math.max(1, Math.round(length / 1440)))}T00:00` : clockFrom(addDays(date, Math.floor(endTotal / 1440)), endTotal % 1440);
    return {
      subject,
      start,
      end,
      allDay,
      timeZone: timeZone(),
      attendees,
      // Left out unless it was touched, so saving a time change does not rewrite the body Microsoft holds.
      bodyHtml: editing && !bodyChanged.current ? null : (editor.current?.getHTML() ?? ''),
      teamsLink,
      location,
      recurrence,
    };
  };

  const save = async (scope: SeriesScope) => {
    setAskScope(false);
    setSaving(true);
    setError(null);
    const data = input();
    if (editing) {
      const r = await updateEventAction({ identityId, eventId: seed.eventId, scope, input: data });
      setSaving(false);
      if (r.ok) onSaved(null);
      else setError(r.message);
      return;
    }
    if (!calendar?.calendarId) {
      setSaving(false);
      setError('Pick a calendar to create this on.');
      return;
    }
    const r = await createEventAction({ identityId: calendar.identityId, calendarId: calendar.calendarId, input: data });
    setSaving(false);
    if (r.ok) onSaved(r.data);
    else setError(r.message);
  };

  const submit = () => {
    if (!subject.trim()) {
      setError('Give the event a title.');
      return;
    }
    if (editing && seed.recurring) setAskScope(true);
    else void save('this');
  };

  const accountCount = new Set(calendars.map((c) => c.identityId)).size;
  const customDays = recurrence.days ?? [];

  return (
    <>
      <Dialog title={editing ? 'Edit event' : 'New event'} onClose={onClose} width={620}>
        <div className="max-h-[68vh] space-y-3 overflow-y-auto pr-1">
          <label className={labelClass}>
            Title
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} autoFocus aria-label="Title" className={field} />
          </label>

          <div className="grid grid-cols-[1.3fr_1fr_1fr] gap-2">
            <label className={labelClass}>
              Date
              <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Date" className={field} />
            </label>
            {allDay ? (
              <div className="col-span-2" />
            ) : (
              <>
                <TimeSelect label="Start" value={startMin} onChange={setStartMin} />
                <label className={labelClass}>
                  End or duration
                  <select aria-label="End or duration" value={length} onChange={(e) => setLength(Number(e.target.value))} className={field}>
                    {[...new Set([...DURATIONS, length])]
                      .sort((a, b) => a - b)
                      .map((m) => (
                        <option key={m} value={m}>
                          {formatClock(clockFrom('2000-01-01', (startMin + m) % 1440))} ({m < 60 ? `${m} min` : `${(m / 60).toString()} h`})
                        </option>
                      ))}
                  </select>
                </label>
              </>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-700">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => {
                setAllDay(e.target.checked);
                if (e.target.checked) setLength(1440);
                else setLength(30);
              }}
            />
            All day
          </label>

          <label className={labelClass}>
            Calendar{accountCount > 1 ? ' and account' : ''}
            <select aria-label="Calendar" value={calendarKey} disabled={editing} onChange={(e) => setCalendarKey(e.target.value)} className={field}>
              {calendars.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                  {accountCount > 1 ? ` · ${c.accountEmail}` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className={labelClass}>
            Attendees
            <div className="mt-1 font-normal">
              <PeoplePicker picked={attendees} onChange={setAttendees} search={search} placeholder="Search Microsoft contacts and Tenor users" />
            </div>
          </div>

          <label className={labelClass}>
            Location
            <input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={255} className={field} />
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink-800">
            <input type="checkbox" role="switch" checked={teamsLink} disabled={editing && seed.teamsLink} onChange={(e) => setTeamsLink(e.target.checked)} aria-label="Add Teams meeting link" />
            Add Teams meeting link
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>
              Repeat
              <select aria-label="Repeat" value={recurrence.kind} onChange={(e) => setRecurrence({ ...recurrence, kind: e.target.value as RecurrenceInput['kind'] })} className={field}>
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            {recurrence.kind !== 'none' ? (
              <label className={labelClass}>
                Until (optional)
                <input type="date" value={recurrence.until ?? ''} min={date} onChange={(e) => setRecurrence({ ...recurrence, until: e.target.value })} className={field} />
              </label>
            ) : null}
          </div>
          {recurrence.kind === 'custom' ? (
            <div className="rounded-md border border-line-faint bg-canvas p-2.5">
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-700">
                Every
                <input type="number" min={1} max={99} aria-label="Repeat every" value={recurrence.interval ?? 1} onChange={(e) => setRecurrence({ ...recurrence, interval: Number(e.target.value) || 1 })} className="w-16 rounded-md border border-line bg-white px-2 py-1 text-[13px] outline-none" />
                <select aria-label="Repeat unit" value={recurrence.unit ?? 'week'} onChange={(e) => setRecurrence({ ...recurrence, unit: e.target.value as RecurrenceInput['unit'] })} className="rounded-md border border-line bg-white px-2 py-1 text-[13px] outline-none">
                  <option value="day">day(s)</option>
                  <option value="week">week(s)</option>
                  <option value="month">month(s)</option>
                </select>
              </div>
              {(recurrence.unit ?? 'week') === 'week' ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {WEEKDAYS.map((d) => {
                    const on = customDays.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setRecurrence({ ...recurrence, days: on ? customDays.filter((x) => x !== d) : [...customDays, d] })}
                        className={`cursor-pointer rounded-md border px-2 py-0.5 text-[12px] font-medium capitalize ${on ? 'border-brand-900 bg-brand-900 text-white' : 'border-line bg-white text-ink-700'}`}
                      >
                        {d.slice(0, 3)}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className={labelClass}>
            Description
            <div className="mt-1 overflow-hidden rounded-md border border-line font-normal">
              <Editor
                initialHTML={seed.bodyHtml ?? ''}
                placeholder="Add a description"
                minHeight={110}
                handleRef={editor}
                onChange={() => {
                  bodyChanged.current = true;
                }}
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-md border border-[#f7cfd1] bg-[#fce9ea] px-3 py-2 text-[12.5px] font-medium text-[#b02a30]">
              {error}
            </p>
          ) : null}
        </div>
        <div className="mt-3 flex justify-end gap-2 border-t border-line-faint pt-3">
          {!canSave ? <span className="mr-auto self-center text-[12px] text-ink-500">You are offline. Saving is switched off.</span> : null}
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={submit}>
            {editing ? 'Save' : 'Save and send'}
          </Button>
        </div>
      </Dialog>
      {askScope ? <ScopeDialog verb="Save" onPick={(s) => void save(s)} onCancel={() => setAskScope(false)} /> : null}
    </>
  );
}
