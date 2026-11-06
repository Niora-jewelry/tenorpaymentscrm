'use client';

/**
 * The merchant's online form, page by page, with every answer locked: what they
 * will see, and nothing here can be changed or saved.
 */
import { useState } from 'react';
import Link from 'next/link';
import { Icon } from '@/proto/ui/icons';
import { SECTIONS, type Answers } from '@/lib/applications/catalog';
import { ApplicationForm } from '@/app/apply/ApplicationForm';

export function ApplicationPreview({
  merchant,
  answers,
  ssnOnFile,
  backHref,
}: {
  merchant: string;
  answers: Answers;
  ssnOnFile: Record<number, string>;
  backHref: string;
}) {
  const [step, setStep] = useState(0);
  const section = SECTIONS[step]!;
  const go = (i: number) => {
    setStep(i);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-white">
        <div className="mx-auto flex max-w-[880px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <span className="rounded-full bg-[#fdf1d8] px-2.5 py-0.5 text-[11.5px] font-bold text-[#8a5a09] ring-1 ring-[#f7e0af]">Preview</span>
          <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink-900">{merchant}</p>
          <Link href={backHref} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline">
            <Icon name="chevron-left" size={13} /> Back to the record
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-[880px] px-4 pb-28 pt-6 sm:px-6">
        <ol className="mb-5 grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="Pages">
          {SECTIONS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => go(i)}
                aria-current={i === step ? 'step' : undefined}
                className={`w-full cursor-pointer rounded-lg border px-2 py-2 text-left transition-colors ${
                  i === step ? 'border-brand-600 bg-white' : 'border-transparent hover:bg-white'
                }`}
              >
                <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-400">Page {i + 1}</span>
                <span className={`mt-1 block truncate text-[12.5px] font-medium ${i === step ? 'text-ink-900' : 'text-ink-600'}`}>{s.title}</span>
              </button>
            </li>
          ))}
        </ol>

        <ApplicationForm only={section.id} answers={answers} onChange={() => {}} problems={{}} ssnOnFile={ssnOnFile} ssnEntered={{}} disabled />
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white">
        <div className="mx-auto flex max-w-[880px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <p className="text-[12.5px] text-ink-500">
            Page {step + 1} of {SECTIONS.length}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={step === 0}
              onClick={() => go(step - 1)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-white px-3.5 py-2 text-[13px] font-semibold text-ink-700 hover:border-ink-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="chevron-left" size={13} /> Back
            </button>
            <button
              type="button"
              disabled={step === SECTIONS.length - 1}
              onClick={() => go(step + 1)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-white px-3.5 py-2 text-[13px] font-semibold text-ink-700 hover:border-ink-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next page <Icon name="chevron-right" size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
