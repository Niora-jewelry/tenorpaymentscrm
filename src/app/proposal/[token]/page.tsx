/**
 * /proposal/<token> — the merchant's proposal. No login; the token is the
 * access (see `proxy.ts`, `lib/proposals/merchant.ts`).
 *
 * Never indexed, never sends a referrer (the token is in this URL), never
 * cached: every load reads the proposal's current state.
 */
import type { Metadata } from 'next';
import { openProposal } from '@/lib/proposals/merchant';
import { TENOR_CONTACT } from '@/lib/proposals/content';
import { ProposalDocument } from '../ProposalDocument';
import { ApproveButton } from './ApproveButton';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your proposal — Tenor Payments',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function ProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await openProposal(token);

  if (p.state === 'open' || p.state === 'approved') {
    return <ProposalDocument content={p.content} label={p.label} closingAction={<ApproveButton token={token} approvedAt={p.approvedAt} />} />;
  }
  const words = {
    expired: ['This proposal has expired', 'Proposals are valid for a limited time. Please get in touch and we will send you an updated one.'],
    voided: ['This proposal was withdrawn', 'A newer proposal may be on its way to you. Please get in touch if you have any questions.'],
    not_found: ['This link is not valid', 'Please check you opened the full link from your email, or get in touch and we will send it again.'],
    busy: ['Please wait a moment', 'There have been too many attempts from your network. Try again in a few minutes.'],
  }[p.state];
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#e9edf3] p-5">
      <div className="w-full max-w-[460px] overflow-hidden rounded-2xl bg-white text-center shadow-[0_12px_32px_-12px_rgba(16,35,71,.25)]">
        <div className="px-8 pb-8 pt-10">
          {/* eslint-disable-next-line @next/next/no-img-element -- a static brand file */}
          <img src="/brand/tenor-logo-navy.png" alt="Tenor Payments" className="mx-auto h-[36px] w-auto" />
          <h1 className="mt-8 text-[19px] font-bold text-[#102347]">{words[0]}</h1>
          {'merchant' in p ? <p className="mt-1 text-[13px] font-semibold text-[#6b7a90]">{p.label} · {p.merchant}</p> : null}
          <p className="mt-3 text-[14px] leading-relaxed text-[#4a5568]">{words[1]}</p>
        </div>
        <p className="bg-[#102347] px-6 py-3.5 text-[13px] text-white/85">
          <a href={`mailto:${TENOR_CONTACT.salesEmail}`} className="font-bold text-[#c8f169] hover:underline">
            {TENOR_CONTACT.salesEmail}
          </a>
          <span className="mx-2 text-white/40">|</span>
          {TENOR_CONTACT.phone}
        </p>
      </div>
    </main>
  );
}
