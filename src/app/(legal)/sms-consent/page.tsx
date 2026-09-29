/**
 * The public opt-in page — the URL a carrier reviewer visits to verify that
 * the consent described in the campaign filing actually exists.
 *
 * Rejection 30896 was "rejected because of provided Opt-in information". The
 * filing describes a consent checkbox; until this page existed there was
 * nothing to point it at. The description was accurate about intent and
 * unverifiable in fact, which reads to a reviewer exactly like a false claim.
 */
import type { Metadata } from 'next';
import { ConsentForm } from './ConsentForm';

export const metadata: Metadata = {
  title: 'Text message consent — TapDash Payments',
  description:
    'Give TapDash Payments permission to text you about your enquiry, account or support requests.',
};

export default function SmsConsentPage() {
  return (
    <div>
      <h1 className="text-[26px] font-semibold tracking-tight text-ink-900">
        Text message consent
      </h1>
      <p className="mt-2 max-w-[60ch] text-[14.5px] leading-[1.7] text-ink-700">
        If you would like us to reach you by text about your enquiry, your account or a support
        request, let us know here. We only text people who have asked us to, and you can stop at any
        time.
      </p>

      <div className="mt-6">
        <ConsentForm />
      </div>

      {/* Stated plainly rather than buried, because "consent is not a condition
          of purchase" is a claim carriers verify and customers deserve. */}
      <div className="mt-6 rounded-xl border border-line bg-white px-4 py-4">
        <p className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-400">
          What this does and does not mean
        </p>
        <ul className="mt-2.5 space-y-2 text-[13.5px] leading-relaxed text-ink-700">
          {[
            'We will only text you about your enquiry, your account, or a support request you raised. We do not send marketing texts.',
            'This is entirely optional. You can work with TapDash Payments without agreeing to texts, and declining changes nothing about the service you get.',
            'Message frequency varies, and message and data rates may apply depending on your mobile plan.',
            'Reply STOP to any message to opt out, or HELP for assistance. Opting out takes effect immediately.',
          ].map((line) => (
            <li key={line} className="flex items-start gap-2">
              <span aria-hidden className="mt-[8px] size-[4px] shrink-0 rounded-full bg-ink-300" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
