'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import { ApplicationError, saveApplicationSettings } from '@/lib/applications/service';

const Input = z.object({
  linkExpiryDays: z.number().int().min(1, 'The link must last at least 1 day.').max(365, 'The link can last at most 365 days.'),
  emailSubject: z.string().trim().min(1, 'Add a subject.').max(200),
  emailBody: z.string().trim().min(1, 'Add a message.').max(5000),
});

export async function saveApplicationSettingsAction(input: z.input<typeof Input>): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Those settings are not valid.' };
  const ctx = await authorize();
  try {
    await saveApplicationSettings(ctx, parsed.data);
  } catch (e) {
    return { ok: false, message: e instanceof ApplicationError ? e.message : 'The settings were not saved. Try again.' };
  }
  revalidatePath('/admin/presets');
  return { ok: true };
}
