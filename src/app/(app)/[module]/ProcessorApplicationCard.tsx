'use client';

/**
 * The merchant's application at the processor (Maverick Integration spec,
 * Sending applications): its status, Send to Maverick (first send) or Update
 * Maverick (later changes), and the pre-send check.
 *
 * Manual only: nothing is pushed by itself. Before anything goes, the check
 * lists every missing field and document at once, each a link to where it is
 * fixed. The check tab shows what will be sent, for people allowed to see it.
 */
import { useEffect, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, Spinner } from '@/proto/ui/kit';
import type { ProcessorApplicationView, ProcessorCheck } from '@/lib/processors/service';
import { processorPreCheckAction, sendToProcessorAction } from './processorActions';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function ProcessorApplicationCard({ moduleSlug, recordId, data }: { moduleSlug: string; recordId: string; data: ProcessorApplicationView }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<null | 'send' | 'check'>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const action = data.sent ? 'Update' : 'Send to';
  const canAct = data.sent ? data.canUpdate : data.canSend;

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(14,28,52,.05)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name="briefcase" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink-900">
            {data.label} application
            {data.status !== null || data.statusAt ? (
              <span className="rounded-full bg-brand-50 px-2 py-px text-[11.5px] font-semibold text-brand-700 ring-1 ring-brand-100">{data.status ?? 'No status yet'}</span>
            ) : null}
          </h3>
          <p className="text-[12px] text-ink-500">
            {data.sent
              ? `${data.lastAction === 'update' ? 'Last updated' : 'Sent'}${data.lastSentAt ? ` ${when(data.lastSentAt)}` : ''}${data.lastSentBy ? ` by ${data.lastSentBy}` : ''}. Later changes in the CRM go only when someone presses Update.`
              : `Not sent to ${data.label} yet. The application data and the Files tab documents go together.`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {data.canCheck ? (
            <button type="button" onClick={() => setDialog('check')} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] font-semibold text-ink-700 hover:bg-canvas">
              <Icon name="search" size={13} /> Pre-send check
            </button>
          ) : null}
          {canAct ? (
            <Button size="sm" variant="primary" icon={data.sent ? 'refresh-cw' : 'send'} onClick={() => setDialog('send')}>
              {action} {data.label}
            </Button>
          ) : null}
        </div>
      </header>
      {data.lastError ? (
        <p className="flex items-start gap-2 border-t border-bad/20 bg-bad-bg px-4 py-2.5 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
          <span>Last attempt failed: {data.lastError} The application in the CRM is unchanged. You can try again.</span>
        </p>
      ) : null}
      {!data.connected ? (
        <p className="flex items-start gap-2 border-t border-[#f7e0af] bg-[#fdf1d8] px-4 py-2.5 text-[12.5px] text-[#8a5a09]">
          <Icon name="info" size={13} className="mt-[2px] shrink-0" />
          {data.label} is not connected yet. A super admin enters the API key in CRM Settings › Integrations.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={`flex items-start gap-2 border-t px-4 py-2.5 text-[12.5px] ${notice.tone === 'ok' ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-bad/20 bg-bad-bg text-bad'}`}>
          <Icon name={notice.tone === 'ok' ? 'check' : 'alert-triangle'} size={13} className="mt-[2px] shrink-0" />
          {notice.text}
        </p>
      ) : null}
      {dialog ? (
        <CheckDialog
          moduleSlug={moduleSlug}
          recordId={recordId}
          label={data.label}
          mode={dialog}
          action={action}
          onClose={() => setDialog(null)}
          onDone={(n) => {
            setDialog(null);
            setNotice(n);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function CheckDialog({
  moduleSlug,
  recordId,
  label,
  mode,
  action,
  onClose,
  onDone,
}: {
  moduleSlug: string;
  recordId: string;
  label: string;
  mode: 'send' | 'check';
  action: string;
  onClose: () => void;
  onDone: (n: { tone: 'ok' | 'bad'; text: string }) => void;
}) {
  const [check, setCheck] = useState<ProcessorCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void processorPreCheckAction(recordId, mode === 'check').then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.message);
      setCheck(r.data);
    });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      live = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [recordId, mode, onClose]);

  const missingDocs = check?.documents.filter((d) => !d.ok) ?? [];
  const blocking = (check?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0) + missingDocs.length;
  const href = (tab: string | null, sub: string | null, field: string) =>
    `/${moduleSlug}?record=${recordId}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}${sub ? `&subtab=${encodeURIComponent(sub)}` : ''}&field=${encodeURIComponent(field)}`;
  const filesHref = `/${moduleSlug}?record=${recordId}&tab=files`;

  const send = () =>
    start(async () => {
      const r = await sendToProcessorAction(recordId);
      if (!r.ok) return setError(r.message);
      onDone({ tone: 'ok', text: r.data.action === 'create' ? `Sent to ${label}.` : `${label} updated.` });
    });

  // Opened by a click, so it only ever renders in the browser.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={() => !pending && onClose()} />
      <div role="dialog" aria-modal="true" aria-labelledby="processor-check-title" className="relative my-8 w-full max-w-[640px] animate-dialog-in overflow-hidden rounded-panel border border-line bg-white shadow-[0_24px_64px_-12px_rgba(14,28,52,.4)]">
        <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
          <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${check && blocking ? 'bg-bad-bg text-bad' : 'bg-brand-50 text-brand-700'}`}>
            <Icon name={check && blocking ? 'alert-triangle' : mode === 'check' ? 'search' : 'send'} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="processor-check-title" className="text-[16px] font-semibold text-ink-900">
              {!check ? 'Checking the record…' : blocking ? `Can’t send yet: ${blocking} item${blocking === 1 ? '' : 's'} missing` : mode === 'check' ? 'Ready to send' : `${action} ${label}?`}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-500">
              {blocking ? 'Each one links to where it is fixed. Nothing has been sent.' : mode === 'check' ? `What goes to ${label}: the data below and the documents in the Files tab.` : `The application data and documents go to ${label} now.`}
            </p>
          </div>
          <button type="button" aria-label="Close" disabled={pending} onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-canvas hover:text-ink-900">
            <Icon name="x" size={15} />
          </button>
        </header>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          {error ? <p role="alert" className="rounded-lg border border-bad/20 bg-bad-bg px-3 py-2 text-[12.5px] text-bad">{error}</p> : null}
          {!check && !error ? (
            <p className="flex items-center gap-2 text-[13px] text-ink-500">
              <Spinner /> Checking fields and documents…
            </p>
          ) : null}
          {check ? (
            <>
              {check.groups.map((g) => (
                <section key={`${g.tabKey}/${g.subtabKey}`}>
                  <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">
                    {g.tabLabel}
                    {g.subtabLabel ? ` › ${g.subtabLabel}` : ''}
                  </h3>
                  <ul className="space-y-1">
                    {g.items.map((it, i) => (
                      <li key={`${it.fieldKey}-${i}`}>
                        <Link href={href(g.tabKey, g.subtabKey, it.fieldKey)} onClick={onClose} className="group flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-[13px] hover:border-brand-300 hover:bg-brand-50">
                          <Icon name="arrow-right" size={13} className="mt-[3px] shrink-0 text-ink-400 group-hover:text-brand-700" />
                          <span>
                            <span className="font-semibold text-ink-900">{it.label}</span>
                            <span className="text-ink-500">: {it.message}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <section>
                <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Documents (Files tab)</h3>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {check.documents.map((d) => (
                    <li key={d.row}>
                      {d.ok ? (
                        <span className="flex items-center gap-2 rounded-lg border border-[#bfe6dd] bg-[#f3fbf9] px-3 py-2 text-[13px] text-ink-800">
                          <Icon name="check" size={13} className="text-[#0b6b5d]" /> {d.row}
                          <span className="ml-auto text-[11.5px] text-ink-400">{d.files} file{d.files === 1 ? '' : 's'}</span>
                        </span>
                      ) : (
                        <Link href={filesHref} onClick={onClose} className="flex items-center gap-2 rounded-lg border border-bad/30 bg-bad-bg px-3 py-2 text-[13px] text-bad hover:underline">
                          <Icon name="upload" size={13} /> {d.row}: upload it first
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
              {mode === 'check' && check.fields.length ? (
                <section>
                  <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Application data</h3>
                  <dl className="divide-y divide-line-faint overflow-hidden rounded-lg border border-line">
                    {check.fields.map((f) => (
                      <div key={f.key} className="grid gap-0.5 px-3 py-1.5 text-[12.5px] sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-3">
                        <dt className="text-ink-500">{f.label}</dt>
                        <dd className={f.value ? 'break-words text-ink-900' : 'text-ink-300'}>{f.value || 'Empty'}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {mode === 'check' ? 'Close' : 'Cancel'}
          </Button>
          {mode === 'send' ? (
            <Button variant="primary" icon="send" disabled={!check || blocking > 0 || pending} loading={pending} loadingLabel="Sending…" onClick={send}>
              {action} {label}
            </Button>
          ) : null}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
