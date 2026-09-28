'use client';

/**
 * The dial pad and this user's own call history.
 *
 * ── THE DEVICE STATE IS SHOWN, NOT HIDDEN ────────────────────────────────
 * Most reasons a call cannot be placed are configuration, not faults: no number
 * assigned, the phone subtab hidden by a template, Twilio not configured on
 * this deployment. Each returns a specific error from the token route, and this
 * screen repeats it. The alternative — a dial button that just does nothing —
 * is the version that generates support tickets.
 */
import { useEffect, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, EmptyState, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import type { PhoneCall } from '@/lib/phone/calls';
import { RecordingRow } from '@/app/(app)/[module]/PhonePanels';
import { TelephonyDelete } from '../TelephonyDelete';
import { usePhone } from './PhoneProvider';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/**
 * Is the microphone actually available to us?
 *
 * ── WHY ASK INSTEAD OF WAITING FOR THE FAILURE ───────────────────────────
 * Once a browser has recorded a "block" for a site it stops prompting. So a
 * user who dismissed the prompt once gets no prompt ever again, no warning,
 * and no clue — just a call that fails at the moment they need it, with the
 * SDK blaming "the browser or end-user".
 *
 * `navigator.permissions` tells us up front, so the page can say so while
 * nothing is happening rather than at the worst possible moment.
 *
 * Wrapped in try/catch and defaulting to 'unknown' because Permissions API
 * support for the microphone name is uneven — Safari has historically not
 * supported it. Unknown means "say nothing", never "assume broken".
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
 * The dial pad — the narrow left column.
 *
 * Split out of what used to be one `Dialer` component holding its own
 * two-column grid. The page now owns that grid, because two more panels had
 * to sit UNDER these two rather than beside them: Messages below the pad,
 * Contacts below the call list. A component that lays out its own siblings
 * cannot be stacked under anything.
 */
export function DialPad({ myNumber }: { myNumber: string | null }) {
  const { dial, deviceState, error, activeCall } = usePhone();
  const [number, setNumber] = useState('');
  const micPermission = useMicrophonePermission();

  const busy = activeCall !== null;

  return (
      <section className="rounded-2xl border border-line bg-white p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13.5px] font-semibold text-ink-900">Dial</h2>
          <StatusPill
            label={
              deviceState === 'ready'
                ? 'Ready'
                : deviceState === 'starting'
                  ? 'Connecting'
                  : deviceState === 'error'
                    ? 'Unavailable'
                    : 'Idle'
            }
            swatch={deviceState === 'ready' ? 'teal' : deviceState === 'error' ? 'red' : 'amber'}
            dot
          />
        </div>

        {myNumber ? (
          <p className="mt-1 text-[11.5px] text-ink-400">
            Calling from {formatPhoneDisplay(myNumber)}
          </p>
        ) : null}

        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="+1 555 000 0000"
          inputMode="tel"
          className="mt-3 w-full rounded-xl border border-line bg-canvas/40 px-3 py-2.5 text-center text-[17px] tracking-wide text-ink-900 tabular focus-field"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && number.trim() && !busy) void dial(number.trim());
          }}
        />

        <div className="mt-3 grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setNumber((n) => n + k)}
              className="rounded-xl border border-line bg-white py-2.5 text-[16px] font-semibold text-ink-800 tabular transition-colors hover:bg-canvas active:bg-canvas"
            >
              {k}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button
            icon="phone"
            onClick={() => void dial(number.trim())}
            disabled={!number.trim() || busy || deviceState === 'error'}
          >
            {busy ? 'On a call' : 'Call'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setNumber('')} disabled={!number}>
            Clear
          </Button>
        </div>

        {micPermission === 'denied' ? (
          /*
           * Shown BEFORE anything is attempted. The browser will not prompt
           * again on its own, so without this the first sign of trouble is a
           * failed call — and the error text points at the browser or the
           * user rather than at a setting either of them can change.
           */
          <div role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2.5 text-[12px] text-red-700">
            <p className="flex items-start gap-1.5 font-semibold">
              <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
              <span>Your browser is blocking the microphone for this site.</span>
            </p>
            <p className="mt-1 pl-[18px] font-normal opacity-90">
              Calls need it. Click the icon to the left of the address bar, set Microphone to Allow,
              then reload this page.
            </p>
          </div>
        ) : null}

        {error ? (
          /*
           * Cause on the first line, what to do on the second. The SDK's own
           * text names the symptom and hides the cause — "an unknown error has
           * occurred" was a blocked WebSocket, and "the browser denied
           * permissions" was one of our own response headers. Both sent people
           * looking in the wrong place, which is the whole reason this shows a
           * hint rather than just a message.
           */
          <div
            role="alert"
            className={`mt-3 rounded-xl px-3 py-2.5 text-[12px] ${
              error.kind === 'call'
                ? 'bg-canvas text-ink-600'
                : 'bg-red-50 text-red-700'
            }`}
          >
            <p className="flex items-start gap-1.5 font-semibold">
              <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
              <span>{error.message}</span>
            </p>
            {error.hint ? (
              <p className="mt-1 pl-[18px] font-normal opacity-90">{error.hint}</p>
            ) : null}
            {error.code ? (
              /* Kept on purpose: Twilio's docs are searchable by number and a
                 support ticket needs it. Explaining an error is not a reason to
                 hide what it was. */
              <p className="mt-1 pl-[18px] text-[11px] opacity-60 tabular">Twilio code {error.code}</p>
            ) : null}
          </div>
        ) : null}
      </section>
  );
}

/**
 * This user's own call history — the wide right column.
 */
export function CallHistory({ calls }: { calls: PhoneCall[] }) {
  const { dial, deviceState, activeCall } = usePhone();
  const busy = activeCall !== null;
  const canCall = !busy && deviceState !== 'error';

  return (
      <section className="rounded-2xl border border-line bg-white p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13.5px] font-semibold text-ink-900">Your calls</h2>
          {calls.length > 0 ? (
            <span className="rounded-full bg-canvas px-1.5 py-0.5 text-[11px] font-medium tabular text-ink-500">
              {calls.length}
            </span>
          ) : null}
        </div>

        {calls.length === 0 ? (
          <div className="mt-3">
            <EmptyState icon="phone" title="No calls yet" body="Calls you make or take appear here." />
          </div>
        ) : (
          /*
             Capped and scrolled. The list is every call this user has made or
             taken and it only ever grows; unbounded, it pushes Contacts off
             the bottom of the screen and the page turns into one long scroll
             where nothing else is reachable. A fixed height keeps both panels
             on screen together, which is the point of the two-column layout.
          */
          <ul className="mt-3 max-h-[440px] space-y-2 overflow-y-auto pr-1">
            {calls.map((call) => {
              const peer = call.direction === 'in' ? call.fromE164 : call.toE164;
              const missed =
                call.direction === 'in' && ['no-answer', 'busy', 'failed'].includes(call.status);
              return (
                <li
                  key={call.id}
                  className="group rounded-xl border border-line-soft px-3 py-2.5 transition-colors hover:border-line hover:bg-canvas/40"
                >
                  {/*
                    A grid, not a flex row with `ml-auto`. In a panel this wide
                    the old version left a corridor of empty space between the
                    number and the buttons, with everything jammed to the two
                    edges. The middle column now carries what was previously
                    nowhere - how long the call lasted, and whether it is
                    attached to a merchant - so the width is used rather than
                    padded.
                  */}
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                    {/* The direction badge is a filled disc rather than a bare
                        glyph: at 12px an arrow alone is hard to tell apart at a
                        glance, and missed calls are the ones that must not be
                        missed twice. */}
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded-full ${
                        missed
                          ? 'bg-danger-bg text-danger'
                          : call.direction === 'in'
                            ? 'bg-ok-bg text-ok'
                            : 'bg-brand-50 text-brand-700'
                      }`}
                    >
                      <Icon name={call.direction === 'in' ? 'reply' : 'send'} size={12} strokeWidth={2.2} />
                    </span>

                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13.5px] font-medium tabular text-ink-900">
                          {formatPhoneDisplay(peer)}
                        </span>
                        {missed ? <StatusPill label="Missed" swatch="red" dot={false} /> : null}
                        {/* Whether this call reached a merchant record. Stated
                            rather than left blank, because an unattached call is
                            the case the standalone phone page exists for. */}
                        {call.recordId ? (
                          <StatusPill label="Matched" swatch="teal" dot={false} />
                        ) : null}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] tabular text-ink-400">
                        <span>{formatDateTime(call.startedAt)}</span>
                        {call.durationSeconds !== null && call.durationSeconds > 0 ? (
                          <>
                            <span aria-hidden className="text-ink-300">&middot;</span>
                            <span>{callDuration(call.durationSeconds)}</span>
                          </>
                        ) : null}
                        {!missed && call.status && call.status !== 'completed' ? (
                          <>
                            <span aria-hidden className="text-ink-300">&middot;</span>
                            <span className="capitalize">{call.status.replace(/-/g, ' ')}</span>
                          </>
                        ) : null}
                      </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-1.5">
                      <PillButton
                        icon="phone"
                        label="Call back"
                        tone="brand"
                        disabled={!canCall}
                        onClick={() => void dial(peer)}
                      />
                      <PillButton
                        icon="message-square"
                        label="Text"
                        tone="plain"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent('tapdash:compose-sms', { detail: { to: peer } }),
                          )
                        }
                      />
                      <TelephonyDelete kind="call" id={call.id} />
                    </span>
                  </div>

                  {/*
                    The recording belongs HERE as well as in the drawer. A call
                    to a number that is on no record — every test call, and any
                    call to a new prospect — has no drawer to appear in, so
                    without this its audio is stored and unreachable.
                  */}
                  {call.recordings.length > 0 ? (
                    /* Indented to line up under the number rather than starting
                       at the card's left edge. Full-width it read as a separate
                       strip belonging to nothing in particular; aligned, it
                       plainly belongs to the call above it. */
                    <div className="mt-2 space-y-2 border-t border-line-faint pl-[40px] pt-2">
                      {call.recordings.map((rec) => (
                        <RecordingRow key={rec.id} recording={rec} />
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
  );
}

/** "4:07", the way a phone shows it. */
function callDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * A small filled action button.
 *
 * The row's actions used to be ghost buttons — text with no edge — which at
 * this size read as labels rather than as things to press, and gave no target
 * to aim at. These carry a tint and a border so the row has something that
 * plainly IS a button, without shouting over the number itself.
 */
function PillButton({
  icon,
  label,
  tone,
  disabled,
  onClick,
}: {
  icon: 'phone' | 'message-square';
  label: string;
  tone: 'brand' | 'plain';
  disabled?: boolean;
  onClick: () => void;
}) {
  const tones = {
    brand:
      'border-brand-600/15 bg-brand-50 text-brand-700 hover:border-brand-600/30 hover:bg-brand-100',
    plain: 'border-line bg-white text-ink-600 hover:border-ink-300 hover:bg-canvas hover:text-ink-900',
  } as const;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone]}`}
    >
      <Icon name={icon} size={11.5} strokeWidth={2.2} />
      {label}
    </button>
  );
}
