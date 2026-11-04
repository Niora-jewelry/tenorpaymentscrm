/**
 * /sign/<token> — one signer's agreement, sent through Outlook from the inbox
 * Presets chose. No login; the token is the access (see `proxy.ts`,
 * `lib/agreements/signerPage.ts`).
 *
 * Opening the page records nothing: email scanners follow links. Only "Review
 * and sign" goes to SignWell, which records the view and the signature.
 *
 * Never indexed, never sends a referrer (the token is in this URL), never
 * cached: every load reads the agreement's current state.
 */
import type { Metadata } from 'next';
import { openSignerPage } from '@/lib/agreements/signerPage';
import { SignCard, Notice } from '../SignCard';
import { startSigningAction } from './actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your agreement — Tenor Payments',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

const longDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' });

export default async function SignPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ e?: string }> }) {
  const { token } = await params;
  const { e } = await searchParams;
  const page = await openSignerPage(token);

  if (!('label' in page)) {
    const [title, body] =
      page.state === 'busy'
        ? ['Please wait a moment', 'There have been too many attempts from your network. Try again in a few minutes.']
        : ['This link is not valid', 'Please check you opened the full link from your email, or get in touch and we will send it again.'];
    return (
      <SignCard>
        <Notice title={title} body={body} />
      </SignCard>
    );
  }

  const p = page;
  const sub = [p.what, p.merchant].filter(Boolean).join(' · ');
  if (p.state === 'open') {
    return (
      <SignCard contact={p.contact}>
        <div className="mt-8">
          <p className="text-center text-[12px] font-bold uppercase tracking-[0.08em] text-[#1b84c6]">Ready for your signature</p>
          <h1 className="mt-2 text-center text-[21px] font-bold leading-snug text-[#102347]">{p.what}</h1>
          {p.merchant ? <p className="mt-1 text-center text-[14px] font-semibold text-[#4a5568]">{p.merchant}</p> : null}
          <dl className="mt-6 divide-y divide-[#e6eaf0] rounded-xl border border-[#e6eaf0] text-[13.5px]">
            <div className="flex justify-between gap-4 px-4 py-2.5">
              <dt className="text-[#6b7a90]">Signer</dt>
              <dd className="text-right font-semibold text-[#102347]">{p.signer}</dd>
            </div>
            <div className="flex justify-between gap-4 px-4 py-2.5">
              <dt className="text-[#6b7a90]">Reference</dt>
              <dd className="text-right font-semibold text-[#102347]">{p.label}</dd>
            </div>
            <div className="flex justify-between gap-4 px-4 py-2.5">
              <dt className="text-[#6b7a90]">Sign by</dt>
              <dd className="text-right font-semibold text-[#102347]">{longDate(p.expiresAt)}</dd>
            </div>
          </dl>
          <p className="mt-5 text-[13.5px] leading-relaxed text-[#4a5568]">
            Every detail has been filled in from your application. You only need to sign and date where marked. Signing takes place on SignWell, our secure e-signature service.
          </p>
          {e ? (
            <p role="alert" className="mt-4 rounded-lg border border-[#f3c4c4] bg-[#fdeeee] px-3 py-2.5 text-[13px] text-[#9b1c1c]">
              The signing service could not be reached just now. Please try again in a minute.
            </p>
          ) : null}
          <form action={startSigningAction.bind(null, token)} className="mt-6">
            <button
              type="submit"
              className="w-full rounded-xl bg-[#102347] px-5 py-3.5 text-[15px] font-bold text-white transition hover:bg-[#1a3566] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#c8f169]"
            >
              Review and sign
            </button>
          </form>
          <p className="mt-3 text-center text-[12px] text-[#8a96a8]">This link is personal to you. Please don’t forward it.</p>
        </div>
      </SignCard>
    );
  }

  if (p.state === 'completed') {
    return (
      <SignCard contact={p.contact}>
        <Notice title="Everyone has signed" sub={sub} body="Thank you. The agreement is complete." />
      </SignCard>
    );
  }

  const words: Record<'signed' | 'declined' | 'expired' | 'voided', [string, string]> = {
    signed: ['You’ve signed — thank you', 'We’re waiting for the other signers. We’ll let you know once everyone has signed.'],
    declined: ['This agreement was declined', 'It can no longer be signed. Please get in touch if you have any questions.'],
    expired: ['This agreement has expired', 'Agreements can be signed for a limited time. Please get in touch and we will send you a new one.'],
    voided: ['This agreement was withdrawn', 'A newer version may be on its way to you. Please get in touch if you have any questions.'],
  };
  return (
    <SignCard contact={p.contact}>
      <Notice title={words[p.state][0]} sub={sub} body={words[p.state][1]} />
    </SignCard>
  );
}
