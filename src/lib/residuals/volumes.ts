/**
 * The four volume buckets — the field vocabulary, client-safe.
 *
 * No imports, nothing that runs. Same reason as `reconciliation.ts` and
 * `rates.ts`: the editor is a client component and a label map is a runtime
 * value.
 *
 * ── WHAT VOLUMES ARE FOR ─────────────────────────────────────────────────
 * Some fee items are charged on a COUNT (an authorisation fee: 100 items × a
 * per-item rate) and some on a VOLUME (BIN sponsorship: a rate applied to the
 * dollars that passed through). The count comes from the fee report; the
 * volume does not — it comes from the PDF statement. A merchant with no volume
 * row is therefore `awaiting_volumes`: the count-based items computed fine and
 * the volume-based ones cannot be, and no rate fixes that.
 *
 * ── THE FOUR BUCKETS ARE NOT INTERCHANGEABLE ─────────────────────────────
 * Each rule names which buckets its volume comes from, through
 * `residual_volume_row_mappings`. BIN is assessed on VMD + debit and Amex is
 * deliberately not in it; Amex OptBlue is assessed on Amex alone; Cash
 * Discount spans all three card buckets and excludes EBT. So putting a total
 * in the wrong bucket does not produce a slightly wrong number — it produces a
 * number for a rule that should not have seen that money at all.
 *
 * ── WHAT IS HAND-ENTERABLE AND WHAT IS NOT ───────────────────────────────
 * The four buckets and their four counts, and nothing else. The RPC refuses
 * the rest by name, and its hint says why: *"stated_total, reconciled and
 * unmapped_volume are the PDF rollup's conclusions, not observations."* A
 * conclusion typed in by hand is not a conclusion.
 */

export type VolumeField = {
  key: string;
  label: string;
  countKey: string;
  hint: string;
};

/**
 * The four buckets, each with the item count that goes with it.
 *
 * Paired rather than listed separately because they are read together: a
 * volume with no count, or a count with no volume, is the shape of a
 * half-copied statement, and seeing them side by side is what makes that
 * obvious while typing.
 */
export const VOLUME_FIELDS: VolumeField[] = [
  {
    key: 'vmd_volume',
    countKey: 'vmd_item_count',
    label: 'Visa / Mastercard / Discover',
    hint: 'BIN sponsorship is assessed on this plus debit — Amex is not in it.',
  },
  {
    key: 'amex_volume',
    countKey: 'amex_item_count',
    label: 'Amex',
    hint: 'What the OptBlue fee is assessed on, by itself.',
  },
  {
    key: 'debit_volume',
    countKey: 'debit_item_count',
    label: 'PIN debit',
    hint: 'Counts towards BIN sponsorship alongside VMD.',
  },
  {
    key: 'ebt_volume',
    countKey: 'ebt_item_count',
    label: 'EBT',
    hint: 'Excluded from the Cash Discount / Surcharge programme.',
  },
];

/** Every hand-enterable key, in the order the form shows them. */
export const VOLUME_KEYS: readonly string[] = VOLUME_FIELDS.flatMap((f) => [f.key, f.countKey]);

/** What a volume row looks like once read back. */
export type VolumeRow = {
  mid: string;
  /** False means no row at all — a different claim from a row of zeros. */
  hasRow: boolean;
  merchantName: string | null;
  /** Money as text. Printed, never parsed. */
  amexVolume: string | null;
  vmdVolume: string | null;
  debitVolume: string | null;
  ebtVolume: string | null;
  amexItemCount: number | null;
  vmdItemCount: number | null;
  debitItemCount: number | null;
  ebtItemCount: number | null;
  /**
   * True when at least one bucket is NULL.
   *
   * Which is not the same as zero, and is why the engine withholds the
   * comparison rather than making it against a guess. A statement that really
   * shows no Amex volume should say 0, and somebody has to decide that.
   */
  anyBucketNull: boolean;
  /** 'pdf' for an imported row, 'manual' for one typed in. */
  source: string | null;
};

/**
 * Which fee items in a period are assessed on volume, and whether they are
 * mapped to buckets at all.
 *
 * An unmapped fee item is a different problem from a missing volume row: the
 * figure may be on file and the rule simply does not know which buckets to
 * add up. Both present as a withheld step-1 verdict, so they have to be
 * distinguishable.
 */
export type VolumeMappingRow = {
  feeItemName: string;
  lineCount: number;
  isMapped: boolean;
  buckets: string[] | null;
};
