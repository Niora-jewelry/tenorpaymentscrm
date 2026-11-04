'use client';

/** "My calendars": a checkbox per calendar, with Add calendar and Show all. */
import { useCallback, useMemo, useState } from 'react';
import { Button, Dialog } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { CalendarEntry } from '@/lib/msteams/types';
import { PeoplePicker } from '../../msteams-ui/shared';
import { addCalendarAction, removeCalendarAction, searchPeopleAction } from '../actions';

export function CalendarList({ calendars, hidden, onToggle, onShowAll, canChange, onChanged }: { calendars: CalendarEntry[]; hidden: string[]; onToggle: (key: string) => void; onShowAll: () => void; canChange: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);

  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of calendars) seen.set(c.identityId, c.accountEmail);
    return [...seen].map(([identityId, email]) => ({ identityId, email }));
  }, [calendars]);

  const remove = async (c: CalendarEntry) => {
    if (!c.addedId) return;
    await removeCalendarAction({ identityId: c.identityId, addedId: c.addedId });
    onChanged();
  };

  return (
    <section aria-label="My calendars">
      <div className="mb-1 flex items-center gap-1 px-1">
        <h2 className="flex-1 text-[12px] font-semibold tracking-[.02em] text-ink-500">My calendars</h2>
      </div>
      {accounts.map((a) => (
        <div key={a.identityId} className="mb-2">
          {accounts.length > 1 ? <p className="truncate px-1 pb-0.5 text-[10.5px] font-medium text-ink-400">{a.email}</p> : null}
          <ul>
            {calendars
              .filter((c) => c.identityId === a.identityId)
              .map((c) => (
                <li key={c.key} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-canvas">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={!hidden.includes(c.key)} onChange={() => onToggle(c.key)} style={{ accentColor: c.color }} aria-label={c.name} />
                    <span className="truncate text-[12.5px] text-ink-800">{c.name}</span>
                  </label>
                  {c.addedId && canChange ? (
                    <button type="button" aria-label={`Take ${c.name} off the list`} onClick={() => void remove(c)} className="hidden cursor-pointer text-ink-400 hover:text-ink-700 group-hover:block">
                      <Icon name="x" size={12} />
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ))}
      <div className="mt-1 flex items-center gap-3 px-1 text-[12px] font-semibold">
        {canChange ? (
          <button type="button" onClick={() => setAdding(true)} className="cursor-pointer text-brand-700 hover:underline">
            Add calendar
          </button>
        ) : null}
        <button type="button" onClick={onShowAll} className="cursor-pointer text-brand-700 hover:underline">
          Show all
        </button>
      </div>
      {adding ? (
        <AddCalendar
          accounts={accounts}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function AddCalendar({ accounts, onClose, onAdded }: { accounts: { identityId: string; email: string }[]; onClose: () => void; onAdded: () => void }) {
  const [identityId, setIdentityId] = useState(accounts[0]?.identityId ?? '');
  const [picked, setPicked] = useState<{ email: string; name?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (q: string) => {
      const r = await searchPeopleAction({ identityId, q });
      return r.ok ? r.data : [];
    },
    [identityId],
  );

  const add = async () => {
    const person = picked[0];
    if (!person) {
      setError('Pick the person whose calendar you want to add.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await addCalendarAction({ identityId, address: person.email });
    setBusy(false);
    if (r.ok) onAdded();
    else setError(r.message);
  };

  return (
    <Dialog title="Add calendar" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-[13px] leading-relaxed text-ink-500">Add a teammate’s calendar they have shared with you in Outlook or Teams. Microsoft decides what you can see on it.</p>
        {accounts.length > 1 ? (
          <label className="block text-[12px] font-semibold text-ink-600">
            Using account
            <select value={identityId} onChange={(e) => setIdentityId(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[13px] font-normal text-ink-800 outline-none">
              {accounts.map((a) => (
                <option key={a.identityId} value={a.identityId}>
                  {a.email}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <PeoplePicker picked={picked} onChange={(next) => setPicked(next.slice(-1))} search={search} placeholder="Name or email" />
        {error ? <p className="text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} onClick={() => void add()}>
            Add
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
