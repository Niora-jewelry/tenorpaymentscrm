'use server';

/**
 * Admin → Phone numbers. Thin shells over `lib/records/adminNumbers`.
 *
 * Every one re-checks admin inside the data layer, independently of the page
 * that rendered the form — the page's redirect is convenience, not the boundary.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { addNumber, assignNumber, setNumberActive } from '@/lib/records/adminNumbers';

export type NumbersState = { ok: true } | { ok: false; message: string };

const addSchema = z.object({
  e164: z.string().trim().min(3).max(32),
  label: z.string().trim().max(120).optional(),
});

const assignSchema = z.object({
  numberId: z.string().uuid(),
  /** Empty string means "unassign" — a select cannot submit null. */
  userId: z.string().uuid().or(z.literal('')),
});

const activeSchema = z.object({
  numberId: z.string().uuid(),
  isActive: z.boolean(),
});

export async function addNumberAction(formData: FormData): Promise<NumbersState> {
  const ctx = await authorize();

  const parsed = addSchema.safeParse({
    e164: formData.get('e164'),
    label: formData.get('label') ?? undefined,
  });
  if (!parsed.success) return { ok: false, message: 'Enter a phone number.' };

  const result = await addNumber(ctx, {
    e164: parsed.data.e164,
    label: parsed.data.label?.trim() || null,
  });

  revalidatePath('/admin/numbers');
  return result;
}

export async function assignNumberAction(numberId: string, userId: string): Promise<NumbersState> {
  const ctx = await authorize();

  const parsed = assignSchema.safeParse({ numberId, userId });
  if (!parsed.success) return { ok: false, message: 'That assignment is not valid.' };

  const result = await assignNumber(ctx, {
    numberId: parsed.data.numberId,
    userId: parsed.data.userId === '' ? null : parsed.data.userId,
  });

  revalidatePath('/admin/numbers');
  return result;
}

export async function setNumberActiveAction(numberId: string, isActive: boolean): Promise<void> {
  const ctx = await authorize();

  const parsed = activeSchema.safeParse({ numberId, isActive });
  if (!parsed.success) return;

  await setNumberActive(ctx, parsed.data);
  revalidatePath('/admin/numbers');
}
