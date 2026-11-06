'use client';

/**
 * A plain `<textarea>` with `@name` autocomplete against a record's real
 * team roster — no rich-text/contenteditable dependency (none exists in
 * this app), matching the prototype's own placeholder hint ("@mention a
 * team member to notify them") with a real, working implementation behind
 * it. Matches backward from the caret for an in-progress `@...` token,
 * allowing embedded spaces so a multi-word name ("Alex Chen") doesn't close
 * the dropdown after the first word.
 *
 * Used for a reply, which has no toolbar. An Update itself is written in
 * `RichComposer`, and both store the same plain text.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { UserAvatar } from './UserAvatar';
import type { TeamRosterEntry } from '@/lib/records/updates';

// A bare "@" lists everyone who can be mentioned; typing narrows it.
const MENTION_PATTERN = /@(|[^\s@][^\n@]{0,39})$/;

/**
 * Which picked people are still named in the text. The picker inserts
 * `@Full Name`; delete the tag and the person is no longer mentioned. The
 * server applies the same rule (`reconcileMentions`), so the ids sent are a
 * record of what was picked, never the authority.
 */
export function mentionIdsIn(text: string, picked: TeamRosterEntry[]): string[] {
  return picked.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id);
}

export function MentionTextarea({
  value,
  onChange,
  roster,
  rows = 2,
  placeholder,
  disabled,
  onSubmitShortcut,
  onMentionsChange,
  initialMentions = [],
}: {
  value: string;
  onChange: (v: string) => void;
  roster: TeamRosterEntry[];
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Enter-to-submit for single-line-feeling inputs (replies); omit for the
   * multi-line post box, where Enter should just add a newline. */
  onSubmitShortcut?: () => void;
  /** The ids of the people currently tagged in the text, whenever that changes. */
  onMentionsChange?: (ids: string[]) => void;
  /** People already tagged when editing an existing post. */
  initialMentions?: TeamRosterEntry[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<{ text: string; start: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [picked, setPicked] = useState<TeamRosterEntry[]>(initialMentions);
  const announce = useRef(onMentionsChange);
  useEffect(() => {
    announce.current = onMentionsChange;
  }, [onMentionsChange]);
  // Tell the parent whenever the set of tagged people changes — after a pick,
  // and after an edit that removes a tag.
  const taggedKey = mentionIdsIn(value, picked).join(',');
  useEffect(() => {
    announce.current?.(taggedKey ? taggedKey.split(',') : []);
  }, [taggedKey]);

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    return roster.filter((m) => m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || m.name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [query, roster]);

  const recompute = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = before.match(MENTION_PATTERN);
    if (!m) {
      setQuery(null);
      return;
    }
    setQuery({ text: m[1]!, start: caret - m[1]!.length - 1 });
    setActiveIndex(0);
  };

  const applyMention = (member: TeamRosterEntry) => {
    if (!query) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, query.start)}@${member.name} ${value.slice(caret)}`;
    onChange(next);
    setPicked((l) => (l.some((p) => p.id === member.id) ? l : [...l, member]));
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = query.start + member.name.length + 2;
      el?.setSelectionRange(pos, pos);
      el?.focus();
    });
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          recompute(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (query && matches.length) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIndex((i) => (i + 1) % matches.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              applyMention(matches[activeIndex]!);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setQuery(null);
              return;
            }
          }
          if (onSubmitShortcut && e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmitShortcut();
          }
        }}
        onBlur={() => setTimeout(() => setQuery(null), 120)}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full resize-none rounded-lg border border-line px-3 py-2 text-[13.5px] outline-none transition-colors focus-field"
      />
      {query && matches.length ? (
        <div className="absolute left-2 top-full z-10 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-white shadow-[0_8px_24px_-8px_rgba(14,28,52,.25)]">
          {matches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                applyMention(m);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
                i === activeIndex ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-canvas'
              }`}
            >
              <UserAvatar userId={m.id} name={m.name} size={20} />
              {m.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

