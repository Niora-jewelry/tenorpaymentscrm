'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import { AgreementError, saveAgreementSettings } from '@/lib/agreements/service';

const Input = z.object({
  expiresDays: z.number().int().min(1, 'Signers need at least 1 day.').max(365, 'At most 365 days.'),
  reminders: z.boolean(),
  requesterName: z.string().trim().min(1, 'Add the sender name.').max(80),
  requesterEmail: z.string().trim().max(254).nullable().transform((v) => (v ? v : null)),
  emailSubject: z.string().trim().min(1, 'Add a subject.').max(200),
  emailMessage: z.string().trim().min(1, 'Add a message.').max(5000),
});

export async function saveAgreementSettingsAction(input: z.input<typeof Input>): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Those settings are not valid.' };
  if (parsed.data.requesterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(parsed.data.requesterEmail)) return { ok: false, message: 'The sender email is not a valid address.' };
  const ctx = await authorize();
  try {
    await saveAgreementSettings(ctx, parsed.data);
  } catch (e) {
    return { ok: false, message: e instanceof AgreementError ? e.message : 'The settings were not saved. Try again.' };
  }
  revalidatePath('/admin/presets');
  return { ok: true };
}
