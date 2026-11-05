'use server';

import { z } from 'zod';
import { setFieldGlowHidden } from '@/lib/records/fieldGlowAccess';
import { authorize } from '@/lib/records/permissions';

export type GlowResult = { ok: boolean; message?: string };

const Input = z.object({ hidden: z.boolean() });

/** The personal on/off switch on the Field guide. It changes this user's screen and no one else's. */
export async function setFieldGlowHiddenAction(input: unknown): Promise<GlowResult> {
  const ctx = await authorize();
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That can’t be changed.' };
  try {
    await setFieldGlowHidden(ctx, parsed.data.hidden);
  } catch {
    return { ok: false, message: 'Could not save that. Try again.' };
  }
  return { ok: true };
}
