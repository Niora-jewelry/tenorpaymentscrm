'use client';

/**
 * The first thing the merchant sees on their link: two ways to apply, side by
 * side, each in a sentence they can act on. Online opens the prefilled form;
 * PDF takes the file they filled in (from our email, or downloaded here) and
 * closes the link. A merchant who has already saved answers online skips
 * this and lands back in the form (`MerchantApplication`).
 */
import { useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { downloadPdfAction, finishMerchantUploadAction, prepareMerchantUploadAction } from './actions';

type Closed = 'thanks_pdf' | 'submitted' | 'expired' | 'voided' | 'not_found' | 'busy';

const MAX_BYTES = 25 * 1024 * 1024;

function Point({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13.5px] leading-snug text-ink-700">
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700">
        <Icon name={icon} size={11} strokeWidth={2.25} />
      </span>
      {children}
    </li>
  );
}

export function ChooseMethod({
  token,
  merchant,
  expiresAt,
  onOnline,
  onClosed,
}: {
  token: string;
  merchant: string;
  expiresAt: string;
  onOnline: () => void;
  onClosed: (state: Closed) => void;
}) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [upload, setUpload] = useState<{ state: 'idle' | 'busy' | 'error'; name?: string; message?: string }>({ state: 'idle' });
  const [download, setDownload] = useState<{ state: 'idle' | 'busy' | 'error'; message?: string }>({ state: 'idle' });
  const busy = upload.state === 'busy';

  const uploadPdf = async (file: File) => {
    const isPdf = file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name));
    if (!isPdf) return setUpload({ state: 'error', message: 'That file is not a PDF. Choose the completed application PDF.' });
    if (file.size > MAX_BYTES) return setUpload({ state: 'error', message: 'The PDF must be under 25 MB.' });
    setUpload({ state: 'busy', name: file.name });
    const slot = await prepareMerchantUploadAction(token);
    if (!slot.ok) {
      if (slot.state && slot.state !== 'busy' && slot.state !== 'open') return onClosed(slot.state);
      return setUpload({ state: 'error', message: 'Please wait a moment and try again.' });
    }
    const put = await supabase.storage.from('application-pdfs').uploadToSignedUrl(slot.path, slot.token, file, { contentType: 'application/pdf' });
    if (put.error) return setUpload({ state: 'error', message: 'The upload did not go through. Check your connection and try again.' });
    const r = await finishMerchantUploadAction(token, slot.path, file.name);
    if (r.ok) return onClosed('thanks_pdf');
    if ('state' in r && r.state && r.state !== 'busy' && r.state !== 'open') return onClosed(r.state);
    setUpload({ state: 'error', message: ('message' in r && r.message) || 'The upload did not go through. Please try again.' });
  };

  const downloadPdf = async () => {
    setDownload({ state: 'busy' });
    const r = await downloadPdfAction(token);
    if (!r.ok) {
      if ('state' in r && r.state && r.state !== 'busy' && r.state !== 'open') return onClosed(r.state);
      return setDownload({ state: 'error', message: ('message' in r && r.message) || 'Please wait a moment and try again.' });
    }
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = r.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setDownload({ state: 'idle' });
  };

  const until = new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <main className="mx-auto max-w-[880px] px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
      <div className="max-w-[620px]">
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-brand-700">Merchant application</p>
        <h1 className="mt-2 text-[26px] font-semibold leading-tight tracking-tight text-ink-900 sm:text-[30px]">How would you like to apply?</h1>
        <p className="mt-2.5 text-[15px] leading-relaxed text-ink-600">
          Two ways to send us the same application for <span className="font-semibold text-ink-800">{merchant}</span>. Pick whichever is easier for you.
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2 md:gap-5">
        {/* Online — the recommended route, and the screen's one accent. */}
        <section
          aria-labelledby="way-online"
          className="relative flex flex-col rounded-2xl border border-brand-200 bg-white p-6 shadow-[0_1px_2px_rgba(8,32,47,.04),0_16px_40px_-24px_rgba(1,39,64,.35)] sm:p-7"
        >
          <div className="flex items-start justify-between gap-3">
            <span className="grid size-11 place-items-center rounded-xl bg-brand-950 text-white">
              <Icon name="file-pen" size={19} />
            </span>
            <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11.5px] font-semibold text-brand-700">Recommended</span>
          </div>
          <h2 id="way-online" className="mt-5 text-[18px] font-semibold tracking-tight text-ink-900">
            Fill it in online
          </h2>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-600">
            Answer the questions here in your browser. We have already filled in what we know, so you only check it and add the rest.
          </p>
          <ul className="mt-5 space-y-2.5">
            <Point icon="check">Most answers already filled in for you</Point>
            <Point icon="clock">Saves as you go — stop and come back any time</Point>
            <Point icon="phone">Works on your phone or computer</Point>
          </ul>
          <div className="mt-auto pt-7">
            <button
              type="button"
              onClick={onOnline}
              disabled={busy}
              className="group/btn inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-[14.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] transition-colors hover:bg-accent-dim disabled:opacity-60"
            >
              Start online
              <Icon name="arrow-right" size={15} className="transition-transform group-hover/btn:translate-x-0.5" />
            </button>
          </div>
        </section>

        {/* PDF — the file they filled in, dropped or chosen. */}
        <section
          aria-labelledby="way-pdf"
          onDragOver={(e) => {
            if (busy) return;
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !busy) void uploadPdf(f);
          }}
          className={`relative flex flex-col rounded-2xl border bg-white p-6 transition-[border-color,box-shadow] sm:p-7 ${
            drag ? 'border-brand-600 shadow-[0_0_0_4px_rgba(37,99,235,.12)]' : 'border-line shadow-[0_1px_2px_rgba(8,32,47,.04)]'
          }`}
        >
          <span className="grid size-11 place-items-center rounded-xl border border-line bg-canvas text-ink-700">
            <Icon name="file-text" size={19} />
          </span>
          <h2 id="way-pdf" className="mt-5 text-[18px] font-semibold tracking-tight text-ink-900">
            Upload a completed PDF
          </h2>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink-600">
            Already filled in the PDF from our email? Upload it here and you are done — no need to email it back.
          </p>

          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            aria-describedby="pdf-hint"
            className={`mt-5 flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border-[1.5px] border-dashed px-4 py-6 text-center transition-colors disabled:cursor-progress ${
              drag ? 'border-brand-600 bg-brand-50' : upload.state === 'error' ? 'border-bad/50 bg-white hover:bg-canvas' : 'border-line bg-canvas/60 hover:border-ink-300 hover:bg-canvas'
            }`}
          >
            {busy ? (
              <>
                <Spinner />
                <span className="mt-1 text-[13.5px] font-semibold text-ink-800">Uploading…</span>
                <span className="max-w-full truncate text-[12px] text-ink-500">{upload.name} · keep this page open</span>
              </>
            ) : (
              <>
                <span className="grid size-8 place-items-center rounded-full bg-white text-ink-600 shadow-[0_1px_2px_rgba(8,32,47,.08)]">
                  <Icon name="upload" size={14} />
                </span>
                <span className="mt-1 text-[13.5px] font-semibold text-ink-800">
                  {drag ? (
                    'Drop to upload'
                  ) : (
                    <>
                      {/* Phones cannot drag a file, so they are only asked to choose one. */}
                      <span className="[@media(hover:none)]:hidden">Drop your PDF here or </span>
                      <span className="text-brand-700 underline decoration-brand-200 underline-offset-2">
                        <span className="[@media(hover:none)]:hidden">choose a file</span>
                        <span className="hidden [@media(hover:none)]:inline">Choose your PDF file</span>
                      </span>
                    </>
                  )}
                </span>
                <span id="pdf-hint" className="text-[12px] text-ink-500">
                  PDF only · up to 25 MB
                </span>
              </>
            )}
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
          {upload.state === 'error' ? (
            <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-[12.5px] font-medium text-bad">
              <Icon name="alert-triangle" size={13} className="mt-px shrink-0" /> {upload.message}
            </p>
          ) : null}

          <div className="mt-auto pt-6">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line-soft pt-4">
              <p className="text-[13px] text-ink-500">Don’t have the PDF?</p>
              <button
                type="button"
                onClick={() => void downloadPdf()}
                disabled={download.state === 'busy' || busy}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-semibold text-brand-700 transition-colors hover:bg-brand-50 disabled:opacity-60"
              >
                {download.state === 'busy' ? <Spinner /> : <Icon name="download" size={13} />}
                {download.state === 'busy' ? 'Preparing…' : 'Download it, prefilled'}
              </button>
            </div>
            {download.state === 'error' ? <p className="mt-1.5 text-[12.5px] font-medium text-bad">{download.message}</p> : null}
          </div>
        </section>
      </div>

      <p className="mt-8 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-500">
        <Icon name="lock" size={12} className="mt-[3px] shrink-0" />
        <span>
          This link is private to your business and stays open until <strong className="font-semibold text-ink-700">{until}</strong>. Once you submit or
          upload, it closes.
        </span>
      </p>
    </main>
  );
}
