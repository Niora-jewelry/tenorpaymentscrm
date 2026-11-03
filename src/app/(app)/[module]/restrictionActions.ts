'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { liftRestrictions, reapplyRestriction } from '@/lib/records/restrictions';

export type RestrictionResult = { ok: boolean; message?: string };

const Lift = z.object({
  moduleSlug: z.string().min(1).max(60),
  recordId: z.uuid(),
  items: z.array(z.string().min(3).max(200)).min(1).max(500),
  kind: z.enum(['lock', 'hide']),
});

export async function liftRestrictionAction(input: z.input<typeof Lift>): Promise<RestrictionResult> {
  const ctx = await authorize();
  const parsed = Lift.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That can’t be lifted.' };
  try {
    await liftRestrictions(ctx, parsed.data.recordId, parsed.data.items, parsed.data.kind);
  } catch {
    return { ok: false, message: parsed.data.kind === 'lock' ? 'Could not unlock that.' : 'Could not unhide that.' };
  }
  revalidatePath(`/${parsed.data.moduleSlug}`);
  return { ok: true };
}

const Reapply = z.object({ moduleSlug: z.string().min(1).max(60), recordId: z.uuid(), batchId: z.uuid() });

export async function reapplyRestrictionAction(input: z.input<typeof Reapply>): Promise<RestrictionResult> {
  const ctx = await authorize();
  const parsed = Reapply.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That can’t be put back.' };
  try {
    await reapplyRestriction(ctx, parsed.data.recordId, parsed.data.batchId);
  } catch {
    return { ok: false, message: 'Could not put that back.' };
  }
  revalidatePath(`/${parsed.data.moduleSlug}`);
  return { ok: true };
}
