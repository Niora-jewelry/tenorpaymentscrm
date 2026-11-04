/** Where SignWell sends a signer after they sign (the document's redirect_url). */
import type { Metadata } from 'next';
import { SignCard, Notice } from '../SignCard';

export const metadata: Metadata = { title: 'Thank you — Tenor Payments', robots: { index: false, follow: false } };

export default function SignedPage() {
  return (
    <SignCard>
      <Notice
        title="Thank you — you’ve signed"
        body="We’ve received your signature. Once everyone on the agreement has signed, we’ll email you a link to your signed copy. You can close this page."
      />
    </SignCard>
  );
}
