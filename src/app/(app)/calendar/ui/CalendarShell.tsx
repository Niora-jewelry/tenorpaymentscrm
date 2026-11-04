'use client';

/**
 * The Calendar screen: Teams' layout, Microsoft's data.
 *
 * Everything shown is read from Microsoft each minute and after every change, so a
 * change made in Teams or Outlook arrives by itself and Microsoft's version wins.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Popover, Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { CalEvent, CalendarData, SeriesScope } from '@/lib/msteams/types';
import { goToMicrosoft, connectHref, Notice, PersonPicker, StatusNotices, useOnline } from '../../msteams-ui/shared';
import type { ModulePage } from '../../msteams-ui/page-data';
import { meetNowAction, moveEventAction } from '../actions';
import { addDays, dateOf, daysInView, fetchRange, rangeLabel, stepView, VIEW_LABEL, ymdOf, type CalView } from './dates';
import { WeekGrid, MonthGrid } from './Grids';
import { MiniMonth } from './MiniMonth';
import { CalendarList } from './CalendarList';
import { EventCard } from './EventCard';
import { EventForm, type FormSeed } from './EventForm';
import { ScopeDialog } from './ScopeDialog';

const POLL_MS = 60_000;
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export type Filters = { teamsOnly: boolean; organizerOnly: boolean; unanswered: boolean; hideDeclined: boolean };
const NO_FILTERS: Filters = { teamsOnly: false, organizerOnly: false, unanswered: false, hideDeclined: false };

const HIDDEN_KEY = 'calendar.hidden.v1';
function readHidden(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function CalendarShell({ page }: { page: ModulePage }) {
  const online = useOnline();
  const lookOnly = !page.own;
  const [view, setView] = useState<CalView>('workweek');
  const [anchor, setAnchor] = useState(() => ymdOf(new Date()));
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(page.refused);
  const [hidden, setHidden] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [open, setOpen] = useState<CalEvent | null>(null);
  const [form, setForm] = useState<FormSeed | null>(null);
  const [pendingMove, setPendingMove] = useState<{ event: CalEvent; start: string; end: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- browser storage exists only here
    setHidden(readHidden());
  }, []);

  const lastLoad = useRef(0);
  const load = useCallback(async () => {
    if (page.refused) return;
    const stamp = Date.now();
    lastLoad.current = stamp;
    const range = fetchRange(view, anchor);
    const q = new URLSearchParams({ ...range, timeZone: timeZone() });
    if (!page.own) q.set('as', page.ownerId);
    try {
      const res = await fetch(`/api/msteams/calendar?${q.toString()}`, { cache: 'no-store' });
      if (lastLoad.current !== stamp) {
        // A newer load replaced this one: close its response instead of leaving it open.
        void res.body?.cancel().catch(() => undefined);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setLoadError(body?.message ?? 'The calendar could not be loaded.');
        return;
      }
      setData((await res.json()) as CalendarData);
      setLoadError(null);
    } catch {
      // Offline or the server is unreachable: what is on screen stays, and the banner says so.
      if (lastLoad.current === stamp && navigator.onLine) setLoadError('The calendar could not be loaded.');
    } finally {
      if (lastLoad.current === stamp) setLoading(false);
    }
  }, [anchor, page.own, page.ownerId, page.refused, view]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the range on screen changed
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void load();
    }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const toggleCalendar = (key: string) => {
    setHidden((cur) => {
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
      } catch {
        // Only a convenience: it works for this visit either way.
      }
      return next;
    });
  };
  const showAll = () => {
    setHidden([]);
    try {
      localStorage.removeItem(HIDDEN_KEY);
    } catch {
      // As above.
    }
  };

  const filtered = Object.values(filters).some(Boolean);
  const events = useMemo(() => {
    const off = new Set(hidden);
    return (data?.events ?? []).filter((e) => {
      if (off.has(e.calendarKey) || e.isCancelled) return false;
      if (filters.teamsOnly && !e.joinUrl) return false;
      if (filters.organizerOnly && !e.isOrganizer) return false;
      if (filters.unanswered && (e.isOrganizer || e.response !== 'notResponded')) return false;
      if (filters.hideDeclined && e.response === 'declined') return false;
      return true;
    });
  }, [data?.events, filters, hidden]);

  const writable = (data?.calendars ?? []).filter((c) => c.canEdit && c.calendarId);
  const canChange = online && !lookOnly;
  const days = daysInView(view, anchor);

  const newEvent = (seed: Partial<FormSeed> = {}) => {
    if (!canChange || writable.length === 0) return;
    const day = seed.start?.slice(0, 10) ?? anchor;
    setForm({ mode: 'new', start: seed.start ?? `${day}T09:00`, end: seed.end ?? `${day}T09:30`, allDay: seed.allDay ?? false, teamsLink: seed.teamsLink ?? true });
  };

  const applyMove = async (event: CalEvent, start: string, end: string, scope: SeriesScope) => {
    // Shown where it was dropped at once. Microsoft's answer replaces it on the next read.
    setData((d) => (d ? { ...d, events: d.events.map((x) => (x.key === event.key ? { ...x, start, end } : x)) } : d));
    const r = await moveEventAction({ identityId: event.identityId, eventId: event.id, scope, start, end, timeZone: timeZone() });
    if (!r.ok) setNotice(r.message);
    await load();
  };

  const onDrop = (event: CalEvent, start: string, end: string) => {
    if (event.type === 'singleInstance') void applyMove(event, start, end, 'this');
    else setPendingMove({ event, start, end });
  };

  const meetNow = async () => {
    const account = writable[0];
    if (!account) return;
    // Opened before the wait, or the browser treats it as an unasked-for pop-up.
    const tab = window.open('about:blank', '_blank');
    const r = await meetNowAction({ identityId: account.identityId });
    if (!r.ok) {
      tab?.close();
      setNotice(r.message);
      return;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = r.data;
    } else {
      window.location.href = r.data;
    }
  };

  const ownerName = page.people.find((p) => p.userId === page.ownerId)?.name ?? 'someone else';

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <h1 className="mr-2 text-[17px] font-semibold tracking-[-.01em] text-ink-900">Calendar</h1>
        <Button variant="secondary" size="sm" onClick={() => setAnchor(ymdOf(new Date()))}>
          Today
        </Button>
        <span className="inline-flex items-center">
          <button type="button" aria-label="Previous" onClick={() => setAnchor((a) => stepView(view, a, -1))} className="grid size-7 cursor-pointer place-items-center rounded-md text-ink-600 hover:bg-canvas">
            <Icon name="chevron-left" size={16} />
          </button>
          <button type="button" aria-label="Next" onClick={() => setAnchor((a) => stepView(view, a, 1))} className="grid size-7 cursor-pointer place-items-center rounded-md text-ink-600 hover:bg-canvas">
            <Icon name="chevron-right" size={16} />
          </button>
        </span>
        <span data-testid="range" className="text-[14px] font-semibold text-ink-800">
          {rangeLabel(view, anchor)}
        </span>
        {loading ? <Spinner className="ml-1 size-3.5 text-ink-400" /> : null}
        <span className="flex-1" />
        <PersonPicker people={page.people} value={page.ownerId} label="Whose calendar" />
        {filtered ? <span className="text-[12px] font-semibold text-brand-700">Filter applied</span> : null}
        <FilterMenu filters={filters} onChange={setFilters} />
        <Button variant="secondary" size="sm" icon="video" disabled={!canChange || writable.length === 0} onClick={() => void meetNow()}>
          Meet now
        </Button>
        <NewMenu disabled={!canChange || writable.length === 0} onPick={(teamsLink) => newEvent({ teamsLink })} />
        <label className="sr-only" htmlFor="cal-view">
          View
        </label>
        <select id="cal-view" value={view} onChange={(e) => setView(e.target.value as CalView)} className="cursor-pointer rounded-md border border-line bg-white px-2 py-1 text-[12.5px] font-semibold text-ink-800 outline-none hover:border-ink-400">
          {(Object.keys(VIEW_LABEL) as CalView[]).map((v) => (
            <option key={v} value={v}>
              {VIEW_LABEL[v]}
            </option>
          ))}
        </select>
      </header>

      <StatusNotices
        kind="calendar"
        online={online}
        stale={data?.stale ?? null}
        accounts={page.own ? page.accounts : page.shownAccounts}
        lookingAt={lookOnly ? ownerName : null}
        waiting={page.waiting}
        onApprove={page.own ? (email) => goToMicrosoft(connectHref('calendar', email)) : undefined}
      />
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      {notice ? (
        <Notice
          tone="error"
          action={
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0">
              <Icon name="x" size={13} />
            </button>
          }
        >
          {notice}
        </Notice>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[244px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-line px-3 py-4 lg:flex">
          <MiniMonth anchor={anchor} highlighted={view === 'month' ? [] : days} onPick={setAnchor} />
          <CalendarList calendars={data?.calendars ?? []} hidden={hidden} onToggle={toggleCalendar} onShowAll={showAll} canChange={canChange} onChanged={() => void load()} />
        </aside>
        <main className="min-w-0 flex-1">
          {view === 'month' ? (
            <MonthGrid
              days={days}
              anchor={anchor}
              events={events}
              calendars={data?.calendars ?? []}
              onOpen={setOpen}
              onSlot={(ymd) => {
                if (canChange) newEvent({ start: `${ymd}T09:00`, end: `${ymd}T09:30` });
              }}
              onDay={(ymd) => {
                setAnchor(ymd);
                setView('day');
              }}
            />
          ) : (
            <WeekGrid days={days} events={events} calendars={data?.calendars ?? []} canChange={canChange} onOpen={setOpen} onSlot={(start, end, allDay) => newEvent({ start, end, allDay })} onDrop={onDrop} />
          )}
        </main>
      </div>

      {open ? (
        <EventCard
          event={open}
          calendars={data?.calendars ?? []}
          canChange={canChange}
          onClose={() => setOpen(null)}
          onEdit={(seed) => {
            setOpen(null);
            setForm(seed);
          }}
          onChanged={() => void load()}
        />
      ) : null}
      {form ? (
        <EventForm
          seed={form}
          calendars={writable}
          canSave={online}
          onClose={() => setForm(null)}
          onSaved={(made) => {
            if (made) setData((d) => (d ? { ...d, events: [...d.events, made] } : d));
            setForm(null);
            void load();
          }}
        />
      ) : null}
      {pendingMove ? (
        <ScopeDialog
          verb="Move"
          onCancel={() => setPendingMove(null)}
          onPick={(scope) => {
            const { event, start, end } = pendingMove;
            setPendingMove(null);
            void applyMove(event, start, end, scope);
          }}
        />
      ) : null}
    </div>
  );
}

function FilterMenu({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const rows: { key: keyof Filters; label: string }[] = [
    { key: 'teamsOnly', label: 'Teams meetings only' },
    { key: 'organizerOnly', label: 'Organized by me' },
    { key: 'unanswered', label: 'Not answered yet' },
    { key: 'hideDeclined', label: 'Hide declined' },
  ];
  return (
    <Popover
      align="right"
      width={220}
      trigger={() => (
        <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-white px-2.5 py-1 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400">
          <Icon name="filter" size={13} /> Filter
        </span>
      )}
    >
      {() => (
        <div className="p-2">
          {rows.map((r) => (
            <label key={r.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] text-ink-800 hover:bg-canvas">
              <input type="checkbox" checked={filters[r.key]} onChange={(e) => onChange({ ...filters, [r.key]: e.target.checked })} />
              {r.label}
            </label>
          ))}
          <button type="button" onClick={() => onChange(NO_FILTERS)} className="mt-1 w-full cursor-pointer rounded px-2 py-1 text-left text-[12px] font-semibold text-brand-700 hover:bg-canvas">
            Clear filter
          </button>
        </div>
      )}
    </Popover>
  );
}

function NewMenu({ disabled, onPick }: { disabled: boolean; onPick: (teamsLink: boolean) => void }) {
  if (disabled) {
    return (
      <Button variant="primary" size="sm" icon="plus" disabled>
        New
      </Button>
    );
  }
  return (
    <Popover
      align="right"
      width={210}
      trigger={() => (
        <span className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-brand-900 px-2.5 py-[5px] text-[12.5px] font-semibold text-white hover:bg-brand-800">
          <Icon name="plus" size={13} /> New <Icon name="chevron-down" size={12} />
        </span>
      )}
    >
      {(close) => (
        <div className="p-1.5">
          <button
            type="button"
            onClick={() => {
              close();
              onPick(true);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-ink-800 hover:bg-canvas"
          >
            <Icon name="video" size={14} /> New meeting
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              onPick(false);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-ink-800 hover:bg-canvas"
          >
            <Icon name="calendar" size={14} /> New event
          </button>
        </div>
      )}
    </Popover>
  );
}

export { addDays, dateOf };
