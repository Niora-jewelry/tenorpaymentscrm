'use server';

/**
 * Recording volume figures for a merchant, by hand.
 *
 * ── WHY BY HAND ──────────────────────────────────────────────────────────
 * Volumes come from the processor's PDF statement. The PDF importer is in the
 * schema and ready; what is missing is a sample statement to write a parser
 * against. A parser written against an imagined layout produces plausible
 * numbers from the wrong columns, which is strictly worse than no parser — so
 * until a real statement arrives, the operator types the four buckets off the
 * one in front of them.
 *
 * Those rows are stamped `source = 'manual'` with no `import_id`, which the
 * provenance CHECK states as an equivalence. A hand-entered figure stays
 * permanently distinguishable from an imported one, so nothing has to be
 * unpicked when the parser does land.
 *
 * ── VOLUMES CROSS AS TEXT, COUNTS AS WHOLE NUMBERS ───────────────────────
 * A volume is a dollar figure a rate gets applied to, so it is validated as
 * decimal TEXT and cast by PostgreSQL — never `Number()`. A count is an
 * `integer` column and is validated as digits, because "100.5 transactions" is
 * not a thing and a cast would silently round it.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { updateVolumes, volumeRows } from '@/lib/records/residualVolumes';
import { VOLUME_FIELDS, type VolumeRow } from '@/lib/residuals/volumes';

export type VolumeActionResult = { ok: boolean; message: string };

/**
 * A dollar volume, as text, or blank.
 *
 * Two decimal places, not six: this is money that passed through, not a rate.
 * Accounting formats are NOT accepted here the way they are in the fee-report
 * parser — that parser reads a vendor file it cannot change, while this is a
 * person typing into a box, and quietly reinterpreting what they typed is a
 * different proposition from reading a file as it was written.
 */
const VOLUME = z
  .string()
  .trim()
  .refine((v) => v === '' || /^-?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(v), {
    message: 'Volumes are plain amounts, up to two decimal places.',
  });

/** An item count. Digits, or blank. Never a decimal. */
const COUNT = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{1,9}$/.test(v), {
    message: 'An item count is a whole number.',
  });

export async function updateVolumesAction(
  periodId: string,
  mid: string,
  formData: FormData,
): Promise<VolumeActionResult> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const ids = z
    .object({ periodId: z.string().uuid(), mid: z.string().trim().min(1).max(32) })
    .safeParse({ periodId, mid });
  if (!ids.success) return { ok: false, message: 'That is not a merchant.' };

  const values: Record<string, string> = {};

  for (const f of VOLUME_FIELDS) {
    const vol = VOLUME.safeParse(formData.get(f.key) ?? '');
    if (!vol.success) {
      return { ok: false, message: `${f.label} volume: ${vol.error.issues[0].message}` };
    }
    values[f.key] = vol.data;

    const count = COUNT.safeParse(formData.get(f.countKey) ?? '');
    if (!count.success) {
      return { ok: false, message: `${f.label} item count: ${count.error.issues[0].message}` };
    }
    values[f.countKey] = count.data;
  }

  const name = formData.get('merchant_name');

  const r = await updateVolumes(
    ctx,
    ids.data.periodId,
    ids.data.mid,
    values,
    typeof name === 'string' ? name : null,
  );

  if (!r.ok) return r;

  revalidatePath(`/admin/residuals/${ids.data.periodId}`);
  return {
    ok: true,
    /*
     * The second sentence is not padding. Writing a volume row does not move a
     * single figure until the engine re-reads it, and an operator who types
     * four numbers, sees "saved", and then sees the same withheld comparison
     * will reasonably conclude the save did not work.
     */
    message: `${r.message} Re-calculate the month to apply ${r.created ? 'them' : 'the change'}.`,
  };
}

/** Loads the volume row for one merchant, on demand. */
export async function loadVolumesAction(
  periodId: string,
  mid: string,
): Promise<{ ok: true; row: VolumeRow } | { ok: false; message: string }> {
  const ctx = await authorize();
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  const parsed = z
    .object({ periodId: z.string().uuid(), mid: z.string().trim().min(1).max(32) })
    .safeParse({ periodId, mid });
  if (!parsed.success) return { ok: false, message: 'That is not a merchant.' };

  try {
    const rows = await volumeRows(ctx, parsed.data.periodId, parsed.data.mid);
    /*
     * `residual_merchant_volume_row` returns a row even where none exists,
     * with `has_row` false — so an empty result means the MID is not in this
     * period at all, which is a different thing from having no volumes.
     */
    const row = rows[0];
    if (!row) return { ok: false, message: 'That merchant has no lines in this month.' };
    return { ok: true, row };
  } catch (e) {
    console.error('[residuals] loading volumes failed', e);
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Those figures could not be read.',
    };
  }
}
