'use client';

/**
 * The SMS tab (client, Phone UI review): the same layout as Phone, with the
 * conversation list on the left and, on the right, the SMS panel showing the
 * topmost conversation, sent and received, plus "New SMS".
 *
 * ── WHY THIS IS NOT JUST THE DRAWER'S TEXT TAB AGAIN ─────────────────────
 * The drawer filters texts by `record_id`. A message from a number that matches
 * no merchant has no record id, so without this screen it would be stored and
 * invisible. That is why an unmatched conversation says "No record" plainly.
 *
 * ── THE COUNTERS UNDER THE COMPOSER ──────────────────────────────────────
 * The real segment count: one curly apostrophe re-encodes a text to UCS-2 and
 * cuts the limit from 160 to 70 (`lib/phone/segments.ts`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { StatusPill, Spinner } from '@/proto/ui/kit';
import { formatDate, formatDateTime } from '@/proto/ui/tokens';
import { formatPhoneDisplay, normalizePhone } from '@/lib/phone/normalize';
import { MAX_BODY_LENGTH, segmentInfo } from '@/lib/phone/segments';
import type { PhoneMessage, PhoneThread } from '@/lib/phone/messages';
import { sendSmsAction, threadMessagesAction } from '../phoneActions';
import { ConsentBadge } from './ConsentBadge';
import { PanelEmpty, SearchBox } from './PhoneBits';
import { initials, matches, type BookEntry } from './phoneBook';

/** The conversations, newest first. */
export function RecentMessages({
  threads,
  book,
  active,
  onOpen,
}: {
  threads: PhoneThread[];
  book: Map<string, BookEntry>;
  active: string | null;
  onOpen: (threadKey: string) => void;
}) {
  const [query, setQuery] = useState('');
  const list = useMemo(
    () =>
      threads.filter((t) => {
        const who = book.get(t.threadKey);
        return matches(query, t.threadKey, formatPhoneDisplay(t.threadKey), who?.name, who?.company, t.lastBody);
      }),
    [threads, book, query],
  );

  return (
    <div>
      <div className="border-b border-line-soft p-4">
        <SearchBox value={query} onChange={setQuery} label="Search messages" />
      </div>
      {threads.length === 0 ? (
        <PanelEmpty
          icon="message-square"
          title="No conversations yet"
          body="Texts you send or receive appear here, including from numbers that match no record."
        />
      ) : list.length === 0 ? (
        <PanelEmpty icon="search" title="No messages match" body={`Nothing matches “${query.trim()}”.`} />
      ) : (
        <ul className="max-h-[640px] divide-y divide-line-soft overflow-y-auto">
          {list.map((t) => {
            const who = book.get(t.threadKey);
            const on = active === t.threadKey;
            return (
              <li key={t.threadKey}>
                <button
                  type="button"
                  onClick={() => onOpen(t.threadKey)}
                  aria-current={on ? 'true' : undefined}
                  className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 px-4 py-3.5 text-left transition-colors ${
                    on ? 'bg-brand-50' : 'hover:bg-canvas/60'
                  }`}
                >
                  <span
                    className={`grid size-10 shrink-0 place-items-center rounded-full text-[12px] font-bold ${
                      on ? 'bg-brand-900 text-white' : who ? 'bg-brand-100 text-brand-800' : 'bg-canvas text-ink-400'
                    }`}
                  >
                    {who ? initials(who.name) : <Icon name="message-square" size={15} />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[14px] font-semibold text-ink-900 tabular">
                        {who?.name ?? formatPhoneDisplay(t.threadKey)}
                      </span>
                      {/* Said only for a number nobody knows: that is the text that
                          would otherwise be missed. A saved contact has a name. */}
                      {t.recordId || who ? null : <StatusPill label="No record" swatch="amber" dot={false} />}
                    </span>
                    <span className="mt-0.5 block truncate text-[12.5px] text-ink-500">
                      {t.lastDirection === 'out' ? <span className="text-ink-400">You: </span> : null}
                      {t.lastBody}
                    </span>
                  </span>
                  <span className="shrink-0 self-start whitespace-nowrap pt-0.5 text-[11px] text-ink-400 tabular">
                    {dayLabel(t.lastAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const REFUSAL: Record<'empty' | 'too_short' | 'too_long', string> = {
  empty: 'Enter a phone number.',
  too_short: 'That is too short to be a phone number.',
  too_long: 'That is too long to be a phone number.',
};

/**
 * The right-hand panel: one conversation, or a new one.
 */
export function SmsPanel({
  threadKey,
  composing,
  threads,
  book,
  initial,
  onNew,
  onCancelNew,
  onSent,
  onCall,
  onAddContact,
}: {
  threadKey: string | null;
  /** A new message, with the number to start from (may be empty). */
  composing: { to: string; key: number } | null;
  threads: PhoneThread[];
  book: Map<string, BookEntry>;
  /** The topmost conversation, loaded with the page so it shows at once. */
  initial: { key: string; stamp: string; messages: PhoneMessage[] } | null;
  onNew: () => void;
  onCancelNew: () => void;
  onSent: (e164: string) => void;
  onCall: (e164: string) => void;
  onAddContact: (e164: string) => void;
}) {
  const [cache, setCache] = useState<Record<string, PhoneMessage[]>>(() =>
    initial ? { [initial.key]: initial.messages } : {},
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [to, setTo] = useState(composing?.to ?? '');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const thread = threadKey ? threads.find((t) => t.threadKey === threadKey) ?? null : null;
  const who = threadKey ? book.get(threadKey) : undefined;
  const messages = threadKey ? cache[threadKey] : undefined;

  // The thread's freshness: when a text arrives or is sent, the page's list
  // changes and the open conversation reloads.
  const stamp = thread ? `${thread.lastAt}|${thread.count}` : '';

  const reload = useCallback(async (key: string) => {
    setLoading(true);
    setLoadError(false);
    try {
      const rows = await threadMessagesAction(key);
      setCache((prev) => ({ ...prev, [key]: rows }));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // What each cached conversation was loaded at. The page's copy counts only
  // while the list still says the same, so a stale one reloads.
  const loadedStamp = useRef<Record<string, string>>(initial ? { [initial.key]: initial.stamp } : {});
  useEffect(() => {
    if (composing || !threadKey) return;
    if (cache[threadKey] && loadedStamp.current[threadKey] === stamp) return;
    loadedStamp.current[threadKey] = stamp;
    void reload(threadKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey, stamp, composing, reload]);

  // A new conversation starts from the number it was opened with; another
  // conversation starts without the last one's error.
  const [seen, setSeen] = useState({ composing, threadKey });
  if (seen.composing !== composing || seen.threadKey !== threadKey) {
    setSeen({ composing, threadKey });
    setError(null);
    if (composing && composing !== seen.composing) setTo(composing.to);
  }

  // Newest at the bottom, in view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, threadKey, composing]);

  const normalized = useMemo(() => normalizePhone(to), [to]);
  const target = composing ? (normalized.ok ? normalized.e164 : null) : threadKey;
  const existing = composing && target ? threads.some((t) => t.threadKey === target) : false;
  const seg = useMemo(() => segmentInfo(body), [body]);
  const canSend = !!target && body.trim().length > 0 && !pending;

  const send = () => {
    if (!target || !body.trim() || pending) return;
    const text = body.trim();
    startTransition(async () => {
      setError(null);
      const result = await sendSmsAction(target, text, '/phone');
      if (result.ok) {
        setBody('');
        loadedStamp.current[target] = '';
        if (composing) onSent(target);
        await reload(target);
        textarea.current?.focus();
      } else {
        setError(result.message);
      }
    });
  };

  // Group a conversation by day, the way a phone does.
  const days = useMemo(() => {
    const out: { day: string; rows: PhoneMessage[] }[] = [];
    for (const m of messages ?? []) {
      const day = dayLabel(m.sentAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(m);
      else out.push({ day, rows: [m] });
    }
    return out;
  }, [messages]);

  const iconBtn =
    'grid size-8 shrink-0 place-items-center rounded-lg text-ink-500 transition-colors hover:bg-canvas hover:text-ink-900 disabled:opacity-40';

  return (
    <section className="flex h-[600px] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(16,35,71,.04)] xl:h-[calc(100vh-170px)] xl:max-h-[760px] xl:min-h-[540px]">
      {/* ── header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {composing ? (
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
              <Icon name="square-pen" size={15} />
            </span>
          ) : threadKey ? (
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-900 text-[11.5px] font-bold text-white">
              {who ? initials(who.name) : <Icon name="message-square" size={15} />}
            </span>
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-ink-900 tabular">
              {composing ? 'New message' : threadKey ? who?.name ?? formatPhoneDisplay(threadKey) : 'Messages'}
            </p>
            {!composing && threadKey ? (
              <p className="truncate text-[11.5px] text-ink-400 tabular">
                {who ? `${formatPhoneDisplay(threadKey)}${who.company ? ` · ${who.company}` : ''}` : thread?.recordId ? 'On a record' : 'No matching record'}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!composing && threadKey ? (
            <>
              <button type="button" className={iconBtn} aria-label="Call this number" title="Call" onClick={() => onCall(threadKey)}>
                <Icon name="phone" size={15} />
              </button>
              {!who ? (
                <button type="button" className={iconBtn} aria-label="Add as a contact" title="Add contact" onClick={() => onAddContact(threadKey)}>
                  <Icon name="user-plus" size={15} />
                </button>
              ) : null}
              <button
                type="button"
                className={iconBtn}
                aria-label="Check for new messages"
                title="Check for new messages"
                disabled={loading}
                onClick={() => void reload(threadKey)}
              >
                <Icon name="refresh-cw" size={14} className={loading ? 'animate-spin' : undefined} />
              </button>
            </>
          ) : null}
          {composing ? (
            threads.length > 0 ? (
              <button type="button" className={iconBtn} aria-label="Close the new message" title="Close" onClick={onCancelNew}>
                <Icon name="x" size={15} />
              </button>
            ) : null
          ) : (
            <button
              type="button"
              onClick={onNew}
              className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-bold text-accent-ink transition-[filter] hover:brightness-95"
            >
              <Icon name="square-pen" size={13} strokeWidth={2.2} />
              New SMS
            </button>
          )}
        </div>
      </div>

      {/* ── to (new message) ────────────────────────────────────────── */}
      {composing ? (
        <div className="border-b border-line-soft px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="sms-to" className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
              To
            </label>
            {target ? (
              <span className="flex items-center gap-1 text-[11.5px] font-medium text-ok tabular">
                <Icon name="check" size={11} strokeWidth={2.5} />
                {book.get(target)?.name ?? formatPhoneDisplay(target)}
              </span>
            ) : to.trim() && !normalized.ok ? (
              <span className="text-[11.5px] font-medium text-danger">{REFUSAL[normalized.reason]}</span>
            ) : (
              <span className="text-[11.5px] text-ink-400">Any number; US numbers get +1</span>
            )}
          </div>
          <input
            id="sms-to"
            key={composing.key}
            autoFocus
            type="tel"
            autoComplete="tel"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={pending}
            placeholder="(732) 724-1779"
            aria-invalid={(to.trim().length > 0 && !normalized.ok) || undefined}
            className={`mt-1 h-10 w-full rounded-xl border bg-white px-3 text-[14px] text-ink-900 tabular outline-none focus-field ${
              to.trim() && !normalized.ok ? 'border-danger' : 'border-line'
            }`}
          />
          {target ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <ConsentBadge e164={target} />
              {existing ? (
                <span className="text-[11.5px] text-ink-500">Continues your conversation with this number.</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── conversation ────────────────────────────────────────────── */}
      <div ref={scroller} className="flex-1 overflow-y-auto bg-canvas/50 px-4 py-4" aria-live="polite">
        {composing ? (
          <p className="m-auto flex h-full items-center justify-center text-[13px] text-ink-400">
            Start a new conversation.
          </p>
        ) : !threadKey ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <span className="grid size-11 place-items-center rounded-full bg-white text-ink-400">
              <Icon name="message-square" size={18} />
            </span>
            <p className="mt-3 text-[13.5px] font-semibold text-ink-700">No conversation open</p>
            <p className="mt-1 text-[12.5px] text-ink-400">Pick one on the left, or start a New SMS.</p>
          </div>
        ) : !messages ? (
          <p className="flex h-full items-center justify-center gap-2 text-[12.5px] text-ink-400">
            {loadError ? (
              <>
                Could not load this conversation.
                <button type="button" onClick={() => void reload(threadKey)} className="font-semibold text-brand-700 underline underline-offset-2">
                  Try again
                </button>
              </>
            ) : (
              <>
                <Spinner className="size-3.5" />
                Loading…
              </>
            )}
          </p>
        ) : messages.length === 0 ? (
          <p className="flex h-full items-center justify-center text-[12.5px] text-ink-400">No messages yet.</p>
        ) : (
          <div className="space-y-4">
            {days.map((d) => (
              <div key={d.day} className="space-y-2">
                <p className="text-center text-[11px] font-medium text-ink-400">{d.day}</p>
                {d.rows.map((m) => (
                  <Bubble key={m.id} m={m} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── composer ────────────────────────────────────────────────── */}
      {composing || threadKey ? (
        <div className="border-t border-line-soft bg-white px-3 pb-2.5 pt-3">
          {error ? (
            <p role="alert" className="mb-2 flex items-start gap-1.5 rounded-lg bg-danger-bg px-2.5 py-1.5 text-[12px] text-danger">
              <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
              {error}
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              ref={textarea}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                const el = e.target;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              maxLength={MAX_BODY_LENGTH}
              disabled={pending}
              aria-label="Message"
              placeholder="Type a message…"
              className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-line bg-white px-3 py-2.5 text-[13.5px] leading-snug text-ink-900 outline-none focus-field"
            />
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              aria-label={seg.segments > 1 ? `Send ${seg.segments} texts` : 'Send'}
              title="Send (Enter)"
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-900 text-white transition-[background,opacity] hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? <Spinner className="size-4" /> : <Icon name="send" size={16} />}
            </button>
          </div>
          <p className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[11px] text-ink-400">
            <span>Enter sends · Shift+Enter for a new line</span>
            <span className={`tabular ${seg.segments > 1 ? 'font-medium text-warn' : ''}`} aria-live={seg.segments > 1 ? 'polite' : 'off'}>
              {seg.units}/{seg.perSegment}
              {seg.segments > 1 ? ` · ${seg.segments} texts` : ''}
              {seg.encoding === 'ucs2' && seg.units > 0 ? ' · unicode' : ''}
            </span>
          </p>
        </div>
      ) : null}
    </section>
  );
}

function Bubble({ m }: { m: PhoneMessage }) {
  const out = m.direction === 'out';
  const failed = out && ['failed', 'undelivered'].includes(m.status);
  const time = formatDateTime(m.sentAt).split(' · ')[1] ?? '';
  return (
    <div className={`flex flex-col ${out ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed ${
          out
            ? failed
              ? 'rounded-br-md border border-bad/30 bg-bad-bg text-ink-900'
              : 'rounded-br-md bg-brand-900 text-white'
            : 'rounded-bl-md border border-line-soft bg-white text-ink-900'
        }`}
      >
        {m.body}
      </div>
      <p className={`mt-1 px-1 text-[10.5px] tabular ${failed ? 'font-medium text-danger' : 'text-ink-400'}`}>
        {time}
        {out ? ` · ${failed ? 'Not delivered' : statusWord(m.status)}` : ''}
      </p>
    </div>
  );
}

/** Twilio's word for where a text got to, said simply. */
function statusWord(status: string): string {
  if (status === 'delivered') return 'Delivered';
  if (status === 'sent') return 'Sent';
  if (status === 'queued' || status === 'accepted' || status === 'sending') return 'Sending';
  if (status === 'read') return 'Read';
  return status ? status[0].toUpperCase() + status.slice(1) : '';
}

/** "Today", "Yesterday", else the date, the way a phone heads a day. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return formatDate(iso);
}
