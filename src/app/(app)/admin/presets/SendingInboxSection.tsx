'use client';

/**
 * Admin → Presets → Sending inbox (client, 3 Nov 2026): "I could choose which
 * inbox those emails come out of" — applications, proposals, agreements.
 * Each kind goes from the sender's own mailbox, or from one company inbox
 * (office@) for everyone; agreements can also stay with SignWell's own email.
 *
 * Only inboxes already connected in Email (with a working connection) can be
 * picked: the email goes through that connection.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import type { SendingInboxSettings, SendMode, SendPurpose } from '@/lib/mail/sendingInbox';
import { saveSendingInboxAction } from './sendingInboxActions';

const KINDS: { purpose: SendPurpose; title: string; what: string; icon: IconName }[] = [
  { purpose: 'applications', title: 'Applications', what: 'The online application link and its PDF.', icon: 'file-pen' },
  { purpose: 'proposals', title: 'Proposals', what: 'The link to the merchant’s proposal.', icon: 'file-text' },
  { purpose: 'agreements', title: 'Agreements', what: 'The e-signature request, reminders and the signed-copy note.', icon: 'send' },
];

type Row = SendingInboxSettings['rows'][number];

function KindRow({ kind, row, inboxes }: { kind: (typeof KINDS)[number]; row: Row; inboxes: SendingInboxSettings['inboxes'] }) {
  const value = (r: Row) => (r.mode === 'mailbox' ? `mailbox:${r.mailboxId}` : r.mode);
  const [saved, setSaved] = useState(value(row));
  const [choice, setChoice] = useState(value(row));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const missing = row.mode === 'mailbox' && !inboxes.some((i) => i.mailboxId === row.mailboxId);

  const save = () =>
    start(async () => {
      setError(null);
      setDone(false);
      const [mode, id] = choice.split(':') as [SendMode, string | undefined];
      const r = await saveSendingInboxAction({ purpose: kind.purpose, mode, mailboxId: mode === 'mailbox' ? (id ?? null) : null });
      if (!r.ok) return setError(r.message);
      setSaved(choice);
      setDone(true);
    });

  const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none focus-field disabled:opacity-60';
  return (
    <li className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] sm:items-center">
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name={kind.icon} size={15} />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-ink-900">{kind.title}</p>
          <p className="text-[12px] leading-snug text-ink-500">{kind.what}</p>
        </div>
      </div>
      <div>
        <label className="sr-only" htmlFor={`inbox-${kind.purpose}`}>
          {kind.title} go out from
        </label>
        <select id={`inbox-${kind.purpose}`} value={choice} onChange={(e) => { setChoice(e.target.value); setDone(false); }} disabled={pending} className={field}>
          {kind.purpose === 'agreements' ? <option value="signwell">SignWell’s own email (no inbox)</option> : null}
          <option value="own">The sender’s own mailbox</option>
          {inboxes.length ? (
            <optgroup label="One company inbox for everyone">
              {inboxes.map((i) => (
                <option key={i.mailboxId} value={`mailbox:${i.mailboxId}`}>
                  {i.displayName ? `${i.displayName} <${i.address}>` : i.address}
                </option>
              ))}
            </optgroup>
          ) : null}
          {missing ? <option value={`mailbox:${row.mailboxId}`}>An inbox that is no longer connected</option> : null}
        </select>
        {choice === 'signwell' ? (
          <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-snug text-[#8a5a09]">
            <Icon name="alert-triangle" size={12} className="mt-0.5 shrink-0" /> SignWell emails the signers itself and sends each of them the signed agreement. Pick a mailbox so signers get no copy.
          </p>
        ) : null}
        {missing && choice === saved ? (
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-[#8a5a09]">
            <Icon name="alert-triangle" size={12} /> This inbox has no working connection, so nothing can be sent. Reconnect it in Email or pick another.
          </p>
        ) : null}
        {error ? (
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-bad">
            <Icon name="alert-triangle" size={12} /> {error}
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2">
        {done && choice === saved ? (
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#0b6b5d]">
            <Icon name="check" size={13} /> Saved
          </span>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={pending || choice === saved}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-ink transition-colors hover:bg-accent-dim disabled:opacity-50"
        >
          {pending ? <Spinner /> : null} Save
        </button>
      </div>
    </li>
  );
}

export function SendingInboxSection({ settings }: { settings: SendingInboxSettings }) {
  return (
    <div className="rounded-xl border border-line bg-white">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">Sending inbox</h2>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">
          Which inbox each kind of email comes from. A company inbox (such as office@) sends for everyone — the email shows in that inbox’s Sent folder and replies land there.
          The sender doesn’t need Email access of their own.
        </p>
      </div>
      {settings.inboxes.length === 0 ? (
        <p className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-600">
          <Icon name="info" size={14} className="mt-[2px] shrink-0 text-ink-400" />
          <span>
            No inbox is connected yet. To use a company inbox, connect it once in{' '}
            <Link href="/email" className="font-semibold text-brand-700 hover:underline">
              Email
            </Link>{' '}
            (sign in as that mailbox, or add it as a shared mailbox), then pick it here.
          </span>
        </p>
      ) : null}
      <ul className="divide-y divide-line-faint">
        {KINDS.map((k) => (
          <KindRow key={k.purpose} kind={k} row={settings.rows.find((r) => r.purpose === k.purpose)!} inboxes={settings.inboxes} />
        ))}
      </ul>
    </div>
  );
}
