'use client';

/**
 * Send Application (spec, Sending the application): recipient (defaults to
 * Contact Email, editable), CC, subject and message from the editable
 * template. One email carries both ways back — the link and the prefilled PDF.
 *
 * The same dialog resends: same link, a freshly filled PDF.
 */
import { useEffect, useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { Button, Spinner } from '@/proto/ui/kit';
import type { SendDefaults } from '@/lib/applications/service';
import { resendApplicationAction, sendApplicationAction, sendDefaultsAction } from './applicationActions';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function SendApplicationDialog({
  recordId,
  resend,
  onClose,
  onSent,
}: {
  recordId: string;
  /** Resending an existing application: its id, label and last recipients. */
  resend?: { id: string; label: string; to: string; cc: string[] } | null;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [defaults, setDefaults] = useState<SendDefaults | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ids = { from: useId(), to: useId(), cc: useId(), subject: useId(), body: useId() };

  useEffect(() => {
    let live = true;
    void sendDefaultsAction(recordId).then((r) => {
      if (!live) return;
      if (!r.ok) return setLoadError(r.message);
      setDefaults(r.data);
      setFrom(r.data.from[0]?.mailboxId ?? '');
      setTo(resend?.to ?? r.data.to);
      setCc((resend?.cc ?? []).join(', '));
      setSubject(r.data.subject);
      setBody(r.data.body);
    });
    return () => {
      live = false;
    };
  }, [recordId, resend]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !pending && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const ccList = cc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const badCc = ccList.find((c) => !EMAIL.test(c));
  const canSend = !!defaults && defaults.templateReady && !!from && EMAIL.test(to.trim()) && !badCc && subject.trim() && body.trim();

  const send = () =>
    start(async () => {
      setError(null);
      const payload = { mailboxId: from, to: to.trim(), cc: ccList, subject: subject.trim(), body };
      const r = resend
        ? await resendApplicationAction({ ...payload, applicationId: resend.id })
        : await sendApplicationAction({ ...payload, recordId });
      if (!r.ok) return setError(r.message);
      onSent(resend ? `${resend.label} sent again to ${payload.to}.` : `${r.data?.label ?? 'Application'} sent to ${payload.to}.`);
    });

  const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus-field';
  const label = 'mb-1 block text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400';

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={() => !pending && onClose()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids.subject}-title`}
        className="relative my-8 w-full max-w-[620px] animate-dialog-in overflow-hidden rounded-panel border border-line bg-white shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]"
      >
        <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Icon name="send" size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`${ids.subject}-title`} className="text-[16px] font-semibold text-ink-900">
              {resend ? `Send ${resend.label} again` : 'Send application'}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-500">
              {resend
                ? 'The same link, with a PDF filled from the record as it is now. The link’s clock restarts.'
                : 'Prefilled with what the CRM knows. The merchant completes it online, or fills in the PDF and sends it back.'}
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
            <Spinner /> Preparing the application…
          </div>
        ) : (
          <div className="space-y-4 px-5 py-4">
            {!defaults.templateReady ? (
              <p className="flex items-start gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#8a5a09]">
                <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" />
                <span>
                  The application PDF (TapDash_Application_v2.pdf) is not installed yet, so nothing can be sent. Everything else here is ready.
                </span>
              </p>
            ) : null}
            {defaults.from.length === 0 ? (
              <p className="flex items-start gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-600">
                <Icon name="mail" size={14} className="mt-[2px] shrink-0 text-ink-400" />
                <span>
                  Applications go out from your own Outlook mailbox, so they appear in the merchant’s email history. Connect your mailbox in{' '}
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
                <select id={ids.from} value={from} onChange={(e) => setFrom(e.target.value)} disabled={!defaults.from.length} className={field}>
                  {defaults.from.map((f) => (
                    <option key={f.mailboxId} value={f.mailboxId}>
                      {f.displayName ? `${f.displayName} <${f.address}>` : f.address}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={ids.to} className={label}>
                  To
                </label>
                <input
                  id={ids.to}
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="merchant@business.com"
                  className={`${field} ${to && !EMAIL.test(to.trim()) ? 'border-bad' : ''}`}
                />
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
              <textarea
                id={ids.body}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={9}
                maxLength={5000}
                className={`${field} resize-y leading-relaxed`}
              />
              <p className="mt-1 text-[11.5px] text-ink-400">
                <code className="rounded bg-canvas px-1 py-px text-[11px] text-ink-600">{'{{link}}'}</code> becomes the merchant’s secure link. Your
                Outlook signature is added below.
              </p>
            </div>

            <div className="flex items-center gap-3 rounded-lg border border-line-soft bg-canvas/60 px-3 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-white text-[#b02a30] ring-1 ring-line">
                <Icon name="file-text" size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink-800">{defaults.fileName}</p>
                <p className="text-[11.5px] text-ink-400">
                  Prefilled, still editable · never includes an SSN or Private details · link valid {defaults.expiryDays} days
                </p>
              </div>
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
            {resend ? 'Send again' : 'Send application'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
