/**
 * Repeat groups (Owners, Contacts, Affiliates) — "can click a button to add
 * new owner, up to 5 owners." The real DB stores a repeatable set as one
 * JSONB array per `fields` row (`records.values[groupField.key]`), unlike
 * the prototype's flat numbered keys (`owner_1_first`…`owner_5_first`) —
 * SCHEMA-DECISIONS §1. A single member-value edit is just an ordinary field
 * write (one array, one key) and reuses `setValueAction`/`setValue`
 * unchanged; this file exists for the one thing that ISN'T ordinary:
 * add/remove instance has to touch every `fields` row sharing a
 * `repeatGroupKey` (migration 27) atomically-ish, since 'owner' is really
 * one logical set split across two locations (Private holds SSN, Ownership
 * holds the rest) and both arrays must stay the same length.
 */
import 'server-only';
import type { AuthContext } from './permissions';
import type { Field } from './config';
import { fieldCapsFor } from './tabAccess';
import { setValue } from './records';

type Instance = Record<string, unknown>;

function arrayFor(values: Record<string, unknown>, key: string): Instance[] {
  const v = values[key];
  return Array.isArray(v) ? (v as Instance[]) : [];
}

/** A record always has at least one instance, even with zero stored data —
 * matches the prototype's "a record always has one" convention exactly. */
export function repeatInstanceCount(values: Record<string, unknown>, siblingKeys: string[]): number {
  return Math.max(1, ...siblingKeys.map((k) => arrayFor(values, k).length));
}

export type RepeatMutationResult = { ok: true; updatedAt: string } | { ok: false; message: string };

/** Every sibling must be individually edit-granted before ANY write happens
 * — partial success would desync the arrays permanently (one location gains
 * "Owner 3", the other doesn't), which is worse than refusing outright. */
async function requireEditOnAll(
  ctx: AuthContext,
  recordId: string,
  siblings: Field[],
): Promise<string | null> {
  // The full per-record chain, not the field's global grant: a repeat group
  // lives on a tab and in a module, and either can close it.
  const caps = await Promise.all(
    siblings.map(async (f) => [f, (await fieldCapsFor(ctx, [recordId], f)).get(recordId)] as const),
  );
  for (const [f, grant] of caps) {
    if (grant !== 'edit') return `No edit access to ${f.label}`;
  }
  return null;
}

export async function addRepeatInstance(
  ctx: AuthContext,
  recordId: string,
  siblings: Field[],
  currentValues: Record<string, unknown>,
  currentUpdatedAt: string,
  max: number,
): Promise<RepeatMutationResult> {
  const denied = await requireEditOnAll(ctx, recordId, siblings);
  if (denied) return { ok: false, message: denied };

  const count = repeatInstanceCount(currentValues, siblings.map((s) => s.key));
  if (count >= max) return { ok: false, message: `The sheet caps this at ${max}.` };

  let at = currentUpdatedAt;
  for (const field of siblings) {
    const arr = arrayFor(currentValues, field.key);
    // Pad short arrays up to `count` first — a sibling whose array is
    // shorter than the group's true instance count (e.g. it was never
    // written to for an earlier instance) still gets a same-length array.
    const padded = [...arr, ...Array.from({ length: Math.max(0, count - arr.length) }, () => ({}) as Instance)];
    const result = await setValue(ctx, recordId, field, [...padded, {}], at);
    if (!result.ok) return { ok: false, message: 'Someone else changed this record a moment ago — refresh and try again.' };
    at = result.updatedAt;
  }
  return { ok: true, updatedAt: at };
}

export async function removeRepeatInstance(
  ctx: AuthContext,
  recordId: string,
  siblings: Field[],
  currentValues: Record<string, unknown>,
  currentUpdatedAt: string,
  index: number,
): Promise<RepeatMutationResult> {
  if (index === 0) return { ok: false, message: 'The first instance cannot be removed.' };

  const denied = await requireEditOnAll(ctx, recordId, siblings);
  if (denied) return { ok: false, message: denied };

  let at = currentUpdatedAt;
  for (const field of siblings) {
    const arr = arrayFor(currentValues, field.key);
    const next = arr.filter((_, i) => i !== index);
    const result = await setValue(ctx, recordId, field, next, at);
    if (!result.ok) return { ok: false, message: 'Someone else changed this record a moment ago — refresh and try again.' };
    at = result.updatedAt;
  }
  return { ok: true, updatedAt: at };
}
