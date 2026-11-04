/**
 * The frame every signer page shares: Tenor's mark, one card, the contact bar.
 * Mobile first — most signers open the link on a phone.
 */
import type { ReactNode } from 'react';
import { TENOR_CONTACT } from '@/lib/proposals/content';

export function SignCard({ children, contact }: { children: ReactNode; contact?: string | null }) {
  const email = contact || TENOR_CONTACT.salesEmail;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#e9edf3] p-4 sm:p-6">
      <div className="w-full max-w-[480px] overflow-hidden rounded-2xl bg-white shadow-[0_12px_32px_-12px_rgba(16,35,71,.25)]">
        <div className="px-6 pb-8 pt-9 sm:px-9">
          {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file */}
          <img src="/brand/tenor-logo-navy.png" alt="Tenor Payments" className="mx-auto h-[34px] w-auto" />
          {children}
        </div>
        <p className="bg-[#102347] px-6 py-3.5 text-center text-[13px] text-white/85">
          Questions?{' '}
          <a href={`mailto:${email}`} className="font-bold text-[#c8f169] hover:underline">
            {email}
          </a>
          <span className="mx-2 text-white/40">|</span>
          {TENOR_CONTACT.phone}
        </p>
      </div>
    </main>
  );
}

export function Notice({ title, body, sub }: { title: string; body: string; sub?: string }) {
  return (
    <div className="text-center">
      <h1 className="mt-8 text-[19px] font-bold text-[#102347]">{title}</h1>
      {sub ? <p className="mt-1 text-[13px] font-semibold text-[#6b7a90]">{sub}</p> : null}
      <p className="mt-3 text-[14px] leading-relaxed text-[#4a5568]">{body}</p>
    </div>
  );
}
