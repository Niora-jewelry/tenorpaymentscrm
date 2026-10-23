'use client';

/**
 * The list search — every module and the Records List.
 *
 * Typing writes `?q=` after a short pause and the page re-renders from the
 * server: the server searches `records_filterable.search_text`, which holds
 * the record's name and every string value the viewer may see (contact
 * names inside repeating groups included), so a match is always something
 * the person could have read anyway. `page` and `record` are dropped with
 * the search: a new result set starts on page 1 with no drawer over it.
 * Escape, or the ×, clears it.
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { SEARCH_MAX } from '@/lib/records/search';

const DEBOUNCE_MS = 350;

export function SearchBox({ moduleSlug, initial, placeholder = 'Search by name, company, contact, email…' }: { moduleSlug: string; initial: string; placeholder?: string }) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applied = useRef(initial);

  const apply = (value: string) => {
    const q = value.trim().slice(0, SEARCH_MAX);
    if (q === applied.current) return;
    applied.current = q;
    const params = new URLSearchParams(window.location.search);
    if (q) params.set('q', q);
    else params.delete('q');
    params.delete('page');
    params.delete('record');
    params.delete('n');
    start(() => {
      router.push(`/${moduleSlug}${params.toString() ? `?${params}` : ''}`);
    });
  };

  const onChange = (value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => apply(value), DEBOUNCE_MS);
  };

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    setText('');
    apply('');
    input.current?.focus();
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <div role="search" className="relative flex w-[360px] max-w-[48vw] items-center">
      <Icon name="search" size={14} className="pointer-events-none absolute left-3 text-ink-400" />
      <input
        ref={input}
        type="search"
        value={text}
        maxLength={SEARCH_MAX}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (timer.current) clearTimeout(timer.current);
            apply(text);
          } else if (e.key === 'Escape' && text) {
            e.preventDefault();
            clear();
          }
        }}
        placeholder={placeholder}
        aria-label="Search records"
        autoComplete="off"
        spellCheck={false}
        className="h-9 w-full rounded-lg border border-line bg-white pl-9 pr-9 text-[13px] text-ink-900 outline-none transition-colors placeholder:text-ink-400 focus:border-brand-600 [&::-webkit-search-cancel-button]:hidden"
      />
      <span className="absolute right-2 flex items-center">
        {pending ? (
          <span aria-label="Searching" className="size-3.5 animate-spin rounded-full border-2 border-line border-t-brand-600" />
        ) : text ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            title="Clear search"
            className="grid size-6 place-items-center rounded-md text-ink-400 hover:bg-canvas hover:text-ink-900"
          >
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </span>
    </div>
  );
}
