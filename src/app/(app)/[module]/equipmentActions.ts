'use server';

/**
 * Merchant Equipment Setup actions. Parsed here; every rule is in the service and the
 * database. Each one revalidates the module, so the drawer redraws from what the
 * viewer may now see.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { addEquipmentProvider, addEquipmentRow, deleteEquipmentRow, updateEquipmentRow, type EquipmentPanelData, type EquipmentResult } from '@/lib/equipment/service';

const moduleSlug = z.string().regex(/^[a-z0-9-]{1,60}$/);
const recordInput = z.object({ moduleSlug, recordId: z.string().uuid() });
const rowInput = z.object({ moduleSlug, rowId: z.string().uuid() });
const updateInput = rowInput.extend({
  column: z.string().max(40),
  // The type of each column is checked by `parseColumnValue`, which knows them.
  value: z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]),
});
const providerInput = recordInput.extend({ name: z.string().max(200) });

const BAD = { ok: false as const, message: 'That request was not valid.' };

export async function addEquipmentRowAction(input: unknown): Promise<EquipmentResult> {
  const p = recordInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await addEquipmentRow(ctx, p.data.recordId);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}

export async function updateEquipmentRowAction(input: unknown): Promise<EquipmentResult> {
  const p = updateInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await updateEquipmentRow(ctx, p.data.rowId, p.data.column, p.data.value);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}

export async function deleteEquipmentRowAction(input: unknown): Promise<EquipmentResult> {
  const p = rowInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await deleteEquipmentRow(ctx, p.data.rowId);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}

export async function addEquipmentProviderAction(input: unknown): Promise<EquipmentResult<{ panel: EquipmentPanelData; providerId: string }>> {
  const p = providerInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await addEquipmentProvider(ctx, p.data.recordId, p.data.name);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}
