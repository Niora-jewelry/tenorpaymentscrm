'use server';

import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { fieldHistory, type FieldHistoryEntry } from '@/lib/records/activity';

const Input = z.object({ recordId: z.uuid(), fieldKey: z.string().regex(/^[a-z0-9_]{1,80}$/) });

/** One field's history on one record. Hidden fields return nothing (`fieldHistory`). */
export async function fieldHistoryAction(input: z.input<typeof Input>): Promise<{ ok: true; entries: FieldHistoryEntry[] } | { ok: false; message: string }> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That field is not valid.' };
  const ctx = await authorize();
  try {
    const entries = await fieldHistory(ctx, parsed.data.recordId, parsed.data.fieldKey);
    return entries ? { ok: true, entries } : { ok: false, message: 'There is no history you can see for this field.' };
  } catch {
    return { ok: false, message: 'The history could not be loaded. Try again.' };
  }
}
