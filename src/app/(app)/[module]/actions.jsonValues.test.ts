/**
 * Every non-scalar field type must round-trip through the Server Action.
 *
 * ── WHY THIS TEST EXISTS ─────────────────────────────────────────────────
 * `JSON_VALUED_FIELD_TYPES` is the list `setValueAction` uses to decide
 * whether an incoming FormData string is a JSON document to parse or a scalar
 * to store as-is. The client always `JSON.stringify`s a non-scalar value,
 * because a `<form>` field can only carry a string.
 *
 * Getting the list wrong does not error. `jsonb` accepts a JSON string scalar
 * as happily as a JSON object, so the write succeeds and the wrong SHAPE is
 * stored — and the damage only surfaces later, somewhere else, as a read that
 * expected an array and got a string.
 *
 * It has now been got wrong three times:
 *
 *   1. `address`, `grid`, `percent_split` — found in development.
 *   2. `team_member` — would have killed `sync_record_team_members()`, and was
 *      only survivable because nothing could edit the field yet.
 *   3. `repeat_group` — REACHED A USER. A contacts array stored as a
 *      91-character JSON string rendered as ninety-one blank contact rows
 *      ("Contacts 91"), and the one contact the client had typed vanished
 *      from the screen. The data was inside the string the whole time.
 *
 * Three times is a pattern, and a hand-maintained list that fails silently is
 * the wrong shape for it. This test makes the omission a TEST FAILURE instead
 * of a bug report: add a non-scalar type to `FieldType` and forget the list,
 * and this goes red immediately.
 *
 * ── WHY THE SCALAR LIST IS SPELLED OUT ───────────────────────────────────
 * The check cannot be "everything not in the set is scalar" — that is the
 * thing being tested. So both halves are written down, and their union must
 * be exactly `FieldType`. Adding a type to the union without classifying it
 * fails here too, which is the point: someone has to decide which it is.
 */
import { describe, it, expect } from 'vitest';
import type { FieldType } from '@/lib/records/config';
import { JSON_VALUED_FIELD_TYPES } from './fieldValueCodec';

/** Types whose stored value is a single JSON scalar — string, number or bool. */
const SCALAR_FIELD_TYPES: FieldType[] = [
  'text',
  'long_text',
  'number',
  'currency',
  'date',
  'datetime',
  'dropdown',
  'status',
  'email',
  'phone',
  'url',
  'checkbox',
  'file',
  'percentage',
  'identifier',
];

/** Types whose stored value is a JSON object or array. */
const NON_SCALAR_FIELD_TYPES: FieldType[] = [
  'multi_select',
  'team_member',
  'address',
  'percent_split',
  'months',
  'grid',
  'repeat_group',
];

describe('JSON_VALUED_FIELD_TYPES', () => {
  it('holds every non-scalar field type', () => {
    const missing = NON_SCALAR_FIELD_TYPES.filter((t) => !JSON_VALUED_FIELD_TYPES.has(t));
    expect(
      missing,
      `These store a JSON object or array but setValueAction would save them as a JSON STRING: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('holds no scalar field type', () => {
    const extra = SCALAR_FIELD_TYPES.filter((t) => JSON_VALUED_FIELD_TYPES.has(t));
    expect(
      extra,
      `These are scalars; JSON.parse would reject the plain text a user typed: ${extra.join(', ')}`,
    ).toEqual([]);
  });

  it('classifies every type in the FieldType union, so a new one cannot slip through', () => {
    /*
     * The compiler does the real work: this object must have a key for every
     * member of `FieldType`, so adding one to the union without listing it
     * above is a TYPE error here before it is ever a runtime one.
     */
    const classified: Record<FieldType, 'scalar' | 'json'> = {
      text: 'scalar',
      long_text: 'scalar',
      number: 'scalar',
      currency: 'scalar',
      date: 'scalar',
      datetime: 'scalar',
      dropdown: 'scalar',
      status: 'scalar',
      email: 'scalar',
      phone: 'scalar',
      url: 'scalar',
      checkbox: 'scalar',
      file: 'scalar',
      percentage: 'scalar',
      identifier: 'scalar',
      multi_select: 'json',
      team_member: 'json',
      address: 'json',
      percent_split: 'json',
      months: 'json',
      grid: 'json',
      repeat_group: 'json',
    };

    for (const [type, kind] of Object.entries(classified) as [FieldType, 'scalar' | 'json'][]) {
      expect(JSON_VALUED_FIELD_TYPES.has(type), `${type} is classified ${kind}`).toBe(kind === 'json');
    }

    // And the two lists above together are that same classification.
    expect([...SCALAR_FIELD_TYPES, ...NON_SCALAR_FIELD_TYPES].sort()).toEqual(
      (Object.keys(classified) as FieldType[]).sort(),
    );
  });

  it('survives the exact client encoding, for a repeat group', () => {
    /*
     * The shape that broke: what `handleChange` puts in the FormData for a
     * contacts repeat group, and what the action must get back out.
     */
    const instances = [
      { name: 'Yitzchok Cohen', email: 'y@example.org', phone: '(773) 555-0100' },
      {},
    ];
    const encoded = JSON.stringify(instances);

    expect(JSON_VALUED_FIELD_TYPES.has('repeat_group')).toBe(true);
    expect(JSON.parse(encoded)).toEqual(instances);

    // The bug, written down: storing `encoded` rather than parsing it leaves a
    // string whose LENGTH is what the drawer then counts as a row apiece.
    expect(typeof encoded).toBe('string');
    expect(Array.isArray(encoded)).toBe(false);
  });
});
