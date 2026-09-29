'use server';

/**
 * The public consent form's only write path.
 *
 * ── THIS IS AN UNAUTHENTICATED ENDPOINT ──────────────────────────────────
 * Anyone on the internet can reach it, which is the point — a carrier
 * reviewer has to be able to submit it. So it carries its own protection
 * rather than relying on a session that does not exist:
 *
 *   • Zod at the boundary (CLAUDE.md rule 6)
 *   • rate limiting per IP, using the same limiter as the auth endpoints
 *   • the consent WORDING is not accepted from the request — it is read from
 *     `consentText.ts`, so a forged submission cannot store consent against
 *     words nobody was shown
 *
 * It deliberately returns the same answer whether or not the number was
 * already on file. "You are already subscribed" would turn this form into a
 * way to ask whether TapDash holds a given mobile number.
 */
import { headers } from 'next/headers';
import { z } from 'zod';
import { normalizePhone } from '@/lib/phone/normalize';
import { recordConsent } from '@/lib/sms/consent';
import { rateLimitAll, ipKey, RATE_LIMITS } from '@/lib/security/rate-limit';

const schema = z.object({
  fullName: z.string().trim().min(1, 'Please enter your name.').max(120),
  businessName: z.string().trim().max(160).optional().or(z.literal('')),
  email: z.string().trim().max(200).email('Please enter a valid email address.').optional().or(z.literal('')),
  phone: z.string().trim().min(3, 'Please enter your mobile number.').max(32),
  // Checkbox inputs post 'on' when ticked and are simply absent when not.
  consent: z.literal('on', { message: 'Please tick the box to agree.' }),
});

export type ConsentFormState = { ok: boolean; message?: string };

export async function submitConsentAction(
  _prev: ConsentFormState,
  formData: FormData,
): Promise<ConsentFormState> {
  const parsed = schema.safeParse({
    fullName: formData.get('fullName'),
    businessName: formData.get('businessName') ?? '',
    email: formData.get('email') ?? '',
    phone: formData.get('phone'),
    consent: formData.get('consent'),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Please check the form.' };
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!phone.ok) {
    return { ok: false, message: 'That does not look like a mobile number.' };
  }

  const head = await headers();
  /*
   * On Vercel the client address is in `x-forwarded-for`, left-most entry.
   * Stored as evidence of the submission, which is a large part of what makes
   * this a record rather than an assertion.
   */
  const ip = (head.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;
  const userAgent = head.get('user-agent');

  const limit = await rateLimitAll([
    { key: ipKey('sms_consent', ip ?? 'unknown'), rule: RATE_LIMITS.signupOtpPerIp },
  ]);
  if (!limit.allowed) {
    return { ok: false, message: 'Too many submissions. Please try again later.' };
  }

  const id = await recordConsent({
    e164: phone.e164,
    source: 'web_form',
    fullName: parsed.data.fullName,
    businessName: parsed.data.businessName || null,
    email: parsed.data.email || null,
    ip,
    userAgent,
  });

  if (!id) {
    return { ok: false, message: 'We could not save that. Please try again in a moment.' };
  }

  return { ok: true };
}
