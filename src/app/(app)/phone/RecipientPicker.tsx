'use client';

import { useMemo, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import type { Contact } from '@/lib/phone/contacts';
import { formatPhoneDisplay } from '@/lib/phone/normalize';

export type PickRow = { e164: string; name: string; label: string | null };

/** Every number in the address book, one row each, because one person can have two. */
export function contactRows(contacts: Contact[]): PickRow[] {
  const seen = new Set<string>();
  const rows: PickRow[] = [];
  for (const c of contacts) {
    for (const n of c.numbers) {
      if (seen.has(n.e164)) continue;
      seen.add(n.e164);
      rows.push({ e164: n.e164, name: c.displayName, label: n.label });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function RecipientPicker({
  rows,
  picked,
  onChange,
  disabled,
  pasted,
  onPaste,
  pasteLabel,
  pastePlaceholder,
}: {
  rows: PickRow[];
  picked: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  pasted: string;
  onPaste: (value: string) => void;
  pasteLabel: string;
  pastePlaceholder: string;
}) {
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    const digits = q.replace(/\D/g, '');
    return rows.filter((r) => r.name.toLowerCase().includes(q) || (digits && r.e164.includes(digits)));
  }, [rows, query]);

  const toggle = (e164: string) => {
    const next = new Set(picked);
    if (next.has(e164)) next.delete(e164);
    else next.add(e164);
    onChange(next);
  };

  const allVisiblePicked = visible.length > 0 && visible.every((r) => picked.has(r.e164));
  const toggleVisible = () => {
    const next = new Set(picked);
    for (const r of visible) {
      if (allVisiblePicked) next.delete(r.e164);
      else next.add(r.e164);
    }
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">From your contacts</span>
          {visible.length > 0 ? (
            <button
              type="button"
              disabled={disabled}
              onClick={toggleVisible}
              className="text-[11.5px] font-medium text-brand-700 hover:underline disabled:opacity-50"
            >
              {allVisiblePicked ? 'Clear these' : `Select all ${visible.length}`}
            </button>
          ) : null}
        </div>

        {rows.length === 0 ? (
          <p className="mt-1 rounded-lg border border-dashed border-line px-3 py-3 text-[12.5px] text-ink-500">
            No contacts with a number yet. Type numbers below instead.
          </p>
        ) : (
          <div className="mt-1 overflow-hidden rounded-lg border border-line">
            <div className="flex items-center gap-2 border-b border-line-faint bg-canvas/40 px-2.5">
              <Icon name="search" size={12} className="shrink-0 text-ink-400" />
              <input
                type="search"
                aria-label="Search contacts"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or number"
                className="h-8 w-full bg-transparent text-[12.5px] text-ink-900 outline-none"
              />
            </div>
            <ul className="max-h-[180px] overflow-y-auto">
              {visible.map((r) => (
                <li key={r.e164}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-canvas">
                    <input
                      type="checkbox"
                      checked={picked.has(r.e164)}
                      disabled={disabled}
                      onChange={() => toggle(r.e164)}
                      className="size-3.5 shrink-0 accent-brand-600"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium text-ink-900">{r.name}</span>
                    <span className="shrink-0 tabular text-ink-500">{formatPhoneDisplay(r.e164)}</span>
                  </label>
                </li>
              ))}
              {visible.length === 0 ? <li className="px-2.5 py-2 text-[12.5px] text-ink-500">No contact matches that.</li> : null}
            </ul>
          </div>
        )}
      </div>

      <div>
        <label className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
          {pasteLabel}
          <textarea
            value={pasted}
            onChange={(e) => onPaste(e.target.value)}
            disabled={disabled}
            rows={2}
            placeholder={pastePlaceholder}
            className="mt-1 block w-full resize-y rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] font-normal normal-case tracking-normal tabular text-ink-900 outline-none focus-field"
          />
        </label>
      </div>
    </div>
  );
}
