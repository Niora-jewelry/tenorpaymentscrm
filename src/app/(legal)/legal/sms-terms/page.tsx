/**
 * SMS Terms & Conditions — the URL filed with the carriers.
 *
 * Rejection 30882 was "Terms and Conditions issues": the reviewer followed the
 * URL in the campaign and did not find terms covering the texting programme.
 * Every numbered section below is something carriers specifically look for, so
 * none of them is padding:
 *
 *   programme description · how you join · message frequency · cost ·
 *   how to stop · how to get help · carrier liability · privacy link
 *
 * Removing one is how this gets rejected again.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { SMS_CONSENT_TEXT } from '@/lib/sms/consentText';

export const metadata: Metadata = {
  title: 'SMS Terms & Conditions — TapDash Payments',
  description:
    'Terms for TapDash Payments customer care text messages: frequency, cost, and how to stop.',
};

/* Static. Nothing here depends on a request, a session or the database, and a
   legal page that needs a database is a page that is sometimes unavailable. */
export const dynamic = 'force-static';

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-8 text-[17px] font-semibold text-ink-900">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-2.5 text-[14.5px] leading-[1.7] text-ink-700">{children}</p>;
}

export default function SmsTermsPage() {
  return (
    <article>
      <h1 className="text-[26px] font-semibold tracking-tight text-ink-900">
        SMS Terms &amp; Conditions
      </h1>
      <p className="mt-1.5 text-[13px] text-ink-400">Last updated 29 September 2026</p>

      <H>1. Programme description</H>
      <P>
        TapDash Payments operates a customer care text messaging programme. We use text messages to
        reply to enquiries you submit to us, to follow up on support tickets and service requests,
        and to arrange a convenient time to speak with you about your account.
      </P>
      <P>
        <strong className="font-semibold text-ink-900">This is not a marketing programme.</strong>{' '}
        We do not send promotional offers or advertising by text.
      </P>

      <H>2. How you join</H>
      <P>
        You join by giving us your mobile number and agreeing to be contacted by text. That happens
        in one of three ways: by ticking the consent box on an enquiry or application form on our
        website, by telling a TapDash Payments representative on a call, or by signing paperwork
        carrying our SMS clause. Where a form is used, the consent box is separate from the rest of
        the form and is never ticked in advance.
      </P>
      <P>
        <strong className="font-semibold text-ink-900">
          Consent to receive text messages is not a condition of purchase.
        </strong>{' '}
        You can use our services without agreeing to receive texts.
      </P>
      <div className="mt-3 rounded-xl border border-line bg-white px-4 py-3">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-400">
          What you agree to
        </p>
        {/* The same constant the form renders and the database stores, so the
            three can never drift apart — and so a reviewer comparing this page
            with the filing finds them identical. */}
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-700">{SMS_CONSENT_TEXT}</p>
      </div>

      <H>3. Message frequency</H>
      <P>
        Message frequency varies. Messages are sent in response to your enquiry or support request,
        so how many you receive depends on your conversation with us.
      </P>

      <H>4. Cost</H>
      <P>
        <strong className="font-semibold text-ink-900">Message and data rates may apply.</strong>{' '}
        TapDash Payments does not charge you for these messages, but your mobile carrier may,
        depending on your plan. Check with your carrier if you are unsure.
      </P>

      <H>5. How to stop messages</H>
      <P>
        Reply <strong className="font-semibold text-ink-900">STOP</strong> to any message at any
        time. You will receive a single confirmation that you have been unsubscribed, and we will
        not text you again unless you opt back in. You may also reply CANCEL, QUIT, END,
        UNSUBSCRIBE, OPTOUT, STOPALL or REVOKE.
      </P>
      <P>
        Reply <strong className="font-semibold text-ink-900">START</strong> at any time to begin
        receiving messages again.
      </P>

      <H>6. How to get help</H>
      <P>
        Reply <strong className="font-semibold text-ink-900">HELP</strong> or{' '}
        <strong className="font-semibold text-ink-900">INFO</strong> to any message for assistance.
        You can also contact us at{' '}
        <a href="mailto:info@tapdash.co" className="text-brand-700 underline underline-offset-2">
          info@tapdash.co
        </a>
        .
      </P>

      <H>7. Supported carriers</H>
      <P>
        Our messaging programme is supported by the major US mobile carriers. Carriers are not
        liable for delayed or undelivered messages.
      </P>

      <H>8. Privacy</H>
      <P>
        <strong className="font-semibold text-ink-900">
          No mobile information will be shared with third parties or affiliates for marketing or
          promotional purposes.
        </strong>{' '}
        How we handle your mobile number is set out in full in our{' '}
        <Link href="/legal/sms-privacy" className="text-brand-700 underline underline-offset-2">
          Privacy Policy
        </Link>
        .
      </P>

      <H>9. Changes</H>
      <P>
        We may update these terms from time to time. The current version is always published on this
        page with the date it was last updated.
      </P>
    </article>
  );
}
