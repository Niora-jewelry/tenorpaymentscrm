'use client';

/**
 * "Add a search field in the drawer header — the user can search for a
 * specific field and the CRM takes them there" (the client, 30 Oct 2026).
 * Matches on the label of every field the viewer can see on this record,
 * across all tabs and sub-tabs; picking one opens that tab and sub-tab and
 * flashes the card, the way a mention link lands.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import type { TabPayload } from './DrawerTabs';

export type FieldHit = { key: string; label: string; tabId: string; tabLabel: string; subtabId: string | null; subtabLabel: string | null };

export function fieldHits(tabs: TabPayload[]): FieldHit[] {
  const out: FieldHit[] = [];
  for (const t of tabs) {
    if (t.kind !== 'custom') continue;
    const slots = t.subtabs.length ? t.subtabs.map((s) => ({ id: s.id as string | null, label: s.label as string | null })) : [{ id: null, label: null }];
    for (const s of slots) {
      for (const f of t.fieldsBySubtab[s.id ?? '_'] ?? []) out.push({ key: f.id, label: f.label, tabId: t.id, tabLabel: t.label, subtabId: s.id, subtabLabel: s.label });
      for (const g of t.repeatGroupsBySubtab[s.id ?? '_'] ?? []) out.push({ key: g.key, label: g.label, tabId: t.id, tabLabel: t.label, subtabId: s.id, subtabLabel: s.label });
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function FieldSearch({ tabs, onPick }: { tabs: TabPayload[]; onPick: (hit: FieldHit) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const all = useMemo(() => fieldHits(tabs), [tabs]);
  const hits = useMemo(() => {
    const n = norm(q);
    if (!n) return [];
    const words = n.split(' ');
    return all
      .map((h) => {
        const label = norm(h.label);
        const score = label === n ? 0 : label.startsWith(n) ? 1 : words.every((w) => label.includes(w)) ? 2 : norm(h.key).includes(n) ? 3 : -1;
        return { h, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.h.label.localeCompare(b.h.label))
      .slice(0, 8)
      .map((x) => x.h);
  }, [all, q]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const pick = (h: FieldHit) => {
    onPick(h);
    setQ('');
    setOpen(false);
    input.current?.blur();
  };

  return (
    <div ref={box} className="relative ml-auto shrink-0 self-center pl-2">
      <label className="relative block">
        <span className="sr-only">Find a field on this record</span>
        <Icon name="search" size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-expanded={open && hits.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
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
          className="h-7 w-[150px] rounded-md border border-line bg-white pl-6 pr-2 text-[12px] text-ink-900 outline-none transition-[width,border-color] placeholder:text-ink-300 focus:w-[220px] focus-field"
        />
      </label>
      {open && q.trim() ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute right-0 top-full z-40 mt-1 w-[300px] overflow-hidden rounded-lg border border-line bg-white py-1 shadow-[0_12px_32px_-12px_rgba(8,32,47,.35)]"
        >
          {hits.length === 0 ? (
            <li className="px-3 py-2 text-[12px] text-ink-400">No field called “{q.trim()}” on this record.</li>
          ) : (
            hits.map((h, i) => (
              <li
                key={`${h.tabId}/${h.subtabId ?? '_'}/${h.key}`}
                role="option"
                aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(h);
                }}
                className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-[12.5px] ${i === cursor ? 'bg-brand-50 text-brand-800' : 'text-ink-800'}`}
              >
                <span className="truncate font-medium">{h.label}</span>
                <span className="shrink-0 text-[11px] text-ink-400">
                  {h.tabLabel}
                  {h.subtabLabel ? ` › ${h.subtabLabel}` : ''}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
