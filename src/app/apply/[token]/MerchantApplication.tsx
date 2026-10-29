'use client';

/**
 * The merchant's application (spec, Online path): prefilled answers they can
 * edit, saved as they type ("save and finish later"), checked before submit,
 * then a thank-you and a read-only link. "Upload your completed PDF" sits
 * beside it for anyone who chose the PDF.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { Answers } from '@/lib/applications/catalog';
import { problemsWith } from '@/lib/applications/validate';
import { ApplicationForm } from '../ApplicationForm';
import { LinkMessage } from './LinkMessage';
import { finishMerchantUploadAction, prepareMerchantUploadAction, saveAnswersAction, submitAnswersAction } from './actions';

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
  const [upload, setUpload] = useState<{ state: 'idle' | 'busy' | 'error'; message?: string }>({ state: 'idle' });
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(answers);
  const fileInput = useRef<HTMLInputElement>(null);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

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

  const submit = () =>
    startSubmit(async () => {
      setSubmitError(null);
      const found = problemsWith(answers, ssnOnFile);
      setProblems(found);
      if (Object.keys(found).length) {
        requestAnimationFrame(() => document.querySelector('[aria-invalid="true"], .border-bad')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      dirty.current = false;
      const r = await submitAnswersAction(token, answers);
      if (r.ok) return setDone('submitted');
      if ('problems' in r && r.problems) {
        setProblems(r.problems);
        return;
      }
      if ('state' in r && r.state) return setDone(r.state === 'open' ? null : r.state);
      setSubmitError(('message' in r && r.message) || 'Something went wrong. Your answers are kept — please try again.');
    });

  const uploadPdf = async (file: File) => {
    if (file.type && file.type !== 'application/pdf') return setUpload({ state: 'error', message: 'Choose a PDF file.' });
    if (file.size > 25 * 1024 * 1024) return setUpload({ state: 'error', message: 'The PDF must be under 25 MB.' });
    setUpload({ state: 'busy' });
    const slot = await prepareMerchantUploadAction(token);
    if (!slot.ok) {
      if (slot.state && slot.state !== 'busy' && slot.state !== 'open') return setDone(slot.state);
      return setUpload({ state: 'error', message: 'Please wait a moment and try again.' });
    }
    const put = await supabase.storage.from('application-pdfs').uploadToSignedUrl(slot.path, slot.token, file, { contentType: 'application/pdf' });
    if (put.error) return setUpload({ state: 'error', message: 'The upload failed. Please try again.' });
    const r = await finishMerchantUploadAction(token, slot.path, file.name);
    if (r.ok) return setDone('thanks_pdf');
    if ('state' in r && r.state && r.state !== 'busy' && r.state !== 'open') return setDone(r.state);
    setUpload({ state: 'error', message: ('message' in r && r.message) || 'The upload failed. Please try again.' });
  };

  if (done) return <LinkMessage state={done} label={label} merchant={merchant} />;

  const problemCount = Object.keys(problems).length;

  return (
    <div className="min-h-dvh bg-canvas">
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
            {save.state === 'saving' ? (
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

      <main className="mx-auto max-w-[880px] px-4 pb-32 pt-6 sm:px-6">
        <div className="mb-5 rounded-2xl border border-line bg-white p-5 sm:p-6">
          <h1 className="text-[21px] font-semibold tracking-tight text-ink-900">Your merchant application</h1>
          <p className="mt-1.5 max-w-[640px] text-[14px] leading-relaxed text-ink-600">
            We have filled in what we already know. Check each answer, complete the rest, and submit. Your answers save as you type — you can close
            this page and come back through the same link until <strong className="font-semibold text-ink-800">{fmtDate(expiresAt)}</strong>.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line bg-canvas/60 px-4 py-3">
            <Icon name="file-text" size={16} className="shrink-0 text-ink-400" />
            <p className="min-w-0 flex-1 text-[13px] text-ink-600">
              Filled in the PDF from your email instead? <span className="text-ink-500">Upload it here — no need to email it back.</span>
            </p>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={upload.state === 'busy'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-semibold text-ink-700 hover:border-ink-400 disabled:opacity-60"
            >
              {upload.state === 'busy' ? <Spinner /> : <Icon name="upload" size={13} />}
              {upload.state === 'busy' ? 'Uploading…' : 'Upload completed PDF'}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadPdf(f);
                e.target.value = '';
              }}
            />
            {upload.state === 'error' ? <p className="basis-full text-[12.5px] font-medium text-bad">{upload.message}</p> : null}
          </div>
        </div>

        <ApplicationForm answers={answers} onChange={onChange} problems={problems} ssnOnFile={ssnOnFile} ssnEntered={ssnEntered} disabled={submitting} />

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
            ) : (
              <span className="text-ink-500">Check your answers, then submit. You can’t change them afterwards.</span>
            )}
          </p>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] transition-colors hover:bg-accent-dim disabled:opacity-60"
          >
            {submitting ? <Spinner /> : <Icon name="check" size={15} />}
            {submitting ? 'Submitting…' : 'Submit application'}
          </button>
        </div>
      </div>
    </div>
  );
}
