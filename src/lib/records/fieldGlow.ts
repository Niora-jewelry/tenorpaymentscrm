/**
 * Field Highlight Glows (spec, 3 Nov 2026): which colour, if any, a field in the
 * drawer glows, and what the tab counters count.
 *
 * In one rule: a field glows only while it is empty, only inside the drawer's
 * tabs and sub-tabs, and its colour follows the stage of the application.
 *
 * Pure: values and configuration in, a colour out, so the glow can follow typing
 * without a reload and the browser and the tests read the same rules. Which
 * fields are required or optional is data (`fields.application_need` and
 * `agreement_need`, set in Presets). No field or module is named here.
 */
import { selectSigners, type OwnerInput } from '@/lib/agreements/signers';
import { noteIsNeeded, type GlowStage, type Need, type NoteWhen } from './fieldNeeds';

export type GlowKind = 'application_required' | 'application_optional' | 'agreement_required' | 'agreement_optional';

/** The words a tooltip and the legend use. */
export const GLOW_MEANING: Record<GlowKind, string> = {
  application_required: 'Required for application',
  application_optional: 'Optional for application',
  agreement_required: 'Required for agreement',
  agreement_optional: 'Optional for agreement',
};

/** The two colours a stage can show: required first. Nothing once an agreement has gone out. */
export function activeGlows(stage: GlowStage): GlowKind[] {
  if (stage === 'application') return ['application_required', 'application_optional'];
  if (stage === 'agreement') return ['agreement_required', 'agreement_optional'];
  return [];
}

function kindFor(stage: GlowStage, need: Need): GlowKind | null {
  if (stage === 'none' || need === 'none') return null;
  return `${stage}_${need}` as GlowKind;
}

export type GlowField = {
  type: string;
  applicationNeed?: Need;
  agreementNeed?: Need;
  agreementNoteNeed?: Need;
  agreementNoteWhen?: NoteWhen;
};

const needAt = (field: Pick<GlowField, 'applicationNeed' | 'agreementNeed'>, stage: GlowStage): Need =>
  stage === 'application' ? (field.applicationNeed ?? 'none') : stage === 'agreement' ? (field.agreementNeed ?? 'none') : 'none';

const textBlank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '');

/** Nothing anywhere inside it. A 0 and a false are answers; spaces are not. */
function nothingIn(v: unknown): boolean {
  if (textBlank(v)) return true;
  if (Array.isArray(v)) return v.every(nothingIn);
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).every(nothingIn);
  return false;
}

function splitTotal(v: unknown): number {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
  return Object.values(v as Record<string, unknown>).reduce<number>((sum, x) => {
    const n = Number(String(x ?? '').replace(/[%\s,]/g, ''));
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

/**
 * "Empty" as the agreement's pre-send check means it: 0 is filled, only spaces is
 * empty. A must-total-100% group stays empty until it totals 100 (the spec's
 * suggested answer to its open item). An address needs a street and a city, which
 * is the least the application will go out with.
 */
export function isEmptyValue(type: string, value: unknown): boolean {
  if (type === 'percent_split') return Math.abs(splitTotal(value) - 100) > 0.01;
  if (type === 'address') {
    const a = (value ?? {}) as Record<string, unknown>;
    return typeof value !== 'object' || textBlank(a.street) || textBlank(a.city);
  }
  return nothingIn(value);
}

/** A signer's home address has to be complete: nothing is left for them to type. */
const fullAddressMissing = (value: unknown) => {
  const a = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return textBlank(a.street) || textBlank(a.city) || textBlank(a.state) || textBlank(a.zip);
};

export type Glow = { kind: GlowKind; meaning: string; required: boolean };

const glow = (kind: GlowKind | null, suffix = ''): Glow | null =>
  kind ? { kind, meaning: `${GLOW_MEANING[kind]}${suffix}`, required: kind.endsWith('_required') } : null;

/** One ordinary field. `empty` lets a Files field answer for itself. */
export function fieldGlow(field: GlowField, stage: GlowStage, value: unknown, hasNote: boolean, empty = isEmptyValue(field.type, value)): Glow | null {
  if (empty) return glow(kindFor(stage, needAt(field, stage)));
  if (stage !== 'agreement' || hasNote) return null;
  const noteNeed = field.agreementNoteNeed ?? 'none';
  if (noteNeed === 'none' || !noteIsNeeded(field.agreementNoteWhen ?? null, value)) return null;
  return glow(kindFor(stage, noteNeed), ': add a note');
}

export type GlowMember = { key: string; type: string; application_need?: Need; agreement_need?: Need };

/**
 * The need of one member on one row of a repeat group. At the application stage
 * only the first row is required, because that is what the application goes out
 * on; further rows are optional. At the agreement stage a `signersOnly` group
 * asks only of the owners chosen to sign.
 */
function memberNeed(member: GlowMember, stage: GlowStage, rowIndex: number, signersOnly: boolean, signers: ReadonlySet<number>): Need {
  const need = needAt({ applicationNeed: member.application_need, agreementNeed: member.agreement_need }, stage);
  if (need === 'none') return need;
  if (stage === 'application') return need === 'required' && rowIndex > 0 ? 'optional' : need;
  if (stage === 'agreement' && signersOnly && !signers.has(rowIndex)) return 'none';
  return need;
}

function memberEmpty(member: GlowMember, stage: GlowStage, value: unknown): boolean {
  if (member.type === 'address' && stage === 'agreement') return fullAddressMissing(value);
  return isEmptyValue(member.type, value);
}

export function memberGlow(member: GlowMember, stage: GlowStage, rowIndex: number, signersOnly: boolean, signers: ReadonlySet<number>, value: unknown): Glow | null {
  if (!memberEmpty(member, stage, value)) return null;
  return glow(kindFor(stage, memberNeed(member, stage, rowIndex, signersOnly, signers)));
}

const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * The rows chosen to sign, by the agreement's own "who signs" rule, so this can
 * never disagree with what Send Agreement will do. Before any owner has a name or
 * a percentage nobody can be chosen, and the first row still has to be filled in.
 */
export function signerRows(rows: readonly Record<string, unknown>[]): Set<number> {
  const owners: OwnerInput[] = rows.map((r, index) => ({
    index,
    first: text(r.first),
    last: text(r.last),
    email: text(r.email),
    title: text(r.title),
    percentage: r.percentage as OwnerInput['percentage'],
  }));
  const { selected } = selectSigners(owners);
  return new Set(selected.length ? selected : [0]);
}

/** The shape the counters and the signer lookup read from a drawer tab. */
export type GlowGroup = {
  key: string;
  glowSignersOnly?: boolean;
  schema: GlowMember[];
  values: Record<string, unknown>[];
  count: number;
};

export const rowsOf = (group: Pick<GlowGroup, 'key' | 'values'>, liveValues: Record<string, unknown>): Record<string, unknown>[] => {
  const live = liveValues[group.key];
  return Array.isArray(live) ? (live as Record<string, unknown>[]) : group.values;
};

/**
 * Which rows sign, read from the visible group that holds the percentages. A
 * viewer who cannot see that group (Private but not Ownership) gets the first
 * row: the record's percentages are not in the page, and must not be sent to it
 * just to choose a colour.
 */
export function signersFor(groups: readonly GlowGroup[], liveValues: Record<string, unknown>): Set<number> {
  const holder = groups.find((g) => g.glowSignersOnly && g.schema.some((m) => m.key === 'percentage'));
  return holder ? signerRows(rowsOf(holder, liveValues)) : new Set([0]);
}

export type GlowCount = { have: number; need: number };

/**
 * A tab counter ("10 of 14"): the required fields at this stage, and how many of
 * them are done. Counts only what can glow as required, so a tab with none, or a
 * record whose agreement has gone out, has no counter at all.
 */
export function requiredCount(input: {
  stage: GlowStage;
  fields: readonly (GlowField & { id: string })[];
  groups: readonly GlowGroup[];
  signers: ReadonlySet<number>;
  liveValues: Record<string, unknown>;
  hasNote: (fieldKey: string) => boolean;
  isHidden?: (fieldKey: string) => boolean;
  emptyOverride?: (field: GlowField & { id: string }) => boolean | undefined;
}): GlowCount | null {
  const { stage, fields, groups, signers, liveValues, hasNote, isHidden, emptyOverride } = input;
  if (stage === 'none') return null;
  let need = 0;
  let open = 0;
  for (const f of fields) {
    if (isHidden?.(f.id) || needAt(f, stage) !== 'required') continue;
    need += 1;
    const value = liveValues[f.id];
    if (fieldGlow(f, stage, value, hasNote(f.id), emptyOverride?.(f) ?? isEmptyValue(f.type, value))?.required) open += 1;
  }
  for (const g of groups) {
    if (isHidden?.(g.key)) continue;
    const rows = rowsOf(g, liveValues);
    const count = Math.max(1, rows.length, g.count);
    for (let index = 0; index < count; index += 1) {
      for (const m of g.schema) {
        if (memberNeed(m, stage, index, Boolean(g.glowSignersOnly), signers) !== 'required') continue;
        need += 1;
        if (memberEmpty(m, stage, rows[index]?.[m.key])) open += 1;
      }
    }
  }
  return need ? { have: need - open, need } : null;
}
