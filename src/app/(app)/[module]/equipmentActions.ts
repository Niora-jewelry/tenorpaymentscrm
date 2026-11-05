'use server';

/**
 * Merchant Equipment Setup actions. Parsed here; every rule is in the service and the
 * database.
 *
 * Deliberately no `revalidatePath`, for the reason on the field save in `actions.ts`:
 * it recomputes the whole route inside this action's own response, and every box in
 * the panel would wait for that. Each action answers with the panel as the viewer may
 * now see it, and the panel asks for a refresh afterwards, without waiting for it.
 */
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
  return addEquipmentRow(ctx, p.data.recordId);
}

export async function updateEquipmentRowAction(input: unknown): Promise<EquipmentResult> {
  const p = updateInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  return updateEquipmentRow(ctx, p.data.rowId, p.data.column, p.data.value);
}

export async function deleteEquipmentRowAction(input: unknown): Promise<EquipmentResult> {
  const p = rowInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  return deleteEquipmentRow(ctx, p.data.rowId);
}

export async function addEquipmentProviderAction(input: unknown): Promise<EquipmentResult<{ panel: EquipmentPanelData; providerId: string }>> {
  const p = providerInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  return addEquipmentProvider(ctx, p.data.recordId, p.data.name);
}
