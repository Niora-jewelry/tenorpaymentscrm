'use client';

/** The small month on the left. Clicking a date jumps the grid to it. */
import { useEffect, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { addMonths, dateOf, daysInView, ymdOf } from './dates';

export function MiniMonth({ anchor, highlighted, onPick }: { anchor: string; highlighted: string[]; onPick: (ymd: string) => void }) {
  const [shown, setShown] = useState(anchor);
  // Follows the grid when its arrows move into another month.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the grid's date, and can then be paged on its own
    setShown(anchor);
  }, [anchor]);

  const days = daysInView('month', shown);
  const month = dateOf(shown).getMonth();
  const today = ymdOf(new Date());
  const lit = new Set(highlighted);

  return (
    <section aria-label="Month">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[13px] font-semibold text-ink-800">{dateOf(shown).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <span className="inline-flex">
          <button type="button" aria-label="Previous month" onClick={() => setShown((s) => addMonths(s, -1))} className="grid size-6 cursor-pointer place-items-center rounded text-ink-500 hover:bg-canvas">
            <Icon name="chevron-left" size={14} />
          </button>
          <button type="button" aria-label="Next month" onClick={() => setShown((s) => addMonths(s, 1))} className="grid size-6 cursor-pointer place-items-center rounded text-ink-500 hover:bg-canvas">
            <Icon name="chevron-right" size={14} />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] font-medium text-ink-400">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <span key={i} className="py-0.5">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center">
        {days.map((ymd) => {
          const isToday = ymd === today;
          return (
            <button
              key={ymd}
              type="button"
              data-mini={ymd}
              aria-label={dateOf(ymd).toDateString()}
              onClick={() => onPick(ymd)}
              className={`mx-auto my-px grid size-7 cursor-pointer place-items-center rounded-full text-[11.5px] ${isToday ? 'bg-brand-900 font-semibold text-white' : lit.has(ymd) ? 'bg-brand-100 font-medium text-ink-900' : dateOf(ymd).getMonth() === month ? 'text-ink-700 hover:bg-canvas' : 'text-ink-300 hover:bg-canvas'}`}
            >
              {dateOf(ymd).getDate()}
            </button>
          );
        })}
      </div>
    </section>
  );
}
