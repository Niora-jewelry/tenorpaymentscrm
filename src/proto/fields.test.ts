/**
 * The key/label resolution every choice-backed value passes through.
 *
 * This is small enough to look unnecessary and is not: the bug it pins down
 * shipped, survived two phases of review and two browser passes, and was
 * completely silent. `records.values` stores a choice's KEY, but the adapter
 * dropped it and handed the UI the label as the option's only identity — so
 * every status and dropdown cell printed its raw stored key with no swatch,
 * the drawer's picker could not show the current selection at all, and
 * choosing an option wrote the label back into a key-shaped column. Nothing
 * errored at any point.
 *
 * `adapter.test.ts` covers the other half — that the key survives the DB →
 * prototype mapping in both scopes.
 */
import { describe, it, expect } from 'vitest';
import { choiceKey, choiceLabel, choicesFor } from './fields';
import type { Choice, Field } from './schema';

const field = (over: Partial<Field> = {}): Field => ({
  id: 'current_status',
  label: 'Current Status',
  type: 'status',
  tab: 'overview',
  columnIn: [],
  ...over,
});

describe('choiceKey', () => {
  it('is the key when there is one — the real app always has one', () => {
    expect(choiceKey({ key: 'new_lead', value: 'New lead' })).toBe('new_lead');
  });

  it('falls back to the label for a prototype choice, which has no key', () => {
    // `src/proto/fields.ts` builds its fixtures with `c('IC+', 'DP', 'FR')` —
    // label-only, and its fixture records store those labels. The fallback is
    // what lets one set of components serve both identity models.
    expect(choiceKey({ value: 'IC+' })).toBe('IC+');
  });
});

describe('choiceLabel', () => {
  const options: Choice[] = [
    { key: 'new_lead', value: 'New lead' },
    { key: 'working', value: 'Working' },
  ];

  it('resolves a stored key to its current display label', () => {
    expect(choiceLabel(options, 'new_lead')).toBe('New lead');
  });

  it('follows a rename without touching the stored value — the whole point', () => {
    const renamed: Choice[] = [{ key: 'new_lead', value: 'Fresh lead' }];
    expect(choiceLabel(renamed, 'new_lead')).toBe('Fresh lead');
  });

  it('shows the raw value when nothing resolves, rather than blanking it', () => {
    // Reached by a record holding a key whose option was never created, or was
    // created in another module's scope. Printing what is really stored is the
    // honest answer: an admin who sees a key where a label belongs can go and
    // add the missing option. A blank would just look like no value.
    expect(choiceLabel(options, 'retired_status')).toBe('retired_status');
  });

  it('passes a months value straight through — those have no choice rows behind them', () => {
    expect(choiceLabel([], 'March')).toBe('March');
  });

  it('handles a non-string stored value without throwing', () => {
    expect(choiceLabel(options, null)).toBe('null');
  });
});

describe('choicesFor', () => {
  const global: Choice[] = [{ key: 'urgent', value: 'Urgent' }];
  const leads: Choice[] = [{ key: 'new_lead', value: 'New lead' }];

  it('returns the module set INSTEAD OF the global one — it is not a merge', () => {
    // The single most dangerous property of this data model, and the reason
    // `adminChoices.createModuleOverride` copies the whole global set: an
    // override with one row makes that module offer exactly one option.
    const f = field({ choices: global, choicesByModule: { leads } });
    expect(choicesFor(f, 'leads')).toEqual(leads);
    expect(choicesFor(f, 'leads')).not.toContainEqual(global[0]);
  });

  it('falls back to the global set for a module with no override', () => {
    const f = field({ choices: global, choicesByModule: { leads } });
    expect(choicesFor(f, 'deals')).toEqual(global);
  });

  it('is empty, not undefined, for a field with no choices at all', () => {
    expect(choicesFor(field(), 'leads')).toEqual([]);
  });
});
