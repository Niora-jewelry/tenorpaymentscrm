/**
 * /apply/<token> — the merchant's application, prefilled. No login; the
 * token is the access (see `proxy.ts`, `lib/applications/merchant.ts`).
 *
 * Never indexed, never sends a referrer (the token is in this URL), and
 * never cached: every load reads the application's current state.
 */
import type { Metadata } from 'next';
import { openForMerchant } from '@/lib/applications/merchant';
import { MerchantApplication } from './MerchantApplication';
import { LinkMessage } from './LinkMessage';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Merchant application',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function ApplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const form = await openForMerchant(token);

  if (form.state !== 'open') {
    return <LinkMessage state={form.state} label={form.label} merchant={form.merchant} />;
  }
  return (
    <MerchantApplication
      token={token}
      label={form.label}
      merchant={form.merchant}
      expiresAt={form.expiresAt}
      initial={form.answers}
      ssnOnFile={form.ssnOnFile}
      ssnEntered={form.ssnEntered}
      savedAt={form.savedAt}
    />
  );
}
