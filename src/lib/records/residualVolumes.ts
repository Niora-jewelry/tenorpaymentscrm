/**
 * Volume figures for a statement month.
 *
 * ── WHY THIS IS HAND ENTRY AND NOT AN IMPORT ─────────────────────────────
 * Volumes come from the processor's PDF statement, and the PDF importer
 * (`commit_residual_pdf_import`) is in the schema and ready. What is not
 * available is a sample statement to write a parser against — the layout
 * cannot be guessed, and a parser written against an imagined layout would
 * produce plausible numbers from the wrong columns, which is worse than no
 * parser.
 *
 * So the interim is the operator typing the four buckets off the statement in
 * front of them. The rows are stamped `source = 'manual'` with no `import_id`,
 * which the provenance CHECK states as an equivalence — so a hand-entered
 * figure is permanently distinguishable from an imported one, and nothing has
 * to be undone when the parser lands.
 *
 * ── REQUEST-SCOPED, LIKE THE REST ────────────────────────────────────────
 * `residual_update_merchant_volumes` is `security definer`, gated on
 * `auth_is_admin()`, and raises a second time if `auth.uid()` is null:
 * *"Editing volumes by hand requires an identified actor."* The service role
 * cannot do it, and should not be able to — a hand-entered figure with no
 * author is the one thing worse than no figure.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { VOLUME_KEYS } from '@/lib/residuals/volumes';
import type { VolumeMappingRow, VolumeRow } from '@/lib/residuals/volumes';
import { assertAdminPage } from './adminConfig';

export type { VolumeBucketDetail, VolumeMappingRow, VolumeRow } from '@/lib/residuals/volumes';


/**
 * The volume row for one merchant, or for every merchant in the period.
 *
 * `hasRow` is the field that matters: "no row at all" and "a row of zeros" are
 * different claims about a month, and only the second is something a human
 * decided.
 */
export async function volumeRows(
  ctx: AuthContext,
  periodId: string,
  mid: string | null = null,
): Promise<VolumeRow[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_merchant_volume_row', {
    p_period_id: periodId,
    p_mid: mid,
  });

  if (error) {
    console.error('[residuals] volume rows failed', error);
    throw new Error(`Volume figures could not be read: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    mid: String(r.mid),
    hasRow: r.has_row === true,
    merchantName: (r.merchant_name as string | null) ?? null,
    amexVolume: (r.amex_volume as string | null) ?? null,
    vmdVolume: (r.vmd_volume as string | null) ?? null,
    debitVolume: (r.debit_volume as string | null) ?? null,
    ebtVolume: (r.ebt_volume as string | null) ?? null,
    amexItemCount: r.amex_item_count === null ? null : Number(r.amex_item_count),
    vmdItemCount: r.vmd_item_count === null ? null : Number(r.vmd_item_count),
    debitItemCount: r.debit_item_count === null ? null : Number(r.debit_item_count),
    ebtItemCount: r.ebt_item_count === null ? null : Number(r.ebt_item_count),
    anyBucketNull: r.any_bucket_null === true,
    source: (r.source as string | null) ?? null,
  }));
}

/**
 * Which fee items in the period are assessed on volume, and whether the rule
 * knows which buckets to use.
 *
 * Two different causes present identically as a withheld step-1 verdict — no
 * volume row, and a rule with no bucket mapping — so they have to be
 * separable. This is the second one.
 */
export async function volumeMappingCoverage(
  ctx: AuthContext,
  periodId: string,
): Promise<VolumeMappingRow[]> {
  await assertAdminPage(ctx, 'residuals');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_volume_mapping_coverage', {
    p_period_id: periodId,
  });

  if (error) {
    console.error('[residuals] volume mapping coverage failed', error);
    throw new Error(`Volume mappings could not be read: ${error.message}`);
  }

  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    feeItemName: String(r.fee_item_name),
    lineCount: Number(r.line_count ?? 0),
    isMapped: r.is_mapped === true,
    buckets: (r.buckets as string[] | null) ?? null,
    basis: r.basis === null || r.basis === undefined ? null : String(r.basis),
    bucketDetail: ((r.bucket_detail as Record<string, unknown>[] | null) ?? []).map((d) => ({
      bucket: String(d.bucket),
      basis: String(d.basis),
      appliesWhen: String(d.applies_when),
      sibling: d.sibling === null || d.sibling === undefined ? null : String(d.sibling),
    })),
  }));
}

/**
 * Writes the four buckets and their counts for one merchant.
 *
 * ── EVERY VALUE IS TEXT OR NULL ──────────────────────────────────────────
 * The RPC casts the volumes to `numeric` and the counts to `integer`. A
 * volume is a dollar figure that a rate gets applied to, so it goes through no
 * JavaScript float on the way.
 *
 * ── A BLANK BUCKET IS NULL, NOT ZERO ─────────────────────────────────────
 * Same rule as the rates, for the same reason and with a sharper edge here: a
 * NULL bucket is what puts the merchant on the `awaiting_volumes` rung, and a
 * zero takes it off. If a statement genuinely shows no Amex volume then 0 is
 * the right entry — but that is somebody deciding, not a form defaulting.
 *
 * ── ONLY THE EIGHT EDITABLE KEYS ARE SENT ────────────────────────────────
 * The RPC refuses anything else BY NAME rather than ignoring it, and the
 * refusal explains itself: *"stated_total, reconciled and unmapped_volume are
 * the PDF rollup's conclusions, not observations."* Filtering here means a
 * typo cannot reach that error.
 */
export async function updateVolumes(
  ctx: AuthContext,
  periodId: string,
  mid: string,
  values: Record<string, string | null>,
  merchantName: string | null,
): Promise<{ ok: boolean; message: string; created?: boolean }> {
  await assertAdminPage(ctx, 'residuals');

  const clean: Record<string, string | null> = {};
  for (const k of VOLUME_KEYS) {
    const v = values[k];
    clean[k] = v === undefined || v === null || v.trim() === '' ? null : v.trim();
  }
  if (merchantName !== null && merchantName.trim() !== '') {
    clean.merchant_name = merchantName.trim();
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('residual_update_merchant_volumes', {
    p_period_id: periodId,
    p_mid: mid,
    p_values: clean,
  });

  if (error) {
    console.error('[residuals] updating volumes failed', error);
    return { ok: false, message: error.message };
  }

  /*
   * `changed_fields` is the function's own diff, and it is worth reporting
   * rather than a flat "saved": a save that changed nothing looks identical to
   * one that changed everything, and on a form where a blank field CLEARS a
   * column that difference is the one the operator wants confirmed.
   */
  const r = (data ?? {}) as { created?: boolean; changed_fields?: string[] };
  const changed = (r.changed_fields ?? []).filter((k) => k !== 'merchant_name');

  if (r.created === true) {
    return { ok: true, created: true, message: 'Volume figures recorded.' };
  }
  return {
    ok: true,
    created: false,
    message:
      changed.length === 0
        ? 'Nothing changed — those are the figures already on file.'
        : `Updated ${changed.length} figure${changed.length === 1 ? '' : 's'}.`,
  };
}
