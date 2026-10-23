/**
 * Rich text for Updates — Modules §3.2: "Users write updates with rich text
 * support."
 *
 * ── WHY A MARKDOWN SUBSET AND NOT A WYSIWYG EDITOR ───────────────────────
 * The stored value stays PLAIN TEXT. That is not a shortcut; three things in
 * this build read `updates.body` as text and would each break on HTML:
 *
 *   * `parseMentions` (`lib/records/updates.ts`) scans the body for "@Name" to
 *     decide who gets notified. Markup between the "@" and the name silently
 *     stops a mention notifying anyone — a failure with no error and no way to
 *     notice except the person never replying.
 *   * the Recycle Bin's excerpt, and every future search over update text,
 *     read the same column.
 *   * `record_activity` stores prior text verbatim for the audit trail, which
 *     is meant to be readable years later without a renderer.
 *
 * Storing markers keeps all three working, and adds no dependency.
 *
 * ── WHY IT RETURNS REACT NODES AND NEVER HTML ────────────────────────────
 * ⚠️ There is no `dangerouslySetInnerHTML` anywhere in this file, and there must
 * never be. Update bodies are written by users and read by their colleagues, so
 * an HTML path here is a stored-XSS path from any account to every account.
 * Building React elements makes that structurally impossible rather than
 * dependent on a sanitiser being correct: text becomes text nodes, and the only
 * elements that exist are the ones this file creates.
 *
 * Link hrefs are the one place a string reaches an attribute, so the scheme is
 * checked against an allow-list — `javascript:` and `data:` are rendered as
 * plain text rather than as a link.
 *
 * ── WHAT IS SUPPORTED ────────────────────────────────────────────────────
 * Deliberately small, and everything in it is something people actually type:
 *
 *     **bold**   *italic*   `code`   ~~strike~~
 *     - bullet          (also *  and •)
 *     1. numbered
 *     > quote
 *     [label](https://…)   and bare https://… links
 *     @Name              (bold, and what drives notifications)
 *
 * Blank lines separate paragraphs; single newlines are line breaks.
 *
 * ── MENTIONS ARE MATCHED AGAINST KNOWN NAMES, NOT GUESSED ────────────────
 * The first version guessed a name as "@" + one word + an optional second
 * capitalised word. So "@Alex Please call" made "@Alex Please" the mention,
 * a three-word name was cut in two, and "jane@Acme.com" lit up "@Acme.com".
 * The client's words: "the user name should be bolded but not the rest".
 *
 * The caller passes the names that can be mentioned here (the roster plus
 * the thread's authors). A mention is "@" followed by exactly one of them,
 * longest first so "Alex Chen" wins over "Alex", not preceded or followed by
 * a word character. Anything else that starts with "@" is plain text. The
 * same rule the server uses to decide who was notified (`parseMentions`).
 */
import type { ReactNode } from 'react';

/** Schemes a link may use. Anything else renders as text — see the header. */
const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i;

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (SAFE_SCHEME.test(trimmed)) return trimmed;
  // A bare "www.example.com" is the one thing worth rescuing: people type it
  // constantly and it is unambiguous.
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

/**
 * The inline pass: emphasis, code, links and mentions inside one line.
 *
 * One regular expression with named alternatives rather than several passes,
 * because a second pass over already-produced nodes is how a marker inside a
 * code span ends up being formatted anyway.
 */
const INLINE_PARTS = [
  '(?<code>`[^`\\n]+`)',
  '(?<bold>\\*\\*[^*\\n]+\\*\\*)',
  '(?<strike>~~[^~\\n]+~~)',
  '(?<italic>\\*[^*\\n]+\\*|_[^_\\n]+_)',
  '(?<link>\\[[^\\]\\n]+\\]\\([^)\\s]+\\))',
  '(?<bare>(?:https?:\\/\\/|www\\.)[^\\s<>()]+)',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One compiled expression per distinct set of names; a drawer re-renders often. */
const INLINE_CACHE = new Map<string, RegExp>();

function inlineRegexFor(names: readonly string[]): RegExp {
  const clean = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))).sort((a, b) => b.length - a.length);
  const key = clean.join('\0');
  const hit = INLINE_CACHE.get(key);
  if (hit) return hit;
  const parts = [...INLINE_PARTS];
  if (clean.length) parts.push(`(?<mention>(?<![A-Za-z0-9._-])@(?:${clean.map(escapeRe).join('|')})(?![A-Za-z0-9._-]))`);
  const re = new RegExp(parts.join('|'), 'g');
  INLINE_CACHE.set(key, re);
  return re;
}

function inline(text: string, keyPrefix: string, re: RegExp): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;

  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const g = m.groups ?? {};
    const key = `${keyPrefix}-${i++}`;

    if (g.code) {
      out.push(
        <code key={key} className="rounded bg-canvas px-1 py-[1px] font-mono text-[.92em] text-ink-800">
          {g.code.slice(1, -1)}
        </code>,
      );
    } else if (g.bold) {
      out.push(<strong key={key} className="font-semibold text-ink-900">{g.bold.slice(2, -2)}</strong>);
    } else if (g.strike) {
      out.push(<s key={key} className="text-ink-400">{g.strike.slice(2, -2)}</s>);
    } else if (g.italic) {
      out.push(<em key={key}>{g.italic.slice(1, -1)}</em>);
    } else if (g.link) {
      const split = g.link.indexOf('](');
      const label = g.link.slice(1, split);
      const href = safeHref(g.link.slice(split + 2, -1));
      // An unsafe scheme keeps the label AND the raw target, so nothing is
      // silently swallowed — the reader sees exactly what was written.
      out.push(href ? <Link key={key} href={href}>{label}</Link> : <span key={key}>{g.link}</span>);
    } else if (g.bare) {
      const href = safeHref(g.bare);
      out.push(href ? <Link key={key} href={href}>{g.bare}</Link> : <span key={key}>{g.bare}</span>);
    } else if (g.mention) {
      // Bold only — the name stands out, the sentence around it reads as text.
      out.push(<strong key={key} className="font-semibold text-ink-900">{g.mention}</strong>);
    }
    last = at + m[0].length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      // `noreferrer` as well as `noopener`: without it the destination is told
      // which record's drawer the reader came from.
      rel="noopener noreferrer"
      className="font-medium text-brand-700 underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  );
}

const BULLET = /^\s*([-*•])\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/**
 * Render one update body.
 *
 * `body` is whatever the user typed. Nothing here trusts it as markup — see the
 * file header.
 */
export function RichText({
  body,
  className = '',
  names = [],
}: {
  body: string;
  className?: string;
  /** The people who can be mentioned here: `@` + one of these is a mention. */
  names?: readonly string[];
}) {
  const re = inlineRegexFor(names);
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbers: string[] = [];
  let quote: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join('\n');
    blocks.push(
      <p key={`p${key++}`} className="whitespace-pre-wrap">
        {inline(text, `p${key}`, re)}
      </p>,
    );
    paragraph = [];
  };
  const flushBullets = () => {
    if (!bullets.length) return;
    const items = bullets;
    blocks.push(
      <ul key={`u${key++}`} className="list-disc space-y-0.5 pl-5">
        {items.map((t, n) => <li key={n}>{inline(t, `u${key}-${n}`, re)}</li>)}
      </ul>,
    );
    bullets = [];
  };
  const flushNumbers = () => {
    if (!numbers.length) return;
    const items = numbers;
    blocks.push(
      <ol key={`o${key++}`} className="list-decimal space-y-0.5 pl-5">
        {items.map((t, n) => <li key={n}>{inline(t, `o${key}-${n}`, re)}</li>)}
      </ol>,
    );
    numbers = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const text = quote.join('\n');
    blocks.push(
      <blockquote key={`q${key++}`} className="border-l-2 border-line pl-3 italic text-ink-500">
        <span className="whitespace-pre-wrap">{inline(text, `q${key}`, re)}</span>
      </blockquote>,
    );
    quote = [];
  };
  /** Everything except the block kind about to continue. Keeps the four
   *  accumulators from interleaving — a bullet immediately after a quote must
   *  close the quote, not append to it. */
  const flushAllBut = (keep: 'p' | 'u' | 'o' | 'q' | null) => {
    if (keep !== 'p') flushParagraph();
    if (keep !== 'u') flushBullets();
    if (keep !== 'o') flushNumbers();
    if (keep !== 'q') flushQuote();
  };

  for (const line of lines) {
    if (!line.trim()) {
      flushAllBut(null);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushAllBut('u');
      bullets.push(bullet[2] ?? '');
      continue;
    }
    const number = NUMBER.exec(line);
    if (number) {
      flushAllBut('o');
      numbers.push(number[2] ?? '');
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flushAllBut('q');
      quote.push(q[1] ?? '');
      continue;
    }
    flushAllBut('p');
    paragraph.push(line);
  }
  flushAllBut(null);

  return <div className={`space-y-1.5 ${className}`}>{blocks}</div>;
}
