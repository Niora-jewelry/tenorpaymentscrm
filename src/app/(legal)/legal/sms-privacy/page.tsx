/**
 * Privacy policy — the URL filed with the carriers.
 *
 * Rejection 30908 was "a compliant privacy policy can not be verified".
 *
 * ⚠ THE PARAGRAPH MARKED BELOW IS CHECKED ALMOST WORD FOR WORD. Carrier
 * reviewers search for that specific commitment about mobile information, and
 * its absence is the single most common reason a policy is called
 * non-compliant. Paraphrasing it is how this gets rejected a second time.
 *
 * This is deliberately a policy about how TapDash handles the data it holds,
 * not a template covering cookies and analytics it does not have. A policy
 * making claims about practices that do not exist is worse than a short one.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy — TapDash Payments',
  description: 'How TapDash Payments collects, uses and protects your information.',
};

export const dynamic = 'force-static';

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-8 text-[17px] font-semibold text-ink-900">{children}</h2>;
}
function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-5 text-[14.5px] font-semibold text-ink-900">{children}</h3>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-2.5 text-[14.5px] leading-[1.7] text-ink-700">{children}</p>;
}

export default function PrivacyPolicyPage() {
  return (
    <article>
      <h1 className="text-[26px] font-semibold tracking-tight text-ink-900">Privacy Policy</h1>
      <p className="mt-1.5 text-[13px] text-ink-400">Last updated 29 September 2026</p>

      <P>
        This policy explains what information TapDash Payments collects, what we do with it, and
        what choices you have. It covers our text messaging programme in particular, because that
        carries obligations we want to state plainly.
      </P>

      <H>Information we collect</H>
      <P>
        We collect information you give us directly: your name, business name, email address,
        telephone number and details of your enquiry or account. We collect this when you contact
        us, when you apply for services, and in the course of providing those services.
      </P>

      <H>Text messaging</H>

      <H3>How we collect your mobile number and consent</H3>
      <P>
        We collect your mobile number when you provide it — on an enquiry or application form on
        our website, on a call with a representative, or on signed paperwork. Where a form is used,
        consent is given by ticking a separate, clearly labelled box that is not selected in
        advance. Consent to receive text messages is never a condition of purchase.
      </P>

      {/* ── REQUIRED BY CARRIERS — DO NOT REWORD ─────────────────────────── */}
      <div className="mt-4 rounded-xl border border-line bg-white px-4 py-3.5">
        <p className="text-[14.5px] font-semibold leading-[1.7] text-ink-900">
          No mobile information will be shared with third parties or affiliates for marketing or
          promotional purposes. All other categories exclude text messaging originator opt-in data
          and consent; this information will not be shared with any third parties.
        </p>
      </div>
      {/* ─────────────────────────────────────────────────────────────────── */}

      <H3>How we use your mobile number</H3>
      <P>
        We use your mobile number only for messages related to the reason you contacted us: replies
        to your enquiry, updates on a support ticket, and arranging a time to speak. We do not send
        marketing or promotional text messages.
      </P>

      <H3>Opting out</H3>
      <P>
        Reply <strong className="font-semibold text-ink-900">STOP</strong> to any message to stop
        receiving texts. You will get one final confirmation and nothing after it. Reply{' '}
        <strong className="font-semibold text-ink-900">START</strong> to resubscribe, or{' '}
        <strong className="font-semibold text-ink-900">HELP</strong> for assistance. Message
        frequency varies and message and data rates may apply. Full terms are in our{' '}
        <Link href="/legal/sms-terms" className="text-brand-700 underline underline-offset-2">
          SMS Terms &amp; Conditions
        </Link>
        .
      </P>

      <H>How we use information generally</H>
      <P>
        To provide and support our services, to respond to you, to meet legal and regulatory
        obligations, and to protect against fraud. We do not sell your information.
      </P>

      <H>Who we share it with</H>
      <P>
        We share information with service providers who act on our behalf — for example a messaging
        provider to deliver our texts, or a payment processor to provide your services. They may use
        it only to perform that work for us, never for their own purposes. As stated above, mobile
        information and consent are never shared for marketing.
      </P>
      <P>
        We may also disclose information where the law requires it, or to protect our rights and the
        safety of others.
      </P>

      <H>Calls</H>
      <P>
        Calls to and from TapDash Payments may be recorded for quality and training purposes. Where
        a call is recorded, you are told at the start of the call.
      </P>

      <H>How long we keep it</H>
      <P>
        We keep information for as long as we provide services to you and for as long afterwards as
        the law requires. Records of text message consent are kept for as long as we hold your
        number, so we can show when and how permission was given.
      </P>

      <H>Your choices</H>
      <P>
        You can ask us what information we hold about you, ask us to correct it, or ask us to delete
        it where we are not required to keep it. Contact us at{' '}
        <a href="mailto:info@tapdash.co" className="text-brand-700 underline underline-offset-2">
          info@tapdash.co
        </a>
        .
      </P>

      <H>Security</H>
      <P>
        Access to customer information is restricted to staff who need it for their work, and that
        access is controlled and logged.
      </P>

      <H>Changes</H>
      <P>
        We may update this policy. The current version is always published here with the date it was
        last updated.
      </P>

      <H>Contact</H>
      <P>
        TapDash Payments —{' '}
        <a href="mailto:info@tapdash.co" className="text-brand-700 underline underline-offset-2">
          info@tapdash.co
        </a>
      </P>
    </article>
  );
}
