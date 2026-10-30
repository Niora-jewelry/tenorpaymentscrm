/**
 * An agreement kind is configuration: which PDF, how each of its form fields
 * is filled from the CRM, which values are fixed, and where its signature
 * spots are. No code anywhere branches on a kind's name — a second agreement
 * (the ACH one) is another file shaped like this and a row in
 * `agreement_kinds`.
 */

export type CrmValues = Record<string, unknown>;

/** The CRM values an agreement reads: the record's values plus the per-field
 *  addresses (Inventory's off-site warehouse) and the notes bodies the
 *  spec prints ("If yes, please explain"). */
export type AgreementSource = {
  values: CrmValues;
  /** `field_addresses` rows for the record, by field key. */
  addresses: Record<string, unknown>;
  /** The latest note body per field key, for "If yes, please explain" boxes. */
  notes: Record<string, string>;
  /** Choice labels: field key + choice key → label. */
  label: (fieldKey: string, choiceKey: string) => string;
  /** When the agreement is sent — "years in business" counts to this day. */
  sentAt: Date;
};

/** Where a printed value came from, for the snapshot and the change banner. */
export type Used = { fieldKey: string; member?: string; index?: number; kind: 'value' | 'address' | 'note' };

/** One PDF field's fill: the text or check to print, and what it was read from. */
export type Fill = { text?: string; check?: boolean; used?: Used[] };

/** One row of the mapping: the PDF field name and how to fill it. */
export type MappingEntry = {
  pdf: string;
  /** `fieldKey` is recorded as used even when the fill is derived from several. */
  fill: (src: AgreementSource) => Fill;
};

export type PrincipalSlot = {
  slot: 1 | 2 | 3 | 4;
  /** PDF text fields holding the principal's own details (slot n). */
  fields: { pdf: string; fill: (owner: CrmValues, priv: CrmValues, src: AgreementSource) => string }[];
  /** The signature/date spots the e-sign service draws for this principal:
   *  the PDF text fields whose rectangles mark the spot. */
  signatures: { signature: string; date: string }[];
};

export type AgreementProblem = {
  /** The CRM field the user fixes; a repeat member names its group and index. */
  fieldKey: string;
  index?: number;
  member?: string;
  message: string;
};

export type AgreementKindDef = {
  key: string;
  label: string;
  /** The words in the file name: "[Legal name] - Merchant Agreement - Signed [date].pdf" (spec §8). */
  fileLabel: string;
  /** The words in the signer's email: {{agreement}} in the Presets subject and message. */
  emailLabel: string;
  /** File under src/lib/agreements/template/. */
  templateFile: string;
  /** The fields.json beside it, written by scripts/build-agreement-template.mjs. */
  fieldsFile: string;
  /** Checked against fields.json: bump when the PDF changes shape. */
  version: string;
  /** Fixed values the spec sets regardless of the CRM (checked or text). */
  fixed: Record<string, string | boolean>;
  mapping: MappingEntry[];
  principals: PrincipalSlot[];
  /** Pre-send rules beyond "required field is empty": returns problems. */
  check: (src: AgreementSource) => AgreementProblem[];
  /** Fields that must hold a value before a send (spec §5), with the message. */
  required: { fieldKey: string; label: string }[];
};
