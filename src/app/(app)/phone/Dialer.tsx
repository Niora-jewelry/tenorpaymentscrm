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
import { useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, EmptyState, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import type { PhoneCall } from '@/lib/phone/calls';
import { usePhone } from './PhoneProvider';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export function Dialer({ calls, myNumber }: { calls: PhoneCall[]; myNumber: string | null }) {
  const { dial, deviceState, errorMessage, activeCall } = usePhone();
  const [number, setNumber] = useState('');

  const busy = activeCall !== null;

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
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

        {errorMessage ? (
          <p className="mt-3 inline-flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-2 text-[12px] text-red-700">
            <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
            <span>{phrase(errorMessage)}</span>
          </p>
        ) : null}
      </section>

      <section className="rounded-2xl border border-line bg-white p-4">
        <h2 className="text-[13.5px] font-semibold text-ink-900">Your calls</h2>

        {calls.length === 0 ? (
          <div className="mt-3">
            <EmptyState icon="phone" title="No calls yet" body="Calls you make or take appear here." />
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {calls.map((call) => {
              const peer = call.direction === 'in' ? call.fromE164 : call.toE164;
              const missed =
                call.direction === 'in' && ['no-answer', 'busy', 'failed'].includes(call.status);
              return (
                <li
                  key={call.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-line-soft px-3 py-2"
                >
                  <Icon
                    name={call.direction === 'in' ? 'reply' : 'send'}
                    size={12}
                    className={missed ? 'text-red-500' : 'text-ink-400'}
                  />
                  <span className="text-[13px] font-medium text-ink-900 tabular">
                    {formatPhoneDisplay(peer)}
                  </span>
                  {missed ? <StatusPill label="Missed" swatch="red" dot={false} /> : null}
                  <span className="ml-auto text-[11.5px] text-ink-400 tabular">
                    {formatDateTime(call.startedAt)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="phone"
                    disabled={busy || deviceState === 'error'}
                    onClick={() => void dial(peer)}
                  >
                    Call back
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The token route's error codes, in English.
 *
 * These come back as machine strings so the route stays a clean API; turning
 * them into sentences is this screen's job, and an unrecognised one falls
 * through unchanged rather than being swallowed.
 */
function phrase(message: string): string {
  if (message === 'no_phone_number_assigned') {
    return 'You have no phone number assigned. An administrator can assign one under Admin → Phone numbers.';
  }
  if (message === 'phone_not_permitted') {
    return 'Your permissions do not include the phone. Ask an administrator about the Communication → Phone subtab.';
  }
  if (message === 'twilio_not_configured') {
    return 'Telephony is not configured on this deployment.';
  }
  return message;
}
