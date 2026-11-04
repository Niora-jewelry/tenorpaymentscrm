/** A signing link that is not a link at all. */
import type { Metadata } from 'next';
import { SignCard, Notice } from '../SignCard';

export const metadata: Metadata = { title: 'Link not valid — Tenor Payments', robots: { index: false, follow: false } };

export default function InvalidSignLink() {
  return (
    <SignCard>
      <Notice title="This link is not valid" body="Please check you opened the full link from your email, or get in touch and we will send it again." />
    </SignCard>
  );
}
