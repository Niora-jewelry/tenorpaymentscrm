'use client';

/**
 * The merchant's application (spec, Online path): prefilled answers they can
 * edit, saved as they type ("save and finish later"), checked before submit,
 * then a thank-you and a read-only link. It opens on a choice between that
 * and uploading a completed PDF (`ChooseMethod`); a merchant who has already
 * saved answers here goes straight back to them.
 *
 * The form is one section per page — "Next page instead of one long app"
 * (the client, 30 Oct 2026). Next checks only that page; Submit, on the last
 * page, checks everything and names the page a problem is on.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { SECTIONS, type Answers } from '@/lib/applications/catalog';
import { problemsInSection, problemsWith } from '@/lib/applications/validate';
import { ApplicationForm } from '../ApplicationForm';
import { ChooseMethod } from './ChooseMethod';
import { LinkMessage } from './LinkMessage';
import { saveAnswersAction, submitAnswersAction } from './actions';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function MerchantApplication({
  token,
  label,
  merchant,
  expiresAt,
  initial,
  ssnOnFile,
  ssnEntered,
  savedAt: initialSavedAt,
}: {
  token: string;
  label: string;
  merchant: string;
  expiresAt: string;
  initial: Answers;
  ssnOnFile: Record<number, string>;
  ssnEntered: Record<number, string>;
  savedAt: string | null;
}) {
  const [answers, setAnswers] = useState<Answers>(initial);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [save, setSave] = useState<{ state: 'idle' | 'saving' | 'saved' | 'error'; at: string | null }>({ state: initialSavedAt ? 'saved' : 'idle', at: initialSavedAt });
  const [done, setDone] = useState<null | 'submitted' | 'thanks_pdf' | 'expired' | 'voided' | 'not_found' | 'busy'>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  // Online once they have saved answers here; otherwise they choose first.
  const [mode, setMode] = useState<'choose' | 'online'>(initialSavedAt ? 'online' : 'choose');
  const [step, setStep] = useState(0);
  const section = SECTIONS[step]!;
  const last = step === SECTIONS.length - 1;
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(answers);

  const flush = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    setSave((s) => ({ ...s, state: 'saving' }));
    const r = await saveAnswersAction(token, latest.current);
    if (r.ok) setSave({ state: 'saved', at: r.savedAt });
    else if (r.state && r.state !== 'busy') setDone(r.state === 'open' ? null : r.state);
    else setSave((s) => ({ ...s, state: 'error' }));
  }, [token]);

  const onChange = (next: Answers) => {
    setAnswers(next);
    latest.current = next;
    dirty.current = true;
    if (Object.keys(problems).length) setProblems(problemsWith(next, ssnOnFile));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 1200);
  };

  // Leaving with unsaved typing: save on the way out, and warn if it cannot.
  useEffect(() => {
    const away = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        void flush();
        e.preventDefault();
      }
    };
    document.addEventListener('visibilitychange', away);
    window.addEventListener('beforeunload', before);
    return () => {
      document.removeEventListener('visibilitychange', away);
      window.removeEventListener('beforeunload', before);
    };
  }, [flush]);

  const scrollToFirstProblem = () =>
    requestAnimationFrame(() => document.querySelector('[aria-invalid="true"], .border-bad')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));

  // Next checks this page only; a problem on an earlier page waits for Submit.
  const next = () => {
    const found = problemsInSection(problemsWith(answers, ssnOnFile), section.id);
    setProblems(found);
    if (Object.keys(found).length) return scrollToFirstProblem();
    setStep((s) => Math.min(s + 1, SECTIONS.length - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const goTo = (i: number) => {
    setStep(i);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = () =>
    startSubmit(async () => {
      setSubmitError(null);
      const found = problemsWith(answers, ssnOnFile);
      setProblems(found);
      if (Object.keys(found).length) {
        // Land on the first page that has a problem, then on the field.
        const firstBad = SECTIONS.findIndex((s) => Object.keys(problemsInSection(found, s.id)).length > 0);
        if (firstBad >= 0 && firstBad !== step) setStep(firstBad);
        scrollToFirstProblem();
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      dirty.current = false;
      const r = await submitAnswersAction(token, answers);
      if (r.ok) return setDone('submitted');
      if ('problems' in r && r.problems) {
        setProblems(r.problems);
        const firstBad = SECTIONS.findIndex((s) => Object.keys(problemsInSection(r.problems!, s.id)).length > 0);
        if (firstBad >= 0) setStep(firstBad);
        scrollToFirstProblem();
        return;
      }
      if ('state' in r && r.state) return setDone(r.state === 'open' ? null : r.state);
      setSubmitError(('message' in r && r.message) || 'Something went wrong. Your answers are kept — please try again.');
    });

  if (done) return <LinkMessage state={done} label={label} merchant={merchant} />;

  const problemCount = Object.keys(problems).length;
  const online = mode === 'online';
  const show = (next: 'choose' | 'online') => {
    if (next === 'choose') void flush();
    setMode(next);
    window.scrollTo({ top: 0 });
  };

  const header = (
    <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur supports-[backdrop-filter]:bg-white/75">
      <div className="mx-auto flex max-w-[880px] items-center gap-3 px-4 py-3 sm:px-6">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-950 text-white">
          <Icon name="file-pen" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold text-ink-900">{merchant}</p>
          <p className="text-[12px] text-ink-500">
            Merchant application · <span className="font-mono">{label}</span>
          </p>
        </div>
        <p className="hidden items-center gap-1.5 text-[12px] text-ink-500 sm:flex" aria-live="polite">
          {!online ? (
            <>
              <Icon name="lock" size={12} /> Secure link
            </>
          ) : save.state === 'saving' ? (
            <>
              <Spinner /> Saving…
            </>
          ) : save.state === 'error' ? (
            <span className="text-bad">Not saved — check your connection</span>
          ) : save.at ? (
            <>
              <Icon name="check" size={13} className="text-[#0b6b5d]" /> Saved {fmtTime(save.at)}
            </>
          ) : (
            <>
              <Icon name="lock" size={12} /> Secure link
            </>
          )}
        </p>
      </div>
    </header>
  );

  if (!online) {
    return (
      <div className="min-h-dvh bg-canvas">
        {header}
        <ChooseMethod token={token} merchant={merchant} expiresAt={expiresAt} onOnline={() => show('online')} onClosed={setDone} />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas">
      {header}

      <main className="mx-auto max-w-[880px] px-4 pb-32 pt-6 sm:px-6">
        <div className="mb-5 rounded-2xl border border-line bg-white p-5 sm:p-6">
          <h1 className="text-[21px] font-semibold tracking-tight text-ink-900">Your merchant application</h1>
          <p className="mt-1.5 max-w-[640px] text-[14px] leading-relaxed text-ink-600">
            We have filled in what we already know. Check each answer, complete the rest, and submit. Your answers save as you type — you can close
            this page and come back through the same link until <strong className="font-semibold text-ink-800">{fmtDate(expiresAt)}</strong>.
          </p>
          <p className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line-soft pt-3.5 text-[13px] text-ink-500">
            <Icon name="file-text" size={14} className="shrink-0 text-ink-400" />
            Rather send the PDF?
            <button
              type="button"
              onClick={() => show('choose')}
              disabled={submitting}
              className="font-semibold text-brand-700 underline decoration-brand-200 underline-offset-2 hover:decoration-brand-700 disabled:opacity-60"
            >
              Upload or download it
            </button>
          </p>
        </div>

        <ol className="mb-5 grid grid-cols-4 gap-1.5" aria-label="Pages">
          {SECTIONS.map((s, i) => {
            const done = i < step;
            const here = i === step;
            const bad = Object.keys(problemsInSection(problems, s.id)).length > 0;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  aria-current={here ? 'step' : undefined}
                  disabled={submitting}
                  className={`group/step w-full rounded-lg border px-2 py-2 text-left transition-colors ${
                    here ? 'border-brand-600 bg-white' : bad ? 'border-bad/40 bg-white hover:border-bad' : done ? 'border-line bg-white hover:border-ink-300' : 'border-transparent bg-transparent hover:bg-white'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">
                    <span
                      className={`grid size-4 place-items-center rounded-full text-[10px] ${
                        bad ? 'bg-bad text-white' : done ? 'bg-[#0b6b5d] text-white' : here ? 'bg-brand-600 text-white' : 'bg-line text-ink-500'
                      }`}
                    >
                      {bad ? '!' : done ? <Icon name="check" size={9} strokeWidth={3} /> : i + 1}
                    </span>
                    Page {i + 1}
                  </span>
                  <span className={`mt-1 block truncate text-[12.5px] font-medium ${here ? 'text-ink-900' : 'text-ink-600'}`}>{s.title}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <ApplicationForm only={section.id} answers={answers} onChange={onChange} problems={problems} ssnOnFile={ssnOnFile} ssnEntered={ssnEntered} disabled={submitting} />

        <p className="mt-6 flex items-start gap-2 text-[12px] leading-relaxed text-ink-400">
          <Icon name="lock" size={12} className="mt-[2px] shrink-0" />
          Sent over an encrypted connection. Social Security numbers are never shown back on this page and are stored encrypted until you submit.
        </p>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[880px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <p className="min-w-0 flex-1 text-[12.5px]" aria-live="polite">
            {submitError ? (
              <span className="font-medium text-bad">{submitError}</span>
            ) : problemCount ? (
              <span className="font-medium text-bad">
                {problemCount} answer{problemCount === 1 ? ' needs' : 's need'} attention before you can submit.
              </span>
            ) : last ? (
              <span className="text-ink-500">Check your answers, then submit. You can’t change them afterwards.</span>
            ) : (
              <span className="text-ink-500">
                Page {step + 1} of {SECTIONS.length} · {section.title}
              </span>
            )}
          </p>
          {step > 0 ? (
            <button
              type="button"
              onClick={() => goTo(step - 1)}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-4 py-2.5 text-[14px] font-semibold text-ink-700 hover:border-ink-400 disabled:opacity-60"
            >
              <Icon name="chevron-left" size={14} /> Back
            </button>
          ) : null}
          {last ? (
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] transition-colors hover:bg-accent-dim disabled:opacity-60"
            >
              {submitting ? <Spinner /> : <Icon name="check" size={15} />}
              {submitting ? 'Submitting…' : 'Submit application'}
            </button>
          ) : (
            <button
              type="button"
              onClick={next}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] transition-colors hover:bg-accent-dim disabled:opacity-60"
            >
              Next page <Icon name="chevron-right" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
