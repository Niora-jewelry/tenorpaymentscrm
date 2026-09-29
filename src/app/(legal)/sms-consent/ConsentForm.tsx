'use client';

/**
 * The consent form itself.
 *
 * ── THREE THINGS CARRIERS CHECK, AND ALL THREE ARE STRUCTURAL ────────────
 * A reviewer opens this page and looks for exactly this:
 *
 *   1. The box is NOT pre-ticked. There is no `defaultChecked` here, and
 *      there must never be — a pre-ticked box is not consent.
 *   2. The box is NOT required to submit anything else. This form does only
 *      one thing, so ticking it IS the submission; there is no other outcome
 *      being withheld until you agree.
 *   3. The wording matches what was filed with the carriers, word for word.
 *      It is rendered from the same constant the database stores, so the
 *      page, the record and the filing cannot drift apart.
 *
 * The disclosure sits BESIDE the box rather than behind a link, because
 * "agree to the terms" with the terms one click away is the pattern carriers
 * reject. The links are there as well, not instead.
 */
import { useActionState } from 'react';
import Link from 'next/link';
import { SMS_CONSENT_TEXT } from '@/lib/sms/consentText';
import { submitConsentAction, type ConsentFormState } from './actions';

const initial: ConsentFormState = { ok: false };

const field =
  'mt-1 w-full rounded-lg border border-line bg-white px-3 py-2.5 text-[14.5px] text-ink-900 outline-none focus-field';
const label = 'text-[12.5px] font-semibold uppercase tracking-wide text-ink-400';

export function ConsentForm() {
  const [state, action, pending] = useActionState(submitConsentAction, initial);

  if (state.ok) {
    return (
      <div className="rounded-2xl border border-ok/25 bg-ok-bg px-5 py-6 text-center">
        <p className="text-[16px] font-semibold text-ink-900">Thank you — you&rsquo;re all set.</p>
        <p className="mx-auto mt-2 max-w-[46ch] text-[14px] leading-relaxed text-ink-700">
          We&rsquo;ve recorded your permission to text you about your enquiry, account or support
          requests. You can reply <strong className="font-semibold">STOP</strong> to any message at
          any time to opt out.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="rounded-2xl border border-line bg-white px-5 py-5 sm:px-6 sm:py-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="fullName" className={label}>
            Your name
          </label>
          <input id="fullName" name="fullName" required maxLength={120} disabled={pending} className={field} />
        </div>
        <div>
          <label htmlFor="businessName" className={label}>
            Business <span className="font-normal normal-case text-ink-300">optional</span>
          </label>
          <input id="businessName" name="businessName" maxLength={160} disabled={pending} className={field} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="phone" className={label}>
            Mobile number
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            maxLength={32}
            placeholder="(732) 724-1779"
            disabled={pending}
            className={`${field} tabular`}
          />
        </div>
        <div>
          <label htmlFor="email" className={label}>
            Email <span className="font-normal normal-case text-ink-300">optional</span>
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            maxLength={200}
            disabled={pending}
            className={field}
          />
        </div>
      </div>

      {/* ── the consent box ──────────────────────────────────────────────
          No defaultChecked. Not pre-selected. The full disclosure is beside
          it, not behind the links. */}
      <div className="mt-5 rounded-xl border border-line bg-canvas/50 px-4 py-4">
        <label htmlFor="consent" className="flex cursor-pointer items-start gap-3">
          <input
            id="consent"
            name="consent"
            type="checkbox"
            disabled={pending}
            className="mt-[3px] size-[18px] shrink-0 accent-[#1d4ed8]"
          />
          <span className="text-[13.5px] leading-[1.65] text-ink-700">{SMS_CONSENT_TEXT}</span>
        </label>
        <p className="mt-2.5 pl-[30px] text-[12.5px] text-ink-400">
          <Link href="/sms-terms" className="text-brand-700 underline underline-offset-2">
            SMS Terms
          </Link>
          {' · '}
          <Link href="/privacy-policy" className="text-brand-700 underline underline-offset-2">
            Privacy Policy
          </Link>
        </p>
      </div>

      {state.message ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-5 w-full rounded-xl bg-accent px-5 py-3 text-[15px] font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-60 sm:w-auto"
      >
        {pending ? 'Saving…' : 'Agree and continue'}
      </button>
    </form>
  );
}
