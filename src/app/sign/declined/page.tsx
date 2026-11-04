/** Where SignWell sends a signer who declined (the document's decline_redirect_url). */
import type { Metadata } from 'next';
import { SignCard, Notice } from '../SignCard';

export const metadata: Metadata = { title: 'Agreement declined — Tenor Payments', robots: { index: false, follow: false } };

export default function DeclinedPage() {
  return (
    <SignCard>
      <Notice title="You declined the agreement" body="We’ve let our team know, and someone will be in touch. If you declined by mistake, just reply to our email and we’ll send a new one." />
    </SignCard>
  );
}
