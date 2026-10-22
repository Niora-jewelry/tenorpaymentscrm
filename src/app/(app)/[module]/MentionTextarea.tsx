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
 * ── RICH TEXT — Modules §3.2, "users write updates with rich text support" ──
 * Still a plain `<textarea>`, and deliberately so. The stored body stays TEXT
 * with markdown-style markers in it, which is what keeps three existing things
 * working: `parseMentions` scans the body for "@Name" to decide who is notified,
 * the Recycle Bin excerpts the same column, and the activity log keeps prior
 * text readable without a renderer. A contenteditable storing HTML would break
 * all three and open a stored-XSS surface into the bargain (`richText.tsx` has
 * the full account).
 *
 * So the toolbar wraps the SELECTION in markers rather than styling anything.
 * Typing the markers by hand does exactly the same thing — the buttons are a
 * convenience over the format, not a different way in. `RichText` renders it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '@/proto/ui/icons';
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
  formatting = false,
  onMentionsChange,
  initialMentions = [],
}: {
  value: string;
  onChange: (v: string) => void;
  roster: TeamRosterEntry[];
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Show the formatting bar — Modules §3.2's "rich text support". On for the
   *  update composer and the edit box; off for a reply, where the client asks
   *  only for "update-style replies" and a toolbar over a one-line input is
   *  more furniture than help. Typing the markers still works everywhere. */
  formatting?: boolean;
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
    return roster.filter((m) => m.name.toLowerCase().startsWith(q)).slice(0, 6);
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

  /**
   * Wrap the selection in a pair of markers, or drop a placeholder when nothing
   * is selected — the behaviour of every editor people already use, so nobody
   * has to learn it.
   *
   * `onMouseDown` with `preventDefault` on the buttons keeps the textarea's
   * selection alive; a plain `onClick` would blur it first and the wrap would
   * land at position 0 with nothing selected.
   */
  const wrap = (before: string, after: string, placeholder: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const selected = value.slice(start, end) || placeholder;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      // Select what was wrapped, so typing replaces the placeholder and a
      // second click on the same button is visibly a second wrap.
      el?.setSelectionRange(start + before.length, start + before.length + selected.length);
      el?.focus();
    });
  };

  /** Prefix every selected line — lists and quotes are per line, not a span. */
  const prefixLines = (marker: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end);
    const block = value.slice(lineStart, lineEnd) || 'item';
    const marked = block
      .split('\n')
      .map((line, i) => (marker === '1. ' ? `${i + 1}. ${line}` : `${marker}${line}`))
      .join('\n');
    const next = `${value.slice(0, lineStart)}${marked}${value.slice(lineEnd)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el?.setSelectionRange(lineStart, lineStart + marked.length);
      el?.focus();
    });
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
      {formatting ? (
        <div className="mb-1 flex flex-wrap items-center gap-0.5">
          <FormatButton icon="type-bold" label="Bold" hint="**bold**" disabled={disabled} onPress={() => wrap('**', '**', 'bold text')} />
          <FormatButton icon="type-italic" label="Italic" hint="*italic*" disabled={disabled} onPress={() => wrap('*', '*', 'italic text')} />
          <FormatButton icon="code" label="Code" hint="`code`" disabled={disabled} onPress={() => wrap('`', '`', 'code')} />
          <FormatButton icon="link" label="Link" hint="[label](https://…)" disabled={disabled} onPress={() => wrap('[', '](https://)', 'label')} />
          <span aria-hidden className="mx-1 h-4 w-px bg-line" />
          <FormatButton icon="list" label="Bulleted list" hint="- item" disabled={disabled} onPress={() => prefixLines('- ')} />
          <FormatButton icon="list-ordered" label="Numbered list" hint="1. item" disabled={disabled} onPress={() => prefixLines('1. ')} />
          <FormatButton icon="quote" label="Quote" hint="> quoted" disabled={disabled} onPress={() => prefixLines('> ')} />
        </div>
      ) : null}
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
        <div className="absolute left-2 top-full z-10 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-white shadow-[0_8px_24px_-8px_rgba(8,32,47,.25)]">
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

/**
 * One formatting button.
 *
 * `onMouseDown` rather than `onClick`, with `preventDefault`: a click blurs the
 * textarea before the handler runs, and the selection the wrap is supposed to
 * act on is gone by then. This is the same reason the mention dropdown's rows
 * use `onMouseDown`.
 */
function FormatButton({
  icon,
  label,
  hint,
  disabled,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} — ${hint}`}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      className="grid size-6 place-items-center rounded text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900 disabled:opacity-30"
    >
      <Icon name={icon} size={13} />
    </button>
  );
}
