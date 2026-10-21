'use client';

/**
 * Connected mailboxes: what each one is doing, and connecting more.
 *
 * Right after Microsoft sends the person back, a dialog confirms the
 * connection and follows the first sync live — mailbox linked, folders
 * found, recent mail arriving — so nobody is left wondering whether it
 * worked. While any mailbox is still setting up, the page refreshes itself.
 */
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, OutlineChip, Spinner, StatusPill } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { Swatch } from '@/proto/schema';
import type { ConnectionHealth, MyMailbox } from '@/lib/mail/mailboxes';
import { disconnectMailboxAction } from '../actions';
import { swatchFor } from '../ui/people';

export type Banner = { tone: 'ok' | 'warn' | 'error'; text: string };
export type JustConnected = { mailboxId: string; reconnected: boolean; degraded: boolean };

const HEALTH: Record<ConnectionHealth, { label: string; swatch: Swatch; hint: string }> = {
  ok: { label: 'Syncing', swatch: 'green', hint: 'Changes in Outlook show here within a minute, and the other way round.' },
  setting_up: { label: 'Setting up', swatch: 'blue', hint: 'Fetching the last two weeks of mail from Outlook…' },
  needs_reconnect: { label: 'Needs reconnect', swatch: 'amber', hint: 'Microsoft signed TapDash out of this mailbox. Reconnect to resume syncing.' },
  needs_permission: { label: 'Needs permission', swatch: 'amber', hint: 'Some permissions were not granted. Reconnect and approve them all.' },
  stalled: { label: 'Stopped syncing', swatch: 'red', hint: 'Nobody’s sign-in can reach this mailbox any more. Reconnect it.' },
  throttled: { label: 'Outlook busy', swatch: 'amber', hint: 'Microsoft asked TapDash to slow down. Syncing resumes by itself.' },
};

const BANNER_STYLE: Record<Banner['tone'], string> = {
  ok: 'border-[#c5ecd0] bg-[#e3f6e8] text-[#1a7a3c]',
  warn: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]',
  error: 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]',
};

const START = '/api/mail/oauth/start';
const RETURN = '/email/settings';
const NUM = new Intl.NumberFormat('en-GB');

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

function ago(iso: string | null, now: number): string {
  if (!iso) return 'not yet';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const inboxHref = (mb: MyMailbox) => (mb.inboxId ? `/email?f=${mb.inboxId}` : '/email');

export function MailboxSettings({
  mailboxes,
  max,
  readOnly,
  banner: initialBanner,
  justConnected,
}: {
  mailboxes: MyMailbox[];
  max: number;
  readOnly: boolean;
  banner: Banner | null;
  justConnected: JustConnected | null;
}) {
  const router = useRouter();
  const [banner, setBanner] = useState<Banner | null>(initialBanner);
  const [connected, setConnected] = useState<JustConnected | null>(justConnected);
  const [confirming, setConfirming] = useState<MyMailbox | null>(null);
  const [pending, startTransition] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const atCap = mailboxes.length >= max;
  const settingUp = mailboxes.some((m) => m.health === 'setting_up');

  // The address bar keeps ?connected=… otherwise, and a reload would show the dialog again.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }, []);

  // Follow the first sync live, then settle to a slow tick for the "synced … ago" labels.
  useEffect(() => {
    const fast = settingUp || connected !== null;
    const t = setInterval(() => {
      setNow(Date.now());
      if (fast) router.refresh();
    }, fast ? 4_000 : 30_000);
    return () => clearInterval(t);
  }, [settingUp, connected, router]);

  function disconnect(mb: MyMailbox) {
    startTransition(async () => {
      const res = await disconnectMailboxAction({ connectionId: mb.connectionId });
      setConfirming(null);
      setBanner({ tone: res.ok ? 'ok' : 'error', text: res.message ?? '' });
      if (res.ok) router.refresh();
    });
  }

  const justBox = connected ? mailboxes.find((m) => m.mailboxId === connected.mailboxId) : undefined;

  return (
    <div className="space-y-8">
      {banner ? (
        <div
          role={banner.tone === 'error' ? 'alert' : 'status'}
          className={`flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-[13px] font-medium ${BANNER_STYLE[banner.tone]}`}
        >
          <span className="flex items-start gap-2">
            <Icon name={banner.tone === 'ok' ? 'check' : 'alert-triangle'} size={14} className="mt-[2px] shrink-0" />
            {banner.text}
          </span>
          <button type="button" onClick={() => setBanner(null)} className="cursor-pointer opacity-60 hover:opacity-100" aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ) : null}

      {readOnly ? (
        <p className="flex items-start gap-2 rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-[13px] text-ink-500">
          <Icon name="eye" size={14} className="mt-[2px] shrink-0" />
          You&apos;re signed in as another user. Mailbox health is shown; connecting and disconnecting are not available.
        </p>
      ) : null}

      <section id="mailboxes" className="scroll-mt-6 space-y-3">
        <SectionHead title="Connected mailboxes" note={`${mailboxes.length} of ${max}`} />

        {mailboxes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-white px-6 py-10 text-center">
            <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-brand-50 text-brand-700">
              <Icon name="mail" size={20} />
            </span>
            <p className="text-[14px] font-semibold text-ink-900">No mailboxes yet</p>
            <p className="mx-auto mt-1 max-w-[44ch] text-[12.5px] leading-relaxed text-ink-500">
              Connect your Outlook mailbox below to read, file and send email from TapDash. It stays in sync with Outlook both ways.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {mailboxes.map((mb) => (
              <MailboxCard key={mb.connectionId} mb={mb} now={now} readOnly={readOnly} busy={pending} onDisconnect={() => setConfirming(mb)} />
            ))}
          </ul>
        )}
      </section>

      {readOnly ? null : (
        <section id="connect" className="scroll-mt-6 space-y-3">
          <SectionHead title="Connect a mailbox" />
          {atCap ? (
            <p className="rounded-lg border border-line bg-canvas px-3.5 py-2.5 text-[13px] text-ink-500">
              You&apos;ve connected {max} mailboxes, the maximum. Disconnect one to add another.
            </p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <form action={START} method="get" onSubmit={goConnect} className="flex flex-col rounded-xl border border-line bg-white p-5">
              <input type="hidden" name="kind" value="personal" />
              <input type="hidden" name="return" value={RETURN} />
              <span className="mb-3 grid size-9 place-items-center rounded-lg bg-brand-50 text-brand-700">
                <Icon name="user" size={17} />
              </span>
              <p className="text-[14px] font-semibold text-ink-900">Your Outlook mailbox</p>
              <p className="mt-1 flex-1 text-[12.5px] leading-relaxed text-ink-500">
                Sign in with your Microsoft 365 work account. Your folders, mail and rules come across as they are in Outlook.
              </p>
              <div className="mt-4">
                <Button type="submit" variant="primary" icon="mail" disabled={atCap}>
                  Connect Outlook
                </Button>
              </div>
            </form>

            <form action={START} method="get" onSubmit={goConnect} className="flex flex-col rounded-xl border border-line bg-white p-5">
              <input type="hidden" name="kind" value="shared" />
              <input type="hidden" name="return" value={RETURN} />
              <span className="mb-3 grid size-9 place-items-center rounded-lg bg-canvas text-ink-500">
                <Icon name="users" size={17} />
              </span>
              <label htmlFor="shared-address" className="text-[14px] font-semibold text-ink-900">
                A shared mailbox
              </label>
              <p className="mt-1 flex-1 text-[12.5px] leading-relaxed text-ink-500">
                You sign in as yourself. Your Microsoft admin must already have given you access to it in Outlook.
              </p>
              <div className="mt-4 flex gap-2">
                <input
                  id="shared-address"
                  name="address"
                  type="email"
                  required
                  maxLength={254}
                  placeholder="sales@yourcompany.com"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none placeholder:text-ink-300 focus:border-brand-600"
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
          <p>
            TapDash stops syncing this mailbox for you. Your mail stays in Outlook, untouched.
            {confirming.kind === 'shared' ? ' Other people who connected it keep their access.' : ''}
          </p>
        </Dialog>
      ) : null}

      {connected ? <ConnectedDialog info={connected} mb={justBox} onClose={() => setConnected(null)} /> : null}
    </div>
  );
}

function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
      {note ? <span className="text-[12px] font-semibold tabular text-ink-400">{note}</span> : null}
    </div>
  );
}

function MailboxCard({ mb, now, readOnly, busy, onDisconnect }: { mb: MyMailbox; now: number; readOnly: boolean; busy: boolean; onDisconnect: () => void }) {
  const h = HEALTH[mb.health];
  const needsAction = mb.health === 'needs_reconnect' || mb.health === 'needs_permission' || mb.health === 'stalled';
  const sw = swatchFor(mb.address);
  const name = mb.displayName || mb.address.split('@')[0];
  return (
    <li className={`rounded-xl border bg-white ${needsAction ? 'border-[#f7e0af]' : 'border-line'}`}>
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full text-[14px] font-bold" style={{ background: sw.bg, color: sw.text }}>
          {name[0]?.toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-ink-900">{name}</span>
            {mb.kind === 'shared' ? <OutlineChip>Shared</OutlineChip> : null}
            <StatusPill label={h.label} swatch={h.swatch} />
          </div>
          <p className="truncate text-[12.5px] text-ink-500">{mb.address}</p>
        </div>
        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            {needsAction ? (
              <a
                href={reconnectHref(mb)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] hover:bg-accent-dim"
              >
                <Icon name="refresh-cw" size={13} /> Reconnect
              </a>
            ) : (
              <Link
                href={inboxHref(mb)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400 hover:bg-canvas"
              >
                <Icon name="inbox" size={13} /> Open inbox
              </Link>
            )}
            <Link
              href={`/email/rules/${mb.mailboxId}`}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-500 hover:bg-canvas hover:text-ink-900"
            >
              <Icon name="sliders" size={13} /> Rules
            </Link>
            <Button size="sm" variant="ghost" onClick={onDisconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line-faint bg-canvas/50 px-5 py-2.5 text-[12px] text-ink-500">
        <Stat icon="refresh-cw" label={`Synced ${ago(mb.lastSyncedAt, now)}`} spin={mb.health === 'setting_up'} />
        <Stat icon="folder" label={mb.health === 'setting_up' && mb.folders ? `${mb.foldersReady} of ${mb.folders} folders ready` : `${mb.folders} folder${mb.folders === 1 ? '' : 's'}`} />
        <Stat icon="mail" label={`${NUM.format(mb.messages)} messages in Outlook`} />
        {mb.inboxUnread ? <Stat icon="inbox" label={`${NUM.format(mb.inboxUnread)} unread`} /> : null}
        <span className="ml-auto text-ink-400">Connected {new Date(mb.connectedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      </div>
      {mb.health !== 'ok' ? (
        <p className={`border-t px-5 py-2 text-[12px] ${needsAction ? 'border-[#f7e0af] bg-[#fdf6e7] text-[#8a5a00]' : 'border-line-faint text-ink-500'}`}>{h.hint}</p>
      ) : null}
    </li>
  );
}

function Stat({ icon, label, spin = false }: { icon: 'refresh-cw' | 'folder' | 'mail' | 'inbox'; label: string; spin?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon name={icon} size={12} className={`text-ink-400 ${spin ? 'animate-spin [animation-duration:2.4s]' : ''}`} />
      {label}
    </span>
  );
}

/** The moment after Microsoft sends the person back: it worked, and here is the first sync happening. */
function ConnectedDialog({ info, mb, onClose }: { info: JustConnected; mb: MyMailbox | undefined; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!open) onClose();
  }, [open, onClose]);

  const linked = Boolean(mb);
  const foldersFound = (mb?.folders ?? 0) > 0;
  const mailIn = mb?.health === 'ok' || (foldersFound && (mb?.foldersReady ?? 0) >= (mb?.folders ?? 1));
  const steps: Array<{ label: string; done: boolean; detail?: string }> = [
    { label: info.reconnected ? 'Sign-in renewed' : 'Mailbox linked to TapDash', done: linked },
    { label: 'Folders found in Outlook', done: foldersFound, detail: foldersFound ? `${mb!.folders} folders` : undefined },
    { label: 'Recent mail arriving', done: mailIn, detail: mailIn ? 'Last two weeks — older mail on request' : undefined },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-brand-950/35" onClick={() => setOpen(false)} />
      <div role="dialog" aria-modal="true" aria-labelledby="connected-title" className="animate-dialog-in relative w-full max-w-[440px] overflow-hidden rounded-panel border border-line bg-white shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]">
        <div className="px-6 pb-5 pt-6 text-center">
          <span className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-[#e3f6e8] text-[#1a7a3c]">
            <Icon name="check" size={22} strokeWidth={2.4} />
          </span>
          <h2 id="connected-title" className="text-[17px] font-semibold text-ink-900">
            {info.reconnected ? 'Outlook reconnected' : 'Outlook connected'}
          </h2>
          <p className="mt-1 truncate text-[13px] text-ink-500">{mb?.address ?? 'Your mailbox'}</p>
          {info.degraded ? (
            <p className="mt-3 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-left text-[12.5px] leading-relaxed text-[#8a5a09]">
              Microsoft granted fewer permissions than Email needs. Some actions stay unavailable until you reconnect and approve them all.
            </p>
          ) : null}
        </div>
        <ol aria-live="polite" className="space-y-2.5 border-y border-line-faint bg-canvas/60 px-6 py-4">
          {steps.map((s, i) => (
            <li key={s.label} className="flex items-center gap-3 text-[13px]">
              <span
                className={`grid size-5 shrink-0 place-items-center rounded-full ${
                  s.done ? 'bg-[#1a7a3c] text-white' : i === current ? 'text-brand-700' : 'border border-line text-transparent'
                }`}
              >
                {s.done ? <Icon name="check" size={11} strokeWidth={3} /> : i === current ? <Spinner /> : null}
              </span>
              <span className={`flex-1 ${s.done ? 'text-ink-900' : i === current ? 'font-medium text-ink-700' : 'text-ink-400'}`}>{s.label}</span>
              {s.detail ? <span className="text-[11.5px] text-ink-400">{s.detail}</span> : null}
            </li>
          ))}
        </ol>
        <div className="flex items-center justify-between gap-2 px-6 py-4">
          <p className="text-[11.5px] text-ink-400">{current === -1 ? 'All set.' : 'You can leave this page; it carries on.'}</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Done
            </Button>
            <Link
              href={mb ? inboxHref(mb) : '/email'}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] hover:bg-accent-dim"
            >
              Open inbox <Icon name="arrow-right" size={14} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
