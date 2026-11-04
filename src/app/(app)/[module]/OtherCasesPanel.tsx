'use client';

/**
 * Cases › Other cases (Maverick Integration spec): the processor's support
 * tickets for this merchant, read-only. Each one is synced one-to-one with a
 * regular case, either an open case already on the record or a new one (short
 * title and Issue as usual; Issue can't be edited once saved). Syncing places
 * the ticket's information in the case's thread and changes nothing at the
 * processor.
 */
import { useState, useTransition, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
import type { OtherCase, OtherCasesData } from '@/lib/processors/service';
import { openCaseForOtherCaseAction, syncOtherCaseAction } from './processorActions';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Cases | Other cases, above the Cases tab's own panel. */
export function CasesWithOther({ data, children, recordId }: { data: OtherCasesData; children: ReactNode; recordId: string }) {
  const [view, setView] = useState<'cases' | 'other'>('cases');
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Cases" className="inline-flex rounded-lg border border-line bg-canvas p-0.5">
        {(['cases', 'other'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={view === k}
            onClick={() => setView(k)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${view === k ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
          >
            {k === 'cases' ? 'Cases' : 'Other cases'}
            {k === 'other' && data.unsynced ? (
              <span className="rounded-full bg-[#fdf1d8] px-1.5 text-[11px] font-bold text-[#8a5a09] ring-1 ring-[#f7e0af]" title={`${data.unsynced} not synced with a case yet`}>
                {data.unsynced}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {view === 'cases' ? children : <OtherCasesList data={data} recordId={recordId} />}
    </div>
  );
}

function OtherCasesList({ data, recordId }: { data: OtherCasesData; recordId: string }) {
  const [syncing, setSyncing] = useState<OtherCase | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  return (
    <section className="space-y-3">
      <p className="flex items-start gap-2 text-[12.5px] text-ink-500">
        <Icon name="info" size={13} className="mt-[2px] shrink-0 text-ink-400" />
        Support tickets from the processor, read-only. {data.lastUpdated ? `Last updated ${when(data.lastUpdated)}.` : 'Not updated yet.'} Sync each one with a case to work it here.
      </p>
      {notice ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-[#bfe6dd] bg-[#e6f6f2] px-3 py-2 text-[12.5px] text-[#0b6b5d]">
          <Icon name="check" size={13} /> {notice}
        </p>
      ) : null}
      {data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-white px-4 py-8 text-center text-[13px] text-ink-500">No tickets from the processor for this merchant.</p>
      ) : (
        <ul className="space-y-2">
          {data.items.map((t) => (
            <li key={t.id} className="rounded-xl border border-line bg-white">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink-900">
                    {t.title}
                    {t.status ? <span className="rounded-full bg-canvas px-2 py-px text-[11px] font-semibold text-ink-600 ring-1 ring-line">{t.status}</span> : null}
                  </p>
                  <p className="text-[12px] text-ink-400">
                    Ticket {t.externalId}
                    {t.openedAt ? ` · opened ${when(t.openedAt)}` : ''}
                    {t.changedAt ? ` · changed ${when(t.changedAt)}` : ''}
                  </p>
                </div>
                {t.linkedCase ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#bfe6dd] bg-[#e6f6f2] px-2.5 py-1 text-[12px] font-semibold text-[#0b6b5d]">
                    <Icon name="link" size={12} /> Synced with case #{t.linkedCase.number}
                  </span>
                ) : data.canSync ? (
                  <Button size="sm" variant="primary" icon="link" onClick={() => setSyncing(t)}>
                    Sync with a case
                  </Button>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-lg bg-[#fdf1d8] px-2.5 py-1 text-[12px] font-semibold text-[#8a5a09]">Not synced</span>
                )}
              </div>
              {t.details.length ? (
                <details className="border-t border-line-soft">
                  <summary className="cursor-pointer px-4 py-2 text-[12.5px] font-medium text-ink-600">Ticket information</summary>
                  <dl className="grid gap-x-4 gap-y-1 px-4 pb-3 text-[12.5px] sm:grid-cols-[180px_minmax(0,1fr)]">
                    {t.details.map((d, i) => (
                      <div key={i} className="contents">
                        <dt className="text-ink-500">{d.label}</dt>
                        <dd className="whitespace-pre-wrap break-words text-ink-900">{d.value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {syncing ? (
        <SyncDialog
          ticket={syncing}
          openCases={data.openCases}
          onClose={() => setSyncing(null)}
          onDone={(text) => {
            setSyncing(null);
            setNotice(text);
            router.refresh();
          }}
          recordId={recordId}
        />
      ) : null}
    </section>
  );
}

function SyncDialog({ ticket, openCases, onClose, onDone }: { ticket: OtherCase; openCases: OtherCasesData['openCases']; onClose: () => void; onDone: (text: string) => void; recordId: string }) {
  const [mode, setMode] = useState<'existing' | 'new'>(openCases.length ? 'existing' : 'new');
  const [caseId, setCaseId] = useState(openCases[0]?.id ?? '');
  const [title, setTitle] = useState(ticket.title.slice(0, 200));
  const [issue, setIssue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  const submit = () =>
    start(async () => {
      setError(null);
      if (mode === 'existing') {
        const r = await syncOtherCaseAction(ticket.id, caseId);
        if (!r.ok) return setError(r.message);
        const c = openCases.find((x) => x.id === caseId);
        return onDone(`Ticket ${ticket.externalId} synced with case #${c?.number ?? ''}.`);
      }
      const r = await openCaseForOtherCaseAction({ ticketId: ticket.id, title, issue });
      if (!r.ok) return setError(r.message);
      onDone(`New case opened and synced with ticket ${ticket.externalId}.`);
    });

  // Opened by a click, so it only ever renders in the browser.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={() => !pending && onClose()} />
      <div role="dialog" aria-modal="true" aria-labelledby="sync-other-title" className="relative my-8 w-full max-w-[520px] animate-dialog-in overflow-hidden rounded-panel border border-line bg-white shadow-[0_24px_64px_-12px_rgba(14,28,52,.4)]">
        <header className="border-b border-line-soft px-5 py-4">
          <h2 id="sync-other-title" className="text-[16px] font-semibold text-ink-900">Sync ticket {ticket.externalId}</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">One ticket, one case. The ticket’s information goes into the case’s thread. Nothing changes at the processor.</p>
        </header>
        <div className="space-y-3 px-5 py-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {(['existing', 'new'] as const).map((m) => (
              <label key={m} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[13px] ${mode === m ? 'border-brand-500 bg-brand-50' : 'border-line'} ${m === 'existing' && !openCases.length ? 'pointer-events-none opacity-50' : ''}`}>
                <input type="radio" name="sync-mode" checked={mode === m} onChange={() => setMode(m)} disabled={m === 'existing' && !openCases.length} className="mt-[3px]" />
                <span>
                  <span className="block font-semibold text-ink-900">{m === 'existing' ? 'An open case' : 'A new case'}</span>
                  <span className="text-[12px] text-ink-500">{m === 'existing' ? (openCases.length ? 'Already on this record' : 'No open case to pick') : 'Write its title and Issue'}</span>
                </span>
              </label>
            ))}
          </div>
          {mode === 'existing' ? (
            <label className="block text-[12px] font-semibold uppercase tracking-[.05em] text-ink-400">
              Case
              <select value={caseId} onChange={(e) => setCaseId(e.target.value)} className={`mt-1 normal-case tracking-normal ${field}`}>
                {openCases.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.number} · {c.title}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label className="block text-[12px] font-semibold uppercase tracking-[.05em] text-ink-400">
                Short title
                <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className={`mt-1 normal-case tracking-normal ${field}`} />
              </label>
              <label className="block text-[12px] font-semibold uppercase tracking-[.05em] text-ink-400">
                Issue
                <textarea value={issue} rows={4} onChange={(e) => setIssue(e.target.value)} className={`mt-1 normal-case tracking-normal ${field}`} placeholder="Required. It can’t be edited once saved." />
              </label>
            </>
          )}
          {error ? <p role="alert" className="rounded-lg border border-bad/20 bg-bad-bg px-3 py-2 text-[12.5px] text-bad">{error}</p> : null}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="link"
            loading={pending}
            loadingLabel="Syncing…"
            disabled={pending || (mode === 'existing' ? !caseId : !title.trim() || !issue.trim())}
            onClick={submit}
          >
            {mode === 'existing' ? 'Sync' : 'Open case and sync'}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
