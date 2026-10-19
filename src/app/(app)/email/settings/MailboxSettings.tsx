'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, EmptyState, OutlineChip, SectionLabel, StatusPill } from '@/proto/ui/kit';
import type { Swatch } from '@/proto/schema';
import type { ConnectionHealth, MyMailbox } from '@/lib/mail/mailboxes';
import { disconnectMailboxAction } from '../actions';

export type Banner = { tone: 'ok' | 'warn' | 'error'; text: string };

const HEALTH: Record<ConnectionHealth, { label: string; swatch: Swatch }> = {
  ok: { label: 'Syncing', swatch: 'green' },
  setting_up: { label: 'Setting up', swatch: 'blue' },
  needs_reconnect: { label: 'Needs reconnect', swatch: 'amber' },
  needs_permission: { label: 'Needs permission', swatch: 'amber' },
  stalled: { label: 'Stopped syncing', swatch: 'red' },
  throttled: { label: 'Outlook busy', swatch: 'amber' },
};

const BANNER_STYLE: Record<Banner['tone'], string> = {
  ok: 'border-[#c5ecd0] bg-[#e3f6e8] text-[#1a7a3c]',
  warn: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]',
  error: 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]',
};

const START = '/api/mail/oauth/start';
const RETURN = '/email/settings';

/**
 * Connect forms navigate from script. As plain form submissions they would
 * redirect on to Microsoft, and the CSP's `form-action 'self'` applies to
 * that redirect too — under an enforced CSP the button would simply do
 * nothing. A navigation is not a form submission. (Without JS the forms
 * still submit normally.)
 */
function goConnect(e: React.FormEvent<HTMLFormElement>) {
  e.preventDefault();
  const data = new FormData(e.currentTarget);
  const q = new URLSearchParams();
  for (const [k, v] of data) if (typeof v === 'string') q.set(k, v);
  // A full navigation (not router.push): this route answers with a redirect to Microsoft.
  window.location.assign(new URL(`${START}?${q.toString()}`, window.location.origin).toString());
}

function reconnectHref(mb: MyMailbox): string {
  const q = new URLSearchParams({ kind: mb.kind, return: RETURN });
  if (mb.kind === 'shared') q.set('address', mb.address);
  return `${START}?${q.toString()}`;
}

export function MailboxSettings({
  mailboxes,
  max,
  readOnly,
  banner: initialBanner,
}: {
  mailboxes: MyMailbox[];
  max: number;
  readOnly: boolean;
  banner: Banner | null;
}) {
  const router = useRouter();
  const [banner, setBanner] = useState<Banner | null>(initialBanner);
  const [confirming, setConfirming] = useState<MyMailbox | null>(null);
  const [pending, startTransition] = useTransition();
  const atCap = mailboxes.length >= max;

  function disconnect(mb: MyMailbox) {
    startTransition(async () => {
      const res = await disconnectMailboxAction({ connectionId: mb.connectionId });
      setConfirming(null);
      setBanner({ tone: res.ok ? 'ok' : 'error', text: res.message ?? '' });
      if (res.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {banner ? (
        <div
          role={banner.tone === 'error' ? 'alert' : 'status'}
          className={`flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-[13px] font-medium ${BANNER_STYLE[banner.tone]}`}
        >
          <span>{banner.text}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            className="cursor-pointer text-[12px] font-semibold opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}

      {readOnly ? (
        <p className="rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-[13px] text-ink-500">
          You&apos;re signed in as another user. Mailbox health is shown; connecting and disconnecting are not available.
        </p>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <SectionLabel>Mailboxes</SectionLabel>
          <span className="text-[12px] font-semibold text-ink-400">
            {mailboxes.length} of {max}
          </span>
        </div>

        {mailboxes.length === 0 ? (
          <EmptyState
            icon="mail"
            title="No mailboxes connected"
            body="Connect your Outlook mailbox to read and send email from TapDash. Shared mailboxes you have access to in Outlook can be added too."
          />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
            {mailboxes.map((mb) => {
              const h = HEALTH[mb.health];
              const needsAction = mb.health === 'needs_reconnect' || mb.health === 'needs_permission' || mb.health === 'stalled';
              return (
                <li key={mb.connectionId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13.5px] font-semibold text-ink-900">{mb.address}</span>
                      {mb.kind === 'shared' ? <OutlineChip>Shared</OutlineChip> : null}
                      <StatusPill label={h.label} swatch={h.swatch} />
                    </div>
                    {mb.displayName ? <p className="truncate text-[12.5px] text-ink-400">{mb.displayName}</p> : null}
                  </div>
                  {readOnly ? null : (
                    <div className="flex items-center gap-2">
                      {needsAction ? (
                        <a
                          href={reconnectHref(mb)}
                          className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400 hover:bg-canvas"
                        >
                          Reconnect
                        </a>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(mb)} disabled={pending}>
                        Disconnect
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {readOnly ? null : (
        <section className="space-y-3">
          <SectionLabel>Connect a mailbox</SectionLabel>
          {atCap ? (
            <p className="text-[13px] text-ink-500">You&apos;ve connected {max} mailboxes, the maximum. Disconnect one to add another.</p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <form action={START} method="get" onSubmit={goConnect} className="space-y-2 rounded-xl border border-line bg-white p-4">
              <input type="hidden" name="kind" value="personal" />
              <input type="hidden" name="return" value={RETURN} />
              <p className="text-[13.5px] font-semibold text-ink-900">Your Outlook mailbox</p>
              <p className="text-[12.5px] text-ink-500">Sign in with your Microsoft 365 work account.</p>
              <Button type="submit" variant="primary" icon="mail" disabled={atCap}>
                Connect Outlook
              </Button>
            </form>

            <form action={START} method="get" onSubmit={goConnect} className="space-y-2 rounded-xl border border-line bg-white p-4">
              <input type="hidden" name="kind" value="shared" />
              <input type="hidden" name="return" value={RETURN} />
              <label htmlFor="shared-address" className="block text-[13.5px] font-semibold text-ink-900">
                A shared mailbox
              </label>
              <p className="text-[12.5px] text-ink-500">
                You sign in as yourself; Outlook must already give you access to it.
              </p>
              <div className="flex gap-2">
                <input
                  id="shared-address"
                  name="address"
                  type="email"
                  required
                  maxLength={254}
                  placeholder="sales@yourcompany.com"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none placeholder:text-ink-300 focus:border-ink-400"
                />
                <Button type="submit" disabled={atCap}>
                  Connect
                </Button>
              </div>
            </form>
          </div>
        </section>
      )}

      {confirming ? (
        <Dialog
          title={`Disconnect ${confirming.address}?`}
          tone="danger"
          confirmLabel={pending ? 'Disconnecting…' : 'Disconnect'}
          onConfirm={() => disconnect(confirming)}
          onClose={() => setConfirming(null)}
        >
          <p className="text-[13.5px] text-ink-600">
            TapDash stops syncing this mailbox for you. Your mail stays in Outlook, untouched.
            {confirming.kind === 'shared' ? ' Other people who connected it keep their access.' : ''}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}
