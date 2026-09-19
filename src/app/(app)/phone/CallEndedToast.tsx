'use client';

/**
 * "That call has ended — here is the way back to it."
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * When a call ends the call bar simply disappears, and the recording lands a
 * few seconds later through a Twilio callback. Nothing on screen connected the
 * two, so the only way to reach the recording was to remember which merchant
 * it was and navigate there by hand — and for a number that matches no record,
 * to know that the Phone page existed at all.
 *
 * ── THE DESTINATION IS RESOLVED WHEN CLICKED, NOT BEFORE ─────────────────
 * It depends on which modules the viewer may open, which is a server question.
 * Resolving it eagerly would put a round trip on the end of every call for a
 * button most people will not press; resolving it on click costs one request
 * exactly when it is wanted.
 *
 * ── IT DOES NOT PROMISE THE AUDIO IS READY ───────────────────────────────
 * Twilio finishes the recording, posts it to us, we download and store it —
 * seconds, sometimes longer. The wording is "View recording" rather than
 * "Play", and the row it lands on says "Processing the recording…" until the
 * file is actually ours. Claiming otherwise would send people to a spinner and
 * make them think it was broken.
 *
 * It auto-dismisses, because a notice about a finished call must never end up
 * sitting over the next one. The bell keeps the permanent record.
 */
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import { callDestinationAction } from '../phoneActions';
import { usePhone } from './PhoneProvider';

const DISMISS_AFTER_MS = 30_000;

export function CallEndedToast() {
  const { endedCall, dismissEndedCall } = usePhone();
  if (!endedCall) return null;

  /*
   * Keyed per call so every notice starts clean. Resetting the local state in
   * an effect instead would be a set-state-during-effect, and would also leave
   * one render showing the previous call's error.
   */
  return (
    <Ended
      key={endedCall.callId ?? `${endedCall.peer}-${endedCall.direction}`}
      call={endedCall}
      onDismiss={dismissEndedCall}
    />
  );
}

function Ended({
  call: endedCall,
  onDismiss: dismissEndedCall,
}: {
  call: NonNullable<ReturnType<typeof usePhone>['endedCall']>;
  onDismiss: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(dismissEndedCall, DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [dismissEndedCall]);

  const open = () =>
    startTransition(async () => {
      try {
        const href = await callDestinationAction(endedCall.callId ?? '');
        dismissEndedCall();
        router.push(href);
      } catch {
        // The Phone page always lists your own calls, so it is a destination
        // that cannot be wrong — better than leaving the button dead.
        setFailed(true);
        dismissEndedCall();
        router.push('/phone');
      }
    });

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 w-[min(94vw,480px)] rounded-2xl border border-line bg-white p-4 shadow-[0_10px_36px_rgba(8,32,47,.16)]"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700">
          <Icon name={endedCall.direction === 'in' ? 'reply' : 'send'} size={13} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-ink-900">Call ended</p>
          <p className="mt-0.5 truncate text-[13px] font-medium text-ink-700">
            {formatPhoneDisplay(endedCall.peer)}
          </p>
          {failed ? (
            <p className="mt-1 text-[11.5px] text-ink-400">
              Could not work out where that call lives — opening your call history instead.
            </p>
          ) : (
            <p className="mt-1 text-[11.5px] text-ink-400">
              The recording appears here once Twilio has finished processing it.
            </p>
          )}

          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={open}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-[12.5px] font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? 'Opening…' : 'View recording'}
            </button>
            <button
              type="button"
              onClick={dismissEndedCall}
              className="rounded-lg px-2 py-1.5 text-[12px] font-medium text-ink-500 transition-colors hover:bg-canvas hover:text-ink-900"
            >
              Dismiss
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={dismissEndedCall}
          aria-label="Dismiss"
          className="grid size-6 shrink-0 place-items-center rounded-md text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900"
        >
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  );
}
