'use client';

/**
 * The floating call bar — the only phone UI that follows you around the CRM.
 *
 * It renders nothing at all when there is no call, which is the overwhelmingly
 * common case, so the cost of mounting it app-wide is a null check. When a
 * merchant rings, it appears wherever you happen to be: the point of an
 * app-wide Device is that inbound calls are not confined to one screen.
 *
 * Deliberately NOT a dialog. A modal would trap focus and block whatever the
 * user was typing — including, plausibly, notes about the very merchant now
 * calling. It sits above the content and takes nothing away.
 */
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import { usePhone } from './PhoneProvider';

export function CallBar() {
  const { activeCall, incoming, hangUp, answer, reject } = usePhone();

  const call = incoming ?? activeCall;
  if (!call) return null;

  const isIncomingRinging = Boolean(incoming);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-2xl border border-line bg-white/95 px-4 py-3 shadow-lg backdrop-blur"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`grid size-8 place-items-center rounded-full ${
            isIncomingRinging ? 'animate-pulse bg-brand-50 text-brand-700' : 'bg-canvas text-ink-500'
          }`}
        >
          <Icon name="phone" size={15} />
        </span>

        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-ink-900">
            {formatPhoneDisplay(call.peer)}
          </p>
          <p className="text-[11.5px] uppercase tracking-[.05em] text-ink-400">
            {isIncomingRinging
              ? 'Incoming call'
              : call.status === 'ringing'
                ? 'Calling…'
                : 'Connected'}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isIncomingRinging ? (
            <>
              <Button size="sm" icon="phone" onClick={answer}>
                Answer
              </Button>
              <Button size="sm" variant="danger" onClick={reject}>
                Decline
              </Button>
            </>
          ) : (
            <Button size="sm" variant="danger" onClick={hangUp}>
              Hang up
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
