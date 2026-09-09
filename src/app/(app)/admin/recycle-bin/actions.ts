'use server';

import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import { restoreRecord, purgeRecord } from '@/lib/records/records';
import { restoreBinItem, type BinKind, type BinRestoreResult } from '@/lib/records/recycleBin';
import { binItemSchema, firstIssueMessage } from '@/lib/records/adminSchemas';

export type RestoreState =
  | { ok: true }
  | { ok: false; message: string; record: { id: string; dealName: string } | null };

/**
 * Restore, with the refusal the client specified rather than a raw constraint
 * violation. `record` is present only when this admin may be told which record
 * is blocking — see `describeDuplicate` (Modules Amendment 2). In practice an
 * admin sees everything, but the gate is applied uniformly rather than assumed
 * away, because Recycle Bin access could be widened later.
 */
export async function restoreAction(recordId: string): Promise<RestoreState> {
  const ctx = await authorize();
  const result = await restoreRecord(ctx, recordId);
  if (!result.ok) {
    return { ok: false, message: result.block.message, record: result.block.record };
  }
  revalidatePath('/admin/recycle-bin');
  return { ok: true };
}

export async function purgeAction(recordId: string): Promise<void> {
  const ctx = await authorize();
  await purgeRecord(ctx, recordId);
  revalidatePath('/admin/recycle-bin');
}

/**
 * Restore a file, an update, a reply, a login row, a case thread or a case
 * reply — Admin §6's "everything truly soft-deleted".
 *
 * The refusals these raise are sentences written for a person ("Restore the case
 * thread first", "That file row already holds 5 files"), so they are passed
 * straight through rather than flattened into one generic failure. Which one
 * refused is the whole value of the message.
 */
export async function restoreBinItemAction(kind: BinKind, id: string): Promise<BinRestoreResult> {
  const ctx = await authorize();

  const parsed = binItemSchema.safeParse({ kind, id });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await restoreBinItem(ctx, parsed.data.kind, parsed.data.id);
  if (!result.ok) return result;

  revalidatePath('/admin/recycle-bin');
  // The thing came back on a record somewhere, and that record's drawer is
  // rendered from the same data. Wider than this screen for the same reason
  // the config invalidator is: the change is not visible from here.
  revalidatePath('/', 'layout');
  return { ok: true };
}
