'use client';

/**
 * Send proposal: preview first (client: "User should be able to preview prior
 * to sending it out"), then the email — From, To picker, CC, subject, message.
 * The proposal is frozen as previewed at the moment it is sent.
 */
import { useEffect, useId, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { Button, Spinner } from '@/proto/ui/kit';
import type { ProposalSendDefaults } from '@/lib/proposals/service';
import { money } from '@/lib/proposals/content';
import { proposalDefaultsAction, sendProposalAction } from './proposalActions';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CUSTOM = '__custom__';

export function SendProposalDialog({
  recordId,
  moduleSlug,
  onClose,
  onSent,
}: {
  recordId: string;
  moduleSlug: string;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [defaults, setDefaults] = useState<ProposalSendDefaults | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [toPick, setToPick] = useState(CUSTOM);
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ids = { from: useId(), to: useId(), cc: useId(), subject: useId(), body: useId() };

  useEffect(() => {
    let live = true;
    void proposalDefaultsAction(recordId, moduleSlug).then((r) => {
      if (!live) return;
      if (!r.ok) return setLoadError(r.message);
      setDefaults(r.data);
      setFrom(r.data.from[0]?.mailboxId ?? '');
      const known = r.data.recipients.find((x) => x.address.toLowerCase() === r.data.to.trim().toLowerCase());
      setToPick(known ? known.address : r.data.to ? CUSTOM : (r.data.recipients[0]?.address ?? CUSTOM));
      setTo(known ? known.address : r.data.to || r.data.recipients[0]?.address || '');
      setSubject(r.data.subject);
      setBody(r.data.body);
    });
    return () => {
      live = false;
    };
  }, [recordId, moduleSlug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !pending && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const ccList = cc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const badCc = ccList.find((c) => !EMAIL.test(c));
  const blocked = defaults?.notes.find((n) => n.tone === 'block');
  const canSend = !!defaults && !blocked && !!from && EMAIL.test(to.trim()) && !badCc && subject.trim() && body.trim();
  const previewHref = `/proposals/preview/${recordId}?module=${encodeURIComponent(moduleSlug)}`;

  const send = () =>
    start(async () => {
      setError(null);
      const r = await sendProposalAction({ recordId, mailboxId: from, to: to.trim(), cc: ccList, subject: subject.trim(), body });
      if (!r.ok) return setError(r.message);
      onSent(`${r.data.label} sent to ${to.trim()}.`);
    });

  const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus-field';
  const label = 'mb-1 block text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400';

  // Rendered into <body>: the drawer animates with a transform, which would
  // otherwise contain this fixed overlay inside the panel.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={() => !pending && onClose()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids.subject}-title`}
        className="relative my-8 w-full max-w-[620px] animate-dialog-in overflow-hidden rounded-panel border border-line bg-white shadow-[0_24px_64px_-12px_rgba(14,28,52,.4)]"
      >
        <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Icon name="file-text" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`${ids.subject}-title`} className="text-[16px] font-semibold text-ink-900">
              Send proposal
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-500">
              An online proposal built from the record. The merchant opens it from the email and approves it with one click.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={pending}
            onClick={onClose}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-canvas hover:text-ink-900"
          >
            <Icon name="x" size={15} />
          </button>
        </header>

        {loadError ? (
          <p className="m-5 flex items-center gap-2 rounded-lg bg-bad-bg px-3 py-2.5 text-[13px] text-bad">
            <Icon name="alert-triangle" size={14} /> {loadError}
          </p>
        ) : !defaults ? (
          <div className="flex items-center justify-center gap-2 px-5 py-14 text-[13px] text-ink-400">
            <Spinner /> Preparing the proposal…
          </div>
        ) : (
          <div className="space-y-4 px-5 py-4">
            {/* The proposal itself: its headline figure and the preview. */}
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/60 px-3 py-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-md bg-[#102347] text-[#c8f169]">
                <Icon name="file-text" size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold text-ink-800">Proposal for {defaults.merchant}</p>
                <p className="text-[11.5px] text-ink-500">
                  Monthly savings <span className="font-semibold text-ink-800">{money(defaults.monthlySavings)}</span> · link valid{' '}
                  {defaults.expiryDays} days
                </p>
              </div>
              <a
                href={previewHref}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 hover:border-ink-400"
              >
                <Icon name="eye" size={13} /> Preview
              </a>
            </div>

            {defaults.notes.length ? (
              <ul className="space-y-1.5">
                {defaults.notes.map((n, i) => (
                  <li
                    key={i}
                    className={`flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px] leading-relaxed ${
                      n.tone === 'block' ? 'border border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]' : 'border border-line bg-canvas text-ink-600'
                    }`}
                  >
                    <Icon name={n.tone === 'block' ? 'alert-triangle' : 'info'} size={13} className="mt-[3px] shrink-0" />
                    <span className="min-w-0 flex-1">
                      {n.text}{' '}
                      {n.href ? (
                        <Link href={n.href} onClick={onClose} className="font-semibold underline underline-offset-2">
                          Go there
                        </Link>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {defaults.company && !defaults.company.ready ? (
              <p className="flex items-start gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#8a5a09]">
                <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" />
                <span>
                  Proposals go out from {defaults.company.address}, which has no working connection right now. Ask an admin to reconnect it in Email.
                </span>
              </p>
            ) : null}
            {defaults.from.length === 0 && !defaults.company ? (
              <p className="flex items-start gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-600">
                <Icon name="mail" size={14} className="mt-[2px] shrink-0 text-ink-400" />
                <span>
                  Proposals go out from your own Outlook mailbox, so they appear in the merchant’s email history. Connect your mailbox in{' '}
                  <Link href="/email" className="font-semibold text-brand-700 hover:underline">
                    Email
                  </Link>{' '}
                  first.
                </span>
              </p>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor={ids.from} className={label}>
                  From
                </label>
                {defaults.company ? (
                  <>
                    <input id={ids.from} value={defaults.company.address} readOnly className={`${field} cursor-default bg-canvas text-ink-700`} />
                    <p className="mt-1 text-[11.5px] text-ink-500">Company inbox, set by your admin</p>
                  </>
                ) : (
                  <select id={ids.from} value={from} onChange={(e) => setFrom(e.target.value)} disabled={!defaults.from.length} className={field}>
                    {defaults.from.map((f) => (
                      <option key={f.mailboxId} value={f.mailboxId}>
                        {f.displayName ? `${f.displayName} <${f.address}>` : f.address}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label htmlFor={ids.to} className={label}>
                  To
                </label>
                <select
                  id={ids.to}
                  value={toPick}
                  onChange={(e) => {
                    const v = e.target.value;
                    setToPick(v);
                    setTo(v === CUSTOM ? '' : v);
                  }}
                  className={field}
                >
                  {defaults.recipients.some((r) => r.kind === 'default') ? (
                    <optgroup label="Default">
                      {defaults.recipients
                        .filter((r) => r.kind === 'default')
                        .map((r) => (
                          <option key={r.address} value={r.address}>
                            {r.address} — {r.label}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                  {defaults.recipients.some((r) => r.kind === 'other') ? (
                    <optgroup label="Other emails on this record">
                      {defaults.recipients
                        .filter((r) => r.kind === 'other')
                        .map((r) => (
                          <option key={r.address} value={r.address}>
                            {r.address} — {r.label}
                          </option>
                        ))}
                    </optgroup>
                  ) : null}
                  <option value={CUSTOM}>Custom email…</option>
                </select>
                {toPick === CUSTOM ? (
                  <input
                    aria-label="Custom email address"
                    type="email"
                    autoFocus={!to}
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder="merchant@business.com"
                    className={`${field} mt-2 ${to && !EMAIL.test(to.trim()) ? 'border-bad' : ''}`}
                  />
                ) : null}
              </div>
            </div>
            <div>
              <label htmlFor={ids.cc} className={label}>
                CC <span className="font-normal normal-case tracking-normal text-ink-300">— optional, separate with commas</span>
              </label>
              <input id={ids.cc} value={cc} onChange={(e) => setCc(e.target.value)} className={`${field} ${badCc ? 'border-bad' : ''}`} />
              {badCc ? <p className="mt-1 text-[12px] text-bad">{badCc} is not a valid email address.</p> : null}
            </div>
            <div>
              <label htmlFor={ids.subject} className={label}>
                Subject
              </label>
              <input id={ids.subject} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={field} />
            </div>
            <div>
              <label htmlFor={ids.body} className={label}>
                Message
              </label>
              <textarea id={ids.body} value={body} onChange={(e) => setBody(e.target.value)} rows={9} maxLength={5000} className={`${field} resize-y leading-relaxed`} />
              <p className="mt-1 text-[11.5px] text-ink-400">
                <code className="rounded bg-canvas px-1 py-px text-[11px] text-ink-600">{'{{link}}'}</code> becomes a “View your proposal” button. Your Outlook
                signature is added below.
              </p>
            </div>

            {error ? (
              <p role="alert" className="flex items-center gap-2 rounded-lg bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
                <Icon name="alert-triangle" size={13} /> {error}
              </p>
            ) : null}
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-line-soft bg-canvas/40 px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" icon="send" onClick={send} disabled={!canSend} loading={pending} loadingLabel="Sending…">
            Send proposal
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
