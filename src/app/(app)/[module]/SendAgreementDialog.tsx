'use client';

/**
 * Send Agreement (spec §5): the pre-send check first — every missing or
 * wrong value, grouped by tab and sub-tab, each a link that lands on the
 * field — and only when it passes, the confirmation: who signs, the
 * expiry, the email. Send runs the same check again on the server.
 */
import { useEffect, useId, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import type { PreSendResult } from '@/lib/agreements/service';
import { preSendCheckAction } from './agreementActions';

export function SendAgreementDialog({
  moduleSlug,
  recordId,
  kind,
  resendOf,
  onClose,
  onSent,
}: {
  moduleSlug: string;
  recordId: string;
  kind: string;
  /** Void & resend: the open agreement to cancel first. */
  resendOf: string | null;
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const [check, setCheck] = useState<PreSendResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ids = { subject: useId(), message: useId() };

  useEffect(() => {
    let live = true;
    void preSendCheckAction(recordId, kind).then((r) => {
      if (!live) return;
      if (!r.ok) return setLoadError(r.message);
      setCheck(r.data);
      setSubject(r.data.subject);
      setMessage(r.data.message);
    });
    return () => {
      live = false;
    };
  }, [recordId, kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !pending && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const problems = check?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0;
  // "Already out" is the one problem Void & resend removes itself.
  const blocking = check ? check.groups.flatMap((g) => g.items).filter((i) => !(resendOf && /already out/.test(i.message))).length : 0;
  const canSend = !!check && blocking === 0 && check.configured && check.templateReady && subject.trim() && message.trim();

  const send = () =>
    start(async () => {
      setError(null);
      const res = await fetch('/api/agreements/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(resendOf ? { resendOf, kind, subject: subject.trim(), message } : { recordId, kind, subject: subject.trim(), message }),
      });
      const r = (await res.json().catch(() => ({ ok: false, message: 'The agreement was not sent. Try again.' }))) as { ok: boolean; message?: string; data?: { label: string } };
      if (!r.ok) return setError(r.message ?? 'The agreement was not sent. Try again.');
      onSent(`${r.data?.label ?? 'Agreement'} sent for signature to ${check?.signers.map((s) => s.name).join(', ')}.`);
    });

  const href = (tabKey: string | null, subtabKey: string | null, fieldKey: string) =>
    `/${moduleSlug}?record=${recordId}${tabKey ? `&tab=${encodeURIComponent(tabKey)}` : ''}${subtabKey ? `&subtab=${encodeURIComponent(subtabKey)}` : ''}&field=${encodeURIComponent(fieldKey)}`;

  const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus-field';
  const label = 'mb-1 block text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400';

  // Rendered into <body>: the drawer animates with a transform, which would
  // otherwise contain this fixed overlay inside the panel. Opened by a click,
  // so it only ever renders in the browser.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={() => !pending && onClose()} />
      <div role="dialog" aria-modal="true" aria-labelledby={`${ids.subject}-title`} className="relative my-8 w-full max-w-[640px] animate-dialog-in overflow-hidden rounded-panel border border-line bg-white shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]">
        <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
          <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${check && blocking ? 'bg-bad-bg text-bad' : 'bg-brand-50 text-brand-700'}`}>
            <Icon name={check && blocking ? 'alert-triangle' : 'send'} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`${ids.subject}-title`} className="text-[16px] font-semibold text-ink-900">
              {!check ? (resendOf ? 'Void & resend' : 'Send agreement') : blocking ? `Can't send yet: ${blocking} item${blocking === 1 ? '' : 's'} need fixing` : resendOf ? 'Void & resend the agreement' : `Send ${check.kind.label}`}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-500">
              {!check
                ? 'Checking the record…'
                : blocking
                  ? 'Fix each item on the record, then open this again. Nothing has been sent.'
                  : resendOf
                    ? 'The open agreement is voided and a new one goes out, filled from the record as it is now.'
                    : 'Filled from this record and locked. Each principal signs in three places; the signed PDF comes back here.'}
            </p>
          </div>
          <button type="button" aria-label="Close" disabled={pending} onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-canvas hover:text-ink-900">
            <Icon name="x" size={15} />
          </button>
        </header>

        {loadError ? (
          <p className="m-5 flex items-center gap-2 rounded-lg bg-bad-bg px-3 py-2.5 text-[13px] text-bad">
            <Icon name="alert-triangle" size={14} /> {loadError}
          </p>
        ) : !check ? (
          <div className="flex items-center justify-center gap-2 px-5 py-14 text-[13px] text-ink-400">
            <Spinner /> Checking every required field…
          </div>
        ) : blocking ? (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
            {check.groups.map((g) => {
              const items = g.items.filter((i) => !(resendOf && /already out/.test(i.message)));
              if (!items.length) return null;
              return (
                <section key={`${g.tabKey}/${g.subtabKey}`}>
                  <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">
                    {g.tabLabel}
                    {g.subtabLabel ? ` › ${g.subtabLabel}` : ''}
                  </h3>
                  <ul className="divide-y divide-line-faint rounded-lg border border-line">
                    {items.map((i, n) => (
                      <li key={`${i.fieldKey}-${n}`}>
                        <Link href={href(i.tabKey, i.subtabKey, i.fieldKey)} onClick={onClose} className="group flex items-start gap-2.5 px-3 py-2 text-[13px] hover:bg-canvas">
                          <Icon name="alert-triangle" size={13} className="mt-[3px] shrink-0 text-bad" />
                          <span className="min-w-0 flex-1">
                            <span className="font-semibold text-ink-900">{i.label}</span>
                            <span className="text-ink-600"> — {i.message}</span>
                          </span>
                          <Icon name="arrow-right" size={13} className="mt-[3px] shrink-0 text-ink-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-700" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {problems !== blocking ? <p className="text-[12px] text-ink-400">The open agreement is voided when you resend; it is not listed above.</p> : null}
          </div>
        ) : (
          <div className="space-y-4 px-5 py-4">
            {!check.configured ? (
              <p className="flex items-start gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#8a5a09]">
                <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" /> The signing service is not connected yet, so nothing can be sent.
              </p>
            ) : null}
            {!check.templateReady ? (
              <p className="flex items-start gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#8a5a09]">
                <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" /> The agreement template is not installed, so nothing can be sent.
              </p>
            ) : null}
            {check.testMode ? (
              <p className="flex items-start gap-2 rounded-lg border border-line bg-canvas px-3 py-2 text-[12px] leading-relaxed text-ink-600">
                <Icon name="info" size={13} className="mt-[2px] shrink-0 text-ink-400" /> Test mode: the signing service watermarks the document and it is not legally binding.
              </p>
            ) : null}

            <div>
              <p className={label}>Who signs</p>
              <ul className="divide-y divide-line-faint rounded-lg border border-line">
                {check.signers.map((s) => (
                  <li key={s.slot} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-[13px]">
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-brand-50 text-[11px] font-bold text-brand-700">{s.slot}</span>
                    <span className="font-semibold text-ink-900">{s.name}</span>
                    {s.title ? <span className="text-ink-500">{s.title}</span> : null}
                    <span className="text-ink-500">{s.percentage}%</span>
                    <span className="ml-auto text-ink-600">{s.email}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11.5px] text-ink-400">Owners at 25% or more, then the next largest until at least 51% is listed. Each signs in three places and gets their own email.</p>
            </div>

            <p className="text-[12.5px] text-ink-600">
              <Icon name="clock" size={12} className="mr-1 inline text-ink-400" />
              Expires after {check.expiresDays} days. Reminders go out automatically to anyone who has not signed.
            </p>

            <div>
              <label htmlFor={ids.subject} className={label}>
                Email subject
              </label>
              <input id={ids.subject} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={field} />
            </div>
            <div>
              <label htmlFor={ids.message} className={label}>
                Email message
              </label>
              <textarea id={ids.message} value={message} onChange={(e) => setMessage(e.target.value)} rows={6} maxLength={5000} className={`${field} resize-y leading-relaxed`} />
              <p className="mt-1 text-[11.5px] text-ink-400">The signing service sends it under the name set in Presets, with the link to sign.</p>
            </div>
            {error ? (
              <p className="flex items-center gap-2 rounded-lg bg-bad-bg px-3 py-2.5 text-[13px] text-bad">
                <Icon name="alert-triangle" size={14} /> {error}
              </p>
            ) : null}
          </div>
        )}

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft bg-canvas/60 px-5 py-3">
          <button type="button" onClick={onClose} disabled={pending} className="rounded-lg px-3 py-2 text-[13px] font-semibold text-ink-600 hover:bg-canvas">
            {check && blocking ? 'Close' : 'Cancel'}
          </button>
          {check && !blocking ? (
            <button
              type="button"
              onClick={send}
              disabled={!canSend || pending}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] transition-colors hover:bg-accent-dim disabled:opacity-60"
            >
              {pending ? <Spinner /> : <Icon name="send" size={14} />}
              {pending ? 'Sending…' : resendOf ? 'Void & send the new one' : 'Send for signature'}
            </button>
          ) : null}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
