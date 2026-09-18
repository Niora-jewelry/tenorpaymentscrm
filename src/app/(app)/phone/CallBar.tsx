'use client';

/**
 * The floating call bar — the only phone UI that follows you around the CRM.
 *
 * Renders nothing when there is no call, which is almost always, so the cost on
 * every other page is a null check. When a merchant rings it appears wherever
 * you happen to be: the point of an app-wide Device is that inbound calls are
 * not confined to one screen.
 *
 * ── WHY IT IS DARK, AND WHY THE ACCENT LANDS ON ANSWER ───────────────────
 * It borrows the navigation rail's petrol gradient instead of sitting on white
 * like the rest of the page. A ringing phone is not page content — it is the
 * app interrupting you — and the change of surface is what says so before any
 * word is read.
 *
 * That dark ground is also the only place the lime can work. `globals.css`
 * states the rule plainly: #d5ff4a on white is 1.4:1 and unreadable, and it
 * gets exactly one use — a fill carrying dark text, or text on a dark ground.
 * Answer is the most important button in the product at the moment it appears,
 * so it takes the fill and everything else stays quiet beside it.
 *
 * ── z-[90] IS ABOVE EVERY OTHER LAYER, AND HAS TO BE ─────────────────────
 * The stack here is drawer overlay z-[60], record drawer z-[70], dialogs
 * z-[80]. At the z-50 this started on, an incoming call rang BEHIND the record
 * drawer — the most likely moment for one to arrive, since you are looking at a
 * merchant when they ring back. It could not be answered and nothing explained
 * why. Nothing may sit above this: a ringing phone is the one thing in the CRM
 * that expires if it is not seen.
 *
 * Deliberately NOT a dialog. A modal would trap focus and block whatever the
 * user was typing — plausibly notes about the very merchant now calling.
 */
import { useEffect, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import { usePhone } from './PhoneProvider';

/**
 * The in-call timer.
 *
 * ── WHY IT IS ITS OWN COMPONENT ──────────────────────────────────────────
 * It counts from zero and is mounted ONLY while a call is connected, so the
 * mount itself is the reset — there is no "start time" to store, no ref to
 * read during render, and no `Date.now()` in the render path. All three of
 * those are things React's lint rules reject, and each earlier attempt here
 * tripped one of them.
 *
 * It also means the once-a-second interval exists only during a call. This bar
 * is mounted on every page in the CRM; an idle app must not re-render every
 * second just because it is there.
 */
function CallTimer() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="tabular">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

export function CallBar() {
  const { activeCall, incoming, hangUp, answer, reject } = usePhone();

  const call = incoming ?? activeCall;
  const connected = !incoming && activeCall?.status === 'connected';

  if (!call) return null;

  const isRinging = Boolean(incoming);

  return (
    <div
      role="status"
      aria-live="assertive"
      className="rail-glass fixed bottom-6 left-1/2 z-[90] w-[min(92vw,420px)] -translate-x-1/2 overflow-hidden rounded-2xl shadow-[0_18px_44px_-12px_rgba(1,39,64,.55)] ring-1 ring-white/10"
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        {/* Pulses only while ringing. A connected call is calm — motion that
            never stops stops being information. */}
        <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-white/10 ring-1 ring-inset ring-white/15">
          {isRinging ? (
            <span
              aria-hidden
              className="absolute inset-0 animate-ping rounded-full bg-[color:var(--color-accent)] opacity-25"
            />
          ) : null}
          <Icon
            name="phone"
            size={16}
            className={isRinging ? 'relative text-[color:var(--color-accent)]' : 'relative text-white/85'}
          />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold tracking-[-.01em] text-white tabular">
            {formatPhoneDisplay(call.peer)}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.08em] text-white/55">
            {isRinging ? (
              <>
                <span className="size-[5px] rounded-full bg-[color:var(--color-accent)]" />
                Incoming call
              </>
            ) : connected ? (
              <>
                <span className="size-[5px] rounded-full bg-[color:var(--color-accent)]" />
                <CallTimer />
              </>
            ) : (
              <>
                <span className="size-[5px] animate-pulse rounded-full bg-white/50" />
                Calling…
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isRinging ? (
            <>
              {/* The accent's one permitted use: a fill carrying dark text. */}
              <button
                type="button"
                onClick={answer}
                className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-accent)] px-3.5 py-2 text-[12.5px] font-bold text-[color:var(--color-accent-ink)] shadow-[0_6px_14px_-6px_rgba(213,255,74,.7)] transition-[filter,transform] hover:brightness-105 active:scale-[.97]"
              >
                <Icon name="phone" size={13} />
                Answer
              </button>
              <EndButton onClick={reject} label="Decline" />
            </>
          ) : (
            <EndButton onClick={hangUp} label="Hang up" />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Decline and Hang up are one action to the eye — end this.
 *
 * Muted red rather than the flat alert red used on white: a saturated red
 * button on a petrol ground reads as an error state rather than as a control.
 */
function EndButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full bg-[#e4565c]/90 px-3.5 py-2 text-[12.5px] font-semibold text-white ring-1 ring-inset ring-white/15 transition-[background-color,transform] hover:bg-[#e4565c] active:scale-[.97]"
    >
      <Icon name="phone" size={13} className="rotate-[135deg]" />
      {label}
    </button>
  );
}
