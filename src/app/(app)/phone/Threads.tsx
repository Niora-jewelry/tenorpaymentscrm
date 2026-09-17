'use client';

/**
 * SMS conversations on the standalone phone page.
 *
 * ── WHY THIS IS NOT JUST THE DRAWER'S TEXT TAB AGAIN ─────────────────────
 * The drawer filters texts by `record_id`. A message from a number that
 * matches no merchant has no record id, so without this screen it was stored
 * correctly, counted correctly, and completely invisible — a merchant's reply
 * arriving into a table nobody could open. That is the failure mode this page
 * exists to close, which is also why a thread with no matching record is shown
 * plainly as "No matching record" rather than hidden or greyed out.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, EmptyState, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import type { PhoneThread } from '@/lib/phone/messages';
import { sendSmsAction } from '../phoneActions';
import { usePhone } from './PhoneProvider';

export function Threads({ threads }: { threads: PhoneThread[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const { dial, deviceState, activeCall } = usePhone();

  const send = (to: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    startTransition(async () => {
      setError(null);
      setSent(false);
      const result = await sendSmsAction(to, trimmed, '/phone');
      if (result.ok) {
        setBody('');
        setSent(true);
      } else {
        setError(result.message);
      }
    });
  };

  if (threads.length === 0) {
    return (
      <section className="rounded-2xl border border-line bg-white p-4">
        <h2 className="text-[13.5px] font-semibold text-ink-900">Messages</h2>
        <div className="mt-3">
          <EmptyState
            icon="message-square"
            title="No conversations"
            body="Texts you send or receive appear here, including from numbers that match no record."
          />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-white p-4">
      <h2 className="text-[13.5px] font-semibold text-ink-900">Messages</h2>

      <ul className="mt-3 space-y-2">
        {threads.map((t) => {
          const open = openKey === t.threadKey;
          return (
            <li key={t.threadKey} className="rounded-xl border border-line-soft">
              <button
                type="button"
                onClick={() => {
                  setOpenKey(open ? null : t.threadKey);
                  setBody('');
                  setError(null);
                  setSent(false);
                }}
                className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left"
              >
                <Icon
                  name={t.lastDirection === 'in' ? 'reply' : 'send'}
                  size={12}
                  className="text-ink-400"
                />
                <span className="text-[13px] font-medium text-ink-900 tabular">
                  {formatPhoneDisplay(t.threadKey)}
                </span>
                {t.recordId ? (
                  <StatusPill label="Matched" swatch="teal" dot={false} />
                ) : (
                  // Said out loud rather than hidden: an unmatched thread is the
                  // case this whole screen exists for.
                  <StatusPill label="No matching record" swatch="amber" dot={false} />
                )}
                <span className="truncate text-[12.5px] text-ink-500">{t.lastBody}</span>
                <span className="ml-auto whitespace-nowrap text-[11.5px] text-ink-400 tabular">
                  {formatDateTime(t.lastAt)}
                </span>
                <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} className="text-ink-400" />
              </button>

              {open ? (
                <div className="space-y-2 border-t border-line-faint px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="phone"
                      disabled={activeCall !== null || deviceState === 'error'}
                      onClick={() => void dial(t.threadKey)}
                    >
                      Call
                    </Button>
                    <span className="text-[11.5px] text-ink-400">
                      {t.count} message{t.count === 1 ? '' : 's'}
                    </span>
                  </div>

                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={2}
                    maxLength={1600}
                    placeholder={`Text ${formatPhoneDisplay(t.threadKey)}…`}
                    className="w-full resize-y rounded-lg border border-line bg-canvas/40 px-2.5 py-2 text-[13px] text-ink-900 focus-field"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send(t.threadKey);
                      }
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      icon="send"
                      onClick={() => send(t.threadKey)}
                      disabled={pending || !body.trim()}
                    >
                      {pending ? 'Sending…' : 'Send'}
                    </Button>
                    {sent ? <span className="text-[11.5px] text-ink-500">Sent.</span> : null}
                    {error ? <span className="text-[11.5px] text-red-600">{error}</span> : null}
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
