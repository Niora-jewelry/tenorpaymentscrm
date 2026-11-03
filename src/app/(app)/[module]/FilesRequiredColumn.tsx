'use client';

/**
 * Files Required: the chips, in a list row and in Vital Info, and the column's
 * header. A system column, so none of this reads a field or a column setting, and
 * nothing here depends on the viewer's Files tab (Files Required spec).
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Popover } from '@/proto/ui/kit';
import type { Filter } from '@/proto/schema';
import {
  FILES_REQUIRED_EMPTY,
  FILES_REQUIRED_FILLED,
  FILES_REQUIRED_KEY,
  chipText,
  fileRowLink,
  type FileRequiredItem,
} from '@/lib/records/filesRequired';

const CHIP = 'inline-flex max-w-full items-center truncate rounded-md border border-[#f7e0af] bg-[#fdf1d8] px-1.5 py-[2px] text-[11.5px] font-medium text-[#8a5a09] transition-colors hover:border-[#e6c67d] hover:bg-[#fbe8c0]';

/** The chips as links. Shown whole in Vital Info; the list uses `FilesRequiredTicker`. */
export function FilesRequiredChips({ recordId, items }: { recordId: string; items: FileRequiredItem[] }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  if (!items.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {items.map((i) => (
        <Link key={i.id} href={fileRowLink(search, pathname, recordId, i.id)} scroll={false} title={chipText(i)} className={CHIP}>
          <span className="truncate">{chipText(i)}</span>
        </Link>
      ))}
    </span>
  );
}

/**
 * The list cell. One line, so a row keeps its height: what fits, then "+2 more".
 * On hover the chips run across the cell so the rest can be read and clicked (the
 * ticker Izzy asked for), and the title holds the whole list for anyone who would
 * rather not chase it, or whose settings ask for less motion.
 */
export function FilesRequiredTicker({ recordId, items }: { recordId: string; items: FileRequiredItem[] }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const box = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const [hidden, setHidden] = useState(0);

  useEffect(() => {
    const boxEl = box.current;
    const trackEl = track.current;
    if (!boxEl || !trackEl) return;
    const measure = new ResizeObserver(() => {
      const width = boxEl.clientWidth;
      setShift(Math.max(0, trackEl.scrollWidth - width));
      setHidden([...trackEl.children].filter((c) => (c as HTMLElement).offsetLeft + (c as HTMLElement).offsetWidth > width).length);
    });
    measure.observe(boxEl);
    measure.observe(trackEl);
    return () => measure.disconnect();
  }, [items]);

  if (!items.length) return null;
  return (
    <span
      className="files-ticker relative flex w-full min-w-0 items-center"
      title={items.map(chipText).join('\n')}
      onClick={(e) => e.stopPropagation()}
    >
      <span ref={box} className="min-w-0 flex-1 overflow-hidden">
        <span
          ref={track}
          className="files-ticker-track inline-flex w-max items-center gap-1"
          style={shift ? ({ '--ticker-shift': `-${shift}px`, '--ticker-time': `${Math.max(2.5, shift / 70 + 1)}s` } as React.CSSProperties) : undefined}
        >
          {items.map((i) => (
            <Link key={i.id} href={fileRowLink(search, pathname, recordId, i.id)} scroll={false} className={`${CHIP} shrink-0`}>
              {chipText(i)}
            </Link>
          ))}
        </span>
      </span>
      {hidden > 0 ? <span className="files-ticker-more ml-1.5 shrink-0 text-[11.5px] font-semibold text-ink-500">+{hidden} more</span> : null}
    </span>
  );
}

export function filesRequiredSummary(filter: Filter): string {
  if (filter.kind !== 'values') return 'Files Required';
  const names = filter.values.filter((v) => v !== FILES_REQUIRED_EMPTY && v !== FILES_REQUIRED_FILLED);
  if (filter.values.includes(FILES_REQUIRED_EMPTY)) return 'Files Required: empty';
  if (names.length) return `Files Required: ${names.join(', ')}`;
  return 'Files Required: filled';
}

export function FilesRequiredHeader({
  filter,
  onChange,
  sorted,
  onSort,
  rowNames,
}: {
  filter?: Filter;
  onChange: (f: Filter | undefined) => void;
  sorted: boolean;
  onSort: (on: boolean) => void;
  /** The preset rows, and any others on the page. */
  rowNames: string[];
}) {
  const [typed, setTyped] = useState('');
  const values = filter?.kind === 'values' ? filter.values : [];
  const names = values.filter((v) => v !== FILES_REQUIRED_EMPTY && v !== FILES_REQUIRED_FILLED);
  const state = values.includes(FILES_REQUIRED_EMPTY) ? 'empty' : values.includes(FILES_REQUIRED_FILLED) || names.length ? 'filled' : 'any';
  const set = (next: string[]) => onChange(next.length ? { fieldId: FILES_REQUIRED_KEY, kind: 'values', values: next } : undefined);
  const toggle = (name: string) => set(names.includes(name) ? names.filter((n) => n !== name) : [...names, name]);
  const addTyped = () => {
    const name = typed.trim();
    if (name && !names.includes(name)) set([...names, name]);
    setTyped('');
  };

  return (
    <div className="px-3 py-2">
      <Popover
        width={250}
        trigger={() => (
          <span className={`flex items-center gap-1 text-[12px] font-semibold uppercase tracking-[.04em] transition-colors ${filter ? 'text-brand-700' : 'text-ink-400 hover:text-ink-700'}`}>
            <span className="truncate">Files Required</span>
            {sorted ? <Icon name="chevron-down" size={12} strokeWidth={2.4} className="shrink-0 text-brand-700" aria-label="Most outstanding first" /> : null}
            <Icon name="filter" size={11} strokeWidth={filter ? 2 : 1.6} className={filter ? 'fill-current text-brand-700' : 'text-ink-400/50'} />
          </span>
        )}
      >
        {(close) => (
          <div className="p-1">
            <div className="mb-2 border-b border-line-faint pb-2">
              <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Sort</p>
              <button
                type="button"
                aria-pressed={sorted}
                onClick={() => {
                  onSort(!sorted);
                  close();
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${sorted ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-700 hover:bg-canvas'}`}
              >
                <Icon name="chevron-down" size={12} strokeWidth={2.2} />
                Most outstanding first
                {sorted ? <Icon name="check" size={12} className="ml-auto" /> : null}
              </button>
            </div>
            <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-400">Filter</p>
            <div className="mb-2 grid grid-cols-3 gap-1">
              {([['any', 'Any'], ['filled', 'Filled'], ['empty', 'Empty']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={state === key}
                  onClick={() => set(key === 'any' ? [] : [key === 'filled' ? FILES_REQUIRED_FILLED : FILES_REQUIRED_EMPTY])}
                  className={`rounded-md border px-2 py-1 text-[12.5px] font-medium ${state === key ? 'border-brand-200 bg-brand-50 text-brand-700' : 'border-line text-ink-700 hover:bg-canvas'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="max-h-48 overflow-y-auto">
              {[...new Set([...rowNames, ...names])].map((name) => (
                <label key={name} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-ink-700 hover:bg-canvas">
                  <input type="checkbox" checked={names.includes(name)} onChange={() => toggle(name)} className="size-3.5 accent-[#1d4ed8]" />
                  <span className="truncate">{name}</span>
                </label>
              ))}
            </div>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addTyped();
              }}
              onBlur={addTyped}
              placeholder="Another row name…"
              aria-label="Filter by another row name"
              className="mt-1 w-full rounded-md border border-line px-2 py-1.5 text-[13px] outline-none focus-field"
            />
          </div>
        )}
      </Popover>
    </div>
  );
}
