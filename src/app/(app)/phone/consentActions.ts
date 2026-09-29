'use server';

/**
 * Consent, from inside the CRM.
 *
 * Two things a representative needs: to see whether they may text a number,
 * and to record consent a merchant gave them on a call or on paperwork. Both
 * go through the gate first — this is staff-facing, unlike the public form.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { canSeePhone } from '@/lib/phone/access';
import { normalizePhone } from '@/lib/phone/normalize';
import { consentStatus, recordConsent, revokeConsent, type ConsentStatus } from '@/lib/sms/consent';

export type ConsentActionState = { ok: boolean; message?: string };

const recordSchema = z.object({
  phone: z.string().trim().min(3).max(32),
  /*
   * 'web_form' is deliberately NOT accepted here. A representative cannot
   * assert that somebody ticked a box on a website — only the website can say
   * that, and letting staff claim it would put unverifiable rows in the one
   * table whose whole purpose is being verifiable.
   */
  source: z.enum(['verbal', 'paperwork', 'imported']),
  fullName: z.string().trim().max(120).optional().or(z.literal('')),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

/** Ask whether a number may be texted. */
export async function consentStatusAction(phone: string): Promise<ConsentStatus> {
  const ctx = await authorize();
  const none = { consented: false, source: null, consentedAt: null, fullName: null };
  if (!(await canSeePhone(ctx))) return none;

  const parsed = normalizePhone(phone);
  return parsed.ok ? consentStatus(parsed.e164) : none;
}

/** Record consent a merchant gave on a call or on signed paperwork. */
export async function recordConsentAction(input: {
  phone: string;
  source: 'verbal' | 'paperwork' | 'imported';
  fullName?: string;
  note?: string;
}): Promise<ConsentActionState> {
  const ctx = await authorize();
  if (!(await canSeePhone(ctx))) {
    return { ok: false, message: 'You do not have access to the phone.' };
  }

  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'That is not valid.' };
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!phone.ok) return { ok: false, message: 'That does not look like a phone number.' };

  const id = await recordConsent({
    e164: phone.e164,
    source: parsed.data.source,
    fullName: parsed.data.fullName || null,
    note: parsed.data.note || null,
    // Who vouched for it. The table's own CHECK requires this for anything
    // that is not the web form, so an unattributed verbal consent is refused
    // by the database rather than merely discouraged here.
    recordedById: ctx.userId,
  });

  if (!id) return { ok: false, message: 'That could not be saved.' };

  revalidatePath('/phone');
  return { ok: true };
}

/** Withdraw consent by hand — a merchant who asks a rep to stop texting. */
export async function revokeConsentAction(
  phone: string,
  reason: string,
): Promise<ConsentActionState> {
  const ctx = await authorize();
  if (!(await canSeePhone(ctx))) {
    return { ok: false, message: 'You do not have access to the phone.' };
  }

  const parsed = normalizePhone(phone);
  if (!parsed.ok) return { ok: false, message: 'That does not look like a phone number.' };

  await revokeConsent(parsed.e164, reason.trim() || 'withdrawn by a representative');
  revalidatePath('/phone');
  return { ok: true };
}
