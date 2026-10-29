'use client';

/**
 * The review screen (spec): one row per difference — the question, the CRM's
 * current value, the merchant's answer — with Accept or Keep CRM value, plus
 * Accept all and Keep all. The PDF alongside when there is one. Nothing is
 * written until a person accepts it; every accept is in field history with
 * the application as its source.
 *
 * When the returned PDF had no readable fields, the same screen is where the
 * answers are entered by hand, next to the PDF.
 */
import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, StatusPill } from '@/proto/ui/kit';
import type { Swatch } from '@/proto/schema';
import type { ApplicationPageData, ReviewRow } from '@/lib/applications/service';
import type { Answers } from '@/lib/applications/catalog';
import { ApplicationForm } from '@/app/apply/ApplicationForm';
import { decideAction, enterByHandAction } from '../../[module]/applicationActions';
import { PdfViewer } from './PdfViewer';

const STATUS: Record<string, { label: string; swatch: Swatch }> = {
  sent: { label: 'Sent', swatch: 'blue' },
  opened: { label: 'Opened', swatch: 'indigo' },
  submitted: { label: 'Submitted online', swatch: 'teal' },
  pdf_uploaded: { label: 'PDF uploaded', swatch: 'teal' },
  reviewed: { label: 'Reviewed', swatch: 'green' },
  expired: { label: 'Expired', swatch: 'slate' },
  voided: { label: 'Voided', swatch: 'red' },
};
const VIA: Record<string, string> = { online: 'Online', pdf: 'PDF', manual: 'Entered from PDF' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export function ReviewScreen({ data }: { data: ApplicationPageData }) {
  const router = useRouter();
  const app = data.application!;
  const [picks, setPicks] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [showDecided, setShowDecided] = useState(false);

  const rows = useMemo(() => data.rows.filter((r) => !done.has(r.id)), [data.rows, done]);
  const acceptable = rows.filter((r) => r.canAccept && (!r.candidates || picks[r.id] !== undefined));
  const needsPick = rows.filter((r) => r.candidates && picks[r.id] === undefined);

  const apply = (items: { row: ReviewRow; decision: 'accept' | 'keep' }[]) =>
    start(async () => {
      setError(null);
      const res = await decideAction({
        applicationId: app.id,
        decisions: items.map(({ row, decision }) => ({ changeId: row.id, decision, ...(decision === 'accept' && row.candidates ? { pick: picks[row.id] } : {}) })),
      });
      if (!res.ok) return setError(res.message);
      setDone((d) => new Set([...d, ...items.map((i) => i.row.id)]));
      router.refresh();
    });

  const s = STATUS[app.status] ?? STATUS.sent!;
  const manual = data.manual;

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-line bg-white px-6 py-4">
        {data.recordHref ? (
          <Link href={data.recordHref} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-500 hover:text-ink-900">
            <Icon name="chevron-left" size={13} /> {data.recordName}
          </Link>
        ) : (
          <p className="text-[12.5px] text-ink-500">{data.recordName}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="font-mono text-[20px] font-semibold tracking-tight text-ink-900">{app.label}</h1>
          <StatusPill label={s.label} swatch={s.swatch} size="md" />
          <p className="text-[12.5px] text-ink-500">
            Sent to {app.recipient} · {when(app.sentAt)}
            {app.submittedAt ? ` · ${app.returnedVia === 'pdf' ? 'PDF returned' : 'Submitted'} ${when(app.submittedAt)}` : ''}
          </p>
        </div>
      </header>

      <div className={`grid min-h-0 flex-1 gap-5 p-6 ${data.file ? 'xl:grid-cols-[minmax(0,1fr)_minmax(380px,44%)]' : ''}`}>
        <div className="min-w-0 space-y-5">
          {manual ? (
            <ManualEntry applicationId={app.id} initial={manual.answers} ssnOnFile={manual.ssnOnFile} />
          ) : (
            <section className="overflow-hidden rounded-xl border border-line bg-white">
              <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-[14px] font-semibold text-ink-900">
                    {rows.length ? `${rows.length} answer${rows.length === 1 ? '' : 's'} to review` : 'Nothing left to review'}
                  </h2>
                  <p className="text-[12.5px] text-ink-500">
                    {rows.length
                      ? 'These differ from what the CRM holds. The CRM keeps its value until you accept the merchant’s.'
                      : app.status === 'reviewed'
                        ? 'Every returned answer is settled. The application is Reviewed.'
                        : app.status === 'sent' || app.status === 'opened'
                          ? 'The merchant has not returned the application yet.'
                          : 'Empty fields were filled in automatically; nothing differed.'}
                  </p>
                </div>
                {rows.length > 1 && data.canEdit ? (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => apply(rows.map((row) => ({ row, decision: 'keep' as const })))}>
                      Keep all
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      icon="check"
                      disabled={pending || !acceptable.length}
                      title={needsPick.length ? `${needsPick.length} row(s) need a value chosen first` : undefined}
                      onClick={() => apply(acceptable.map((row) => ({ row, decision: 'accept' as const })))}
                    >
                      Accept all{needsPick.length && acceptable.length ? ` ${acceptable.length}` : ''}
                    </Button>
                  </div>
                ) : null}
              </div>
              {error ? (
                <p role="alert" className="flex items-center gap-2 border-b border-bad/20 bg-bad-bg px-4 py-2 text-[12.5px] text-bad">
                  <Icon name="alert-triangle" size={13} /> {error}
                </p>
              ) : null}
              {rows.length ? (
                <div className="divide-y divide-line-faint">
                  <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-4 bg-canvas/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400 md:grid">
                    <span>Question</span>
                    <span>In the CRM now</span>
                    <span>Merchant answered</span>
                    <span className="w-[188px]" />
                  </div>
                  {rows.map((r) => (
                    <div key={r.id} className="grid gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                      <div className="min-w-0">
                        <p className="text-[13.5px] font-medium text-ink-900">{r.question}</p>
                        <p className="text-[11.5px] text-ink-400">{VIA[r.via]}</p>
                      </div>
                      <div className="min-w-0 text-[13px] text-ink-500">
                        <span className="text-[11px] font-semibold uppercase tracking-[.05em] text-ink-300 md:hidden">CRM · </span>
                        {r.crmDisplay ? <span className="break-words">{r.crmDisplay}</span> : <span className="italic text-ink-300">empty</span>}
                      </div>
                      <div className="min-w-0 text-[13px] font-medium text-ink-900">
                        <span className="text-[11px] font-semibold uppercase tracking-[.05em] text-ink-300 md:hidden">Merchant · </span>
                        <span className="break-words">{r.answerDisplay}</span>
                        {r.candidates ? (
                          <select
                            aria-label={`Choose the CRM value for ${r.question}`}
                            value={picks[r.id] ?? ''}
                            onChange={(e) => setPicks((p) => ({ ...p, [r.id]: Number(e.target.value) }))}
                            disabled={!r.canAccept || pending}
                            className="mt-1.5 block w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[12.5px] font-normal text-ink-800 outline-none focus-field"
                          >
                            <option value="" disabled>
                              Choose the CRM value…
                            </option>
                            {r.candidates.map((c, i) => (
                              <option key={i} value={i}>
                                {c.display}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
                      <div className="flex w-full gap-1.5 md:w-[188px] md:justify-end">
                        {data.canEdit ? (
                          <>
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => apply([{ row: r, decision: 'keep' }])}>
                              Keep CRM
                            </Button>
                            <Button
                              size="sm"
                              icon="check"
                              disabled={pending || !r.canAccept || (!!r.candidates && picks[r.id] === undefined)}
                              title={!r.canAccept ? 'You cannot edit this field' : undefined}
                              onClick={() => apply([{ row: r, decision: 'accept' }])}
                            >
                              Accept
                            </Button>
                          </>
                        ) : (
                          <span className="text-[12px] text-ink-400">View only</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          )}

          {data.decided.length ? (
            <section className="overflow-hidden rounded-xl border border-line bg-white">
              <button type="button" onClick={() => setShowDecided((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-canvas/50">
                <Icon name={showDecided ? 'chevron-down' : 'chevron-right'} size={14} className="text-ink-400" />
                <span className="flex-1 text-[13.5px] font-semibold text-ink-900">Already settled</span>
                <span className="text-[12px] text-ink-500">
                  {data.decided.filter((d) => d.status === 'applied').length} filled automatically · {data.decided.filter((d) => d.status === 'accepted').length} accepted ·{' '}
                  {data.decided.filter((d) => d.status === 'kept').length} kept
                </span>
              </button>
              {showDecided ? (
                <ul className="divide-y divide-line-faint border-t border-line-soft">
                  {data.decided.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 px-4 py-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate text-ink-800">{d.question}</span>
                      <span className="min-w-0 max-w-[40%] truncate text-ink-500">{d.answerDisplay}</span>
                      <span
                        className={`w-[118px] shrink-0 text-right text-[11.5px] font-semibold ${
                          d.status === 'kept' ? 'text-ink-400' : d.status === 'accepted' ? 'text-brand-700' : 'text-[#0b6b5d]'
                        }`}
                      >
                        {d.status === 'applied' ? 'Filled automatically' : d.status === 'accepted' ? 'Accepted' : 'Kept CRM value'}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>

        {data.file ? (
          <aside className="min-h-[520px] xl:sticky xl:top-6 xl:h-[calc(100dvh-160px)]">
            <PdfViewer fileId={data.file.id} name={data.file.name} />
          </aside>
        ) : app.files.length && !data.canOpenPdfs ? (
          <p className="flex items-center gap-2 text-[12.5px] text-ink-500 xl:col-start-2">
            <Icon name="lock" size={12} /> The returned PDF holds SSNs; your permissions do not include opening it.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ManualEntry({ applicationId, initial, ssnOnFile }: { applicationId: string; initial: Answers; ssnOnFile: Record<number, string> }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Answers>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-[#f7e0af] bg-[#fdf1d8] px-4 py-3 text-[13px] leading-relaxed text-[#8a5a09]">
        <Icon name="alert-triangle" size={15} className="mt-[2px] shrink-0" />
        <p>
          <strong className="font-semibold">This PDF has no readable fields</strong> — it was printed, scanned or “printed to PDF”. Type the merchant’s
          answers below while reading the PDF beside them. The form starts with what the CRM already holds; change only what differs. Empty CRM fields
          will fill and every difference will come to review, exactly as for a readable PDF.
        </p>
      </div>
      <ApplicationForm answers={answers} onChange={setAnswers} problems={{}} ssnOnFile={ssnOnFile} ssnEntered={{}} disabled={pending} />
      {error ? (
        <p role="alert" className="flex items-center gap-2 rounded-lg bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={13} /> {error}
        </p>
      ) : null}
      <div className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-white/95 py-3 backdrop-blur">
        <Button
          variant="primary"
          icon="check"
          loading={pending}
          loadingLabel="Saving…"
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await enterByHandAction({ applicationId, answers });
              if (!r.ok) return setError(r.message);
              router.refresh();
            })
          }
        >
          Save answers
        </Button>
      </div>
    </section>
  );
}
