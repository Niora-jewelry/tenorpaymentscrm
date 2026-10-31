'use client';

/**
 * "Add a search field in the drawer header — the user can search for a
 * specific field and the CRM takes them there" (the client, 30 Oct 2026).
 * It sits in the title bar, which the server draws, so a pick reaches the
 * tabs below by event; they open the tab and sub-tab and flash the card, the
 * way a mention link lands. What matches and how is in `fieldHits.ts`.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { matchedPart, searchFields, type FieldHit } from './fieldHits';

/** Fired with the picked `FieldHit`; `DrawerTabs` lands on it. */
export const FIELD_PICK_EVENT = 'tapdash:field-pick';

export function FieldSearch({ hits: all }: { hits: FieldHit[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const hits = useMemo(() => searchFields(all, q), [all, q]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // Arrowing past the bottom of the list brings the row along.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (h: FieldHit) => {
    window.dispatchEvent(new CustomEvent<FieldHit>(FIELD_PICK_EVENT, { detail: h }));
    setQ('');
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div ref={box} className="relative order-last w-full @[40rem]:order-none @[40rem]:w-[320px] @[40rem]:shrink">
      <label className="relative block">
        <span className="sr-only">Find a field on this record</span>
        <Icon name="search" size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-expanded={open && Boolean(q.trim())}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={q}
          placeholder="Find a field…"
          onChange={(e) => {
            setQ(e.target.value);
            setCursor(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === 'Enter' && hits[cursor]) {
              e.preventDefault();
              pick(hits[cursor]!);
            } else if (e.key === 'Escape') {
              setOpen(false);
              input.current?.blur();
            }
          }}
          className="h-8 w-full rounded-lg border border-line bg-white pl-8 pr-2.5 text-[13px] text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus-field"
        />
      </label>
      {open && q.trim() ? (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Fields on this record"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[340px] min-w-[300px] overflow-y-auto rounded-lg border border-line bg-white py-1 shadow-[0_12px_32px_-12px_rgba(8,32,47,.35)]"
        >
          {hits.length === 0 ? (
            <li className="px-3 py-2.5 text-[12.5px] text-ink-400">No field like “{q.trim()}” on this record.</li>
          ) : (
            hits.map((h, i) => {
              const [before, match, after] = matchedPart(h.label, q);
              return (
                <li
                  key={h.id}
                  role="option"
                  aria-selected={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(h);
                  }}
                  className={`cursor-pointer px-3 py-1.5 ${i === cursor ? 'bg-brand-50' : ''}`}
                >
                  <span className={`block truncate text-[13px] ${i === cursor ? 'text-brand-800' : 'text-ink-800'}`}>
                    {before}
                    <span className="font-semibold">{match}</span>
                    {after}
                  </span>
                  <span className="block truncate text-[11.5px] text-ink-400">{h.where}</span>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
