'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import { saveSendingInbox, SendingInboxError } from '@/lib/mail/sendingInbox';

const Input = z
  .object({
    purpose: z.enum(['applications', 'proposals', 'agreements']),
    mode: z.enum(['own', 'mailbox', 'signwell']),
    mailboxId: z.uuid().nullable(),
  })
  .refine((v) => v.mode !== 'mailbox' || !!v.mailboxId, { message: 'Pick an inbox.' })
  .refine((v) => v.mode !== 'signwell' || v.purpose === 'agreements', { message: 'Only agreements can be sent by SignWell.' });

export async function saveSendingInboxAction(input: z.input<typeof Input>): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'That choice is not valid.' };
  const ctx = await authorize();
  try {
    await saveSendingInbox(ctx, parsed.data.purpose, parsed.data.mode, parsed.data.mailboxId);
  } catch (e) {
    return { ok: false, message: e instanceof SendingInboxError ? e.message : 'The choice was not saved. Try again.' };
  }
  revalidatePath('/admin/presets');
  return { ok: true };
}
