'use client';

/**
 * Text a number for the first time.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
 * `sendSmsAction(to, body)` has always accepted any number — the server side
 * was never the limitation. What was missing was a way to REACH it: `Threads`
 * renders one composer per existing conversation, so a number nobody had
 * texted yet had no box to type into. The empty state made it worse by
 * returning early, meaning an account with no threads had no composer at all
 * and no way to create its first one.
 *
 * The client's words were "text option for new numbers". This is that.
 *
 * ── WHY THE COUNTERS ARE HERE AND NOT DECORATION ─────────────────────────
 * Two numbers sit beside the two labels, and both prevent a specific
 * surprise:
 *
 *   • Next to "To" — the number as it will actually be dialled, in E.164.
 *     Matching an inbound reply to a merchant is an exact string comparison,
 *     so seeing `+1 (732) 724-1779` before sending is what tells the user the
 *     CRM understood them. A typo is otherwise invisible until no reply ever
 *     arrives.
 *   • Next to "Message" — the real segment count. One curly apostrophe
 *     re-encodes a text to UCS-2 and cuts the limit from 160 to 70, which can
 *     turn a single message into three without a single visible change. See
 *     `lib/phone/segments.ts`.
 */
import { useMemo, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, StatusPill } from '@/proto/ui/kit';
import { formatPhoneDisplay, normalizePhone } from '@/lib/phone/normalize';
import { MAX_BODY_LENGTH, segmentInfo } from '@/lib/phone/segments';
import { sendSmsAction } from '../phoneActions';

/** Reasons `normalizePhone` refuses, said in words a user can act on. */
const REFUSAL: Record<'empty' | 'too_short' | 'too_long', string> = {
  empty: 'Enter a phone number.',
  too_short: 'That is too short to be a phone number.',
  too_long: 'That is too long to be a phone number.',
};

export function NewMessage({
  /** Existing thread keys, so we can say when this is not actually new. */
  knownThreadKeys,
  onSentToThread,
}: {
  knownThreadKeys: string[];
  /** Lets the parent open the thread the message just joined. */
  onSentToThread?: (threadKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const normalized = useMemo(() => normalizePhone(to), [to]);
  const seg = useMemo(() => segmentInfo(body), [body]);

  const e164 = normalized.ok ? normalized.e164 : null;
  /*
   * Only complain once there is something to complain about. Showing "enter a
   * phone number" against a field the user has not typed in yet is noise, not
   * help.
   */
  const showNumberError = to.trim().length > 0 && !normalized.ok;
  const alreadyAThread = e164 !== null && knownThreadKeys.includes(e164);

  const canSend = e164 !== null && body.trim().length > 0 && !pending;

  const reset = () => {
    setTo('');
    setBody('');
    setError(null);
  };

  const send = () => {
    if (!e164 || !body.trim()) return;
    startTransition(async () => {
      setError(null);
      const result = await sendSmsAction(e164, body.trim(), '/phone');
      if (result.ok) {
        setSentTo(e164);
        onSentToThread?.(e164);
        reset();
        setOpen(false);
      } else {
        setError(result.message);
      }
    });
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" icon="plus" onClick={() => { setSentTo(null); setOpen(true); }}>
          New message
        </Button>
        {sentTo ? (
          <span role="status" className="flex items-center gap-1.5 text-[12px] text-ok">
            <Icon name="check" size={12} strokeWidth={2.5} />
            Sent to {formatPhoneDisplay(sentTo)}.
          </span>
        ) : (
          <span className="text-[11.5px] text-ink-400">
            Text any number, whether or not it matches a record.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-canvas/40 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-900">
          <Icon name="message-square" size={13} className="text-ink-400" />
          New message
        </h3>
        <button
          type="button"
          aria-label="Close"
          onClick={() => { setOpen(false); reset(); }}
          className="grid size-6 place-items-center rounded-md text-ink-400 transition-colors hover:bg-white hover:text-ink-900"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      {/* ── To ───────────────────────────────────────────────────────── */}
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <label
          htmlFor="new-sms-to"
          className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400"
        >
          To
        </label>
        {/* The number as it will really be sent — or why it cannot be. */}
        {e164 ? (
          <span className="flex items-center gap-1 text-[11.5px] font-medium text-ok tabular">
            <Icon name="check" size={11} strokeWidth={2.5} />
            {formatPhoneDisplay(e164)}
          </span>
        ) : showNumberError ? (
          <span className="text-[11.5px] font-medium text-danger">
            {REFUSAL[normalized.reason]}
          </span>
        ) : (
          <span className="text-[11.5px] text-ink-400">US numbers get +1 automatically</span>
        )}
      </div>
      <input
        id="new-sms-to"
        type="tel"
        autoComplete="tel"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={pending}
        placeholder="(732) 724-1779"
        aria-invalid={showNumberError || undefined}
        className={`mt-1 w-full rounded-lg border bg-white px-2.5 py-2 text-[13.5px] tabular text-ink-900 outline-none focus-field ${
          showNumberError ? 'border-danger' : 'border-line'
        }`}
      />

      {/* Not an error — this send is valid, it simply joins a conversation
          that already exists, and saying so beats a surprise. */}
      {alreadyAThread ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-500">
          <StatusPill label="Existing conversation" swatch="blue" dot={false} />
          This will continue the thread below rather than starting a new one.
        </p>
      ) : null}

      {/* ── Message ──────────────────────────────────────────────────── */}
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <label
          htmlFor="new-sms-body"
          className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400"
        >
          Message
        </label>
        <span
          className={`text-[11.5px] tabular ${
            seg.segments > 1 ? 'font-medium text-[#8a5a09]' : 'text-ink-400'
          }`}
          // Announced only when it changes something the user should act on.
          aria-live={seg.segments > 1 ? 'polite' : 'off'}
        >
          {seg.units}/{seg.perSegment}
          {seg.segments > 1 ? ` · ${seg.segments} texts` : ''}
          {seg.encoding === 'ucs2' && seg.units > 0 ? ' · unicode' : ''}
        </span>
      </div>
      <textarea
        id="new-sms-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={MAX_BODY_LENGTH}
        disabled={pending}
        placeholder="Type your message…"
        className="mt-1 w-full resize-y rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] text-ink-900 outline-none focus-field"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />

      {/* Said once the cost stops being obvious, not on every keystroke. */}
      {seg.encoding === 'ucs2' && seg.units > 0 ? (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-500">
          A character outside the standard set — often a curly quote or an emoji — means this
          sends as unicode, which allows {seg.perSegment} per text instead of 160.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-[12px] text-danger">
          <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setOpen(false); reset(); }}>
          Cancel
        </Button>
        <Button size="sm" icon="send" disabled={!canSend} onClick={send}>
          {pending ? 'Sending…' : seg.segments > 1 ? `Send ${seg.segments} texts` : 'Send'}
        </Button>
      </div>
    </div>
  );
}
