'use client';

/**
 * The keypad (right column of the Phone tab) and Recent calls (its left list).
 *
 * ── THE DEVICE STATE IS SHOWN, NOT HIDDEN ────────────────────────────────
 * Most reasons a call cannot be placed are configuration, not faults: no number
 * assigned, the phone subtab hidden by a template, Twilio not configured on
 * this deployment. Each returns a specific error from the token route, and this
 * screen repeats it. The alternative, a Call button that just does nothing, is
 * the version that generates support tickets.
 *
 * ── NO DELETE HERE ───────────────────────────────────────────────────────
 * The client's Phone review: "There should be no delete function" on recent
 * calls. A call row offers Text, Call back, Add contact and Listen only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import type { PhoneCall } from '@/lib/phone/calls';
import { usePhone } from './PhoneProvider';
import { ListenButton } from './ListenButton';
import { callDuration, isMissed, matches, type BookEntry } from './phoneBook';
import { PanelEmpty, RowButton, SearchBox } from './PhoneBits';

const KEYS: [string, string][] = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

/**
 * Is the microphone actually available to us?
 *
 * Once a browser has recorded a "block" for a site it stops prompting, so a
 * user who dismissed the prompt once gets a call that fails at the moment they
 * need it. `navigator.permissions` tells us up front. Unknown means "say
 * nothing", never "assume broken" (Safari has not always supported the name).
 */
function useMicrophonePermission(): 'granted' | 'denied' | 'prompt' | 'unknown' {
  const [state, setState] = useState<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');

  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    (async () => {
      try {
        status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (cancelled) return;
        setState(status.state);
        status.onchange = () => setState(status!.state);
      } catch {
        // Not supported here. Stay quiet rather than guessing.
      }
    })();
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
    };
  }, []);

  return state;
}

/**
 * The keypad. Typing works as well as clicking; the backspace (x) appears once
 * there is something to take back, Escape clears. On a connected call the keys
 * send tones instead, for a menu that says "press 1".
 */
export function Keypad({
  myNumber,
  value,
  onChange,
  book,
  focusKey,
}: {
  myNumber: string | null;
  value: string;
  onChange: (v: string) => void;
  book: Map<string, BookEntry>;
  /** Bumped by the page when a number is put here from a list, to focus the field. */
  focusKey: number;
}) {
  const { dial, deviceState, error, activeCall, sendDigits } = usePhone();
  const micPermission = useMicrophonePermission();
  const input = useRef<HTMLInputElement>(null);
  const [tones, setTones] = useState('');

  const busy = activeCall !== null;
  const connected = activeCall?.status === 'connected';

  useEffect(() => {
    if (focusKey > 0) input.current?.focus();
  }, [focusKey]);
  // A new call starts a new row of tones.
  const callKey = `${activeCall?.callId ?? ''}|${connected}`;
  const [tonesFor, setTonesFor] = useState(callKey);
  if (tonesFor !== callKey) {
    setTonesFor(callKey);
    setTones('');
  }

  const match = useMemo(() => {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 10) return null;
    const e164 = value.trim().startsWith('+') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
    return book.get(e164) ?? null;
  }, [value, book]);

  const press = (k: string) => {
    if (connected) {
      sendDigits(k);
      setTones((t) => (t + k).slice(-24));
      return;
    }
    onChange(value + k);
    input.current?.focus();
  };

  const canCall = !!value.trim() && !busy && deviceState !== 'error';
  const call = () => {
    if (canCall) void dial(value.trim());
  };

  return (
    <section className="rounded-2xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(16,35,71,.04)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ink-900">{connected ? 'Keypad' : 'Dial'}</h2>
          <p className="mt-0.5 text-[12px] text-ink-400">
            {myNumber ? <>Calling from {formatPhoneDisplay(myNumber)}</> : 'No number assigned to you'}
          </p>
        </div>
        <StatusPill
          label={
            busy
              ? connected
                ? 'On a call'
                : 'Ringing'
              : deviceState === 'ready'
                ? 'Ready'
                : deviceState === 'starting'
                  ? 'Connecting'
                  : deviceState === 'error'
                    ? 'Unavailable'
                    : 'Idle'
          }
          swatch={busy ? 'blue' : deviceState === 'ready' ? 'teal' : deviceState === 'error' ? 'red' : 'amber'}
          dot
        />
      </div>

      {/* ── display ─────────────────────────────────────────────────── */}
      <div className="mt-4 flex h-[60px] items-center gap-2 rounded-xl bg-canvas px-3">
        {connected ? (
          <p className="min-w-0 flex-1 truncate text-center text-[20px] font-semibold tracking-[.12em] text-ink-900 tabular" aria-live="polite">
            {tones || <span className="text-[13px] font-normal tracking-normal text-ink-400">Press keys to send tones</span>}
          </p>
        ) : (
          <>
            <span className="w-6 shrink-0" aria-hidden />
            <input
              ref={input}
              value={value}
              onChange={(e) => onChange(e.target.value.replace(/[^0-9+*#()\-.\s]/g, ''))}
              placeholder="Enter a number"
              inputMode="tel"
              aria-label="Number to call"
              className="min-w-0 flex-1 bg-transparent text-center text-[21px] font-semibold tracking-wide text-ink-900 tabular outline-none placeholder:text-[15px] placeholder:font-normal placeholder:tracking-normal placeholder:text-ink-300"
              onKeyDown={(e) => {
                if (e.key === 'Enter') call();
                if (e.key === 'Escape') onChange('');
              }}
            />
            {value ? (
              <button
                type="button"
                onClick={() => {
                  onChange(value.slice(0, -1));
                  input.current?.focus();
                }}
                onDoubleClick={() => onChange('')}
                aria-label="Remove last digit"
                title="Remove last digit (double-click to clear)"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-white hover:text-ink-900"
              >
                <Icon name="backspace" size={19} />
              </button>
            ) : (
              <span className="w-8 shrink-0" aria-hidden />
            )}
          </>
        )}
      </div>
      <p className="mt-1.5 h-4 truncate text-center text-[12px] font-medium text-ok">
        {connected ? null : match ? `${match.name}${match.company ? ` · ${match.company}` : ''}` : null}
      </p>

      {/* ── keys ────────────────────────────────────────────────────── */}
      <div className="mt-2 grid grid-cols-3 gap-2.5">
        {KEYS.map(([k, letters]) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            aria-label={k === '*' ? 'Star' : k === '#' ? 'Pound' : k}
            className="flex h-[58px] flex-col items-center justify-center rounded-2xl border border-line-soft bg-white transition-[background,border,transform] duration-100 hover:border-brand-200 hover:bg-brand-50 active:scale-[.96]"
          >
            <span className="text-[21px] font-semibold leading-none text-ink-900 tabular">{k}</span>
            <span className="mt-1 h-3 text-[9px] font-semibold tracking-[.18em] text-ink-400">{letters}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={call}
        disabled={!canCall}
        className="mt-4 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-accent text-[15px] font-bold text-accent-ink transition-[filter,opacity] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name="phone" size={18} strokeWidth={2.2} />
        {busy ? (connected ? 'On a call' : 'Ringing…') : 'Call'}
      </button>

      {micPermission === 'denied' ? (
        <div role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2.5 text-[12px] text-red-700">
          <p className="flex items-start gap-1.5 font-semibold">
            <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
            <span>Your browser is blocking the microphone for this site.</span>
          </p>
          <p className="mt-1 pl-[18px] font-normal opacity-90">
            Calls need it. Click the icon to the left of the address bar, set Microphone to Allow, then
            reload this page.
          </p>
        </div>
      ) : null}

      {error ? (
        /* Cause on the first line, what to do on the second: the SDK's own text
           names the symptom and hides the cause. */
        <div
          role="alert"
          className={`mt-3 rounded-xl px-3 py-2.5 text-[12px] ${
            error.kind === 'call' ? 'bg-canvas text-ink-600' : 'bg-red-50 text-red-700'
          }`}
        >
          <p className="flex items-start gap-1.5 font-semibold">
            <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
            <span>{error.message}</span>
          </p>
          {error.hint ? <p className="mt-1 pl-[18px] font-normal opacity-90">{error.hint}</p> : null}
          {error.code ? (
            /* Kept: Twilio's docs are searchable by number and a support ticket needs it. */
            <p className="mt-1 pl-[18px] text-[11px] opacity-60 tabular">Twilio code {error.code}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Recent calls: a list with a search box on top (name or number). Each call:
 * Text, Call back, Add contact (when the number is nobody's yet) and Listen,
 * with the recording's length on it.
 */
export function RecentCalls({
  calls,
  book,
  onText,
  onCall,
  onAddContact,
}: {
  calls: PhoneCall[];
  book: Map<string, BookEntry>;
  onText: (e164: string) => void;
  onCall: (e164: string) => void;
  onAddContact: (e164: string) => void;
}) {
  const [query, setQuery] = useState('');
  const list = useMemo(
    () =>
      calls.filter((c) => {
        const peer = c.direction === 'in' ? c.fromE164 : c.toE164;
        const who = book.get(peer);
        return matches(query, peer, formatPhoneDisplay(peer), who?.name, who?.company);
      }),
    [calls, book, query],
  );

  return (
    <div>
      <div className="border-b border-line-soft p-4">
        <SearchBox value={query} onChange={setQuery} label="Search calls" />
      </div>

      {calls.length === 0 ? (
        <PanelEmpty icon="phone" title="No calls yet" body="Calls you make or take appear here." />
      ) : list.length === 0 ? (
        <PanelEmpty icon="search" title="No calls match" body={`Nothing matches “${query.trim()}”.`} />
      ) : (
        <ul className="max-h-[640px] divide-y divide-line-soft overflow-y-auto">
          {list.map((call) => {
            const peer = call.direction === 'in' ? call.fromE164 : call.toE164;
            const who = book.get(peer);
            const missed = isMissed(call);
            // An outgoing call that never connected (Twilio's terminal words).
            const failed = !missed && ['busy', 'failed', 'no-answer', 'canceled'].includes(call.status);
            return (
              <li
                key={call.id}
                className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2.5 px-4 py-3.5 transition-colors hover:bg-canvas/60 md:grid-cols-[auto_minmax(0,1fr)_auto]"
              >
                <span
                  className={`grid size-10 shrink-0 place-items-center rounded-full ${
                    missed || failed
                      ? 'bg-danger-bg text-danger'
                      : call.direction === 'in'
                        ? 'bg-ok-bg text-ok'
                        : 'bg-brand-50 text-brand-700'
                  }`}
                  title={missed ? 'Missed call' : call.direction === 'in' ? 'Incoming call' : 'Outgoing call'}
                >
                  <Icon name={missed ? 'phone-missed' : call.direction === 'in' ? 'phone-in' : 'phone-out'} size={16} strokeWidth={2} />
                </span>

                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[14px] font-semibold text-ink-900 tabular">
                      {who?.name ?? formatPhoneDisplay(peer)}
                    </span>
                    {call.recordId ? <StatusPill label="On a record" swatch="teal" dot={false} /> : null}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-400 tabular">
                    {who ? (
                      <>
                        <span>{formatPhoneDisplay(peer)}</span>
                        <span aria-hidden>·</span>
                      </>
                    ) : null}
                    <span>{formatDateTime(call.startedAt)}</span>
                    <span aria-hidden>·</span>
                    {missed ? (
                      <span className="font-medium text-danger">Missed</span>
                    ) : call.durationSeconds && call.durationSeconds > 0 ? (
                      <span>{callDuration(call.durationSeconds)}</span>
                    ) : (
                      <span className={failed ? 'font-medium text-danger' : ''}>{statusWords(call.status)}</span>
                    )}
                  </span>
                </span>

                <span className="col-span-2 flex flex-wrap items-center gap-1.5 pl-[54px] md:col-span-1 md:justify-end md:pl-0">
                  <RowButton icon="message-square" label="Text" onClick={() => onText(peer)} />
                  <RowButton icon="phone" label="Call back" tone="brand" onClick={() => onCall(peer)} />
                  {!who ? <RowButton icon="user-plus" label="Add contact" onClick={() => onAddContact(peer)} /> : null}
                  {call.recordings.map((rec) => (
                    <ListenButton key={rec.id} recording={rec} />
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Twilio's status in words: "no-answer" → "No answer". */
function statusWords(status: string): string {
  const s = status.replace(/-/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
