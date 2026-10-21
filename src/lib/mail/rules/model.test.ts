import { describe, it, expect } from 'vitest';
import { ACTIONS, PREDICATES, blankValue, fromGraph, planSequences, summary, toGraph, validate, type GraphRule, type RuleForm } from './model';

const rule: GraphRule = {
  id: 'r1',
  displayName: 'Clients to folder',
  sequence: 2,
  isEnabled: true,
  conditions: {
    fromAddresses: [{ emailAddress: { name: 'Ann', address: 'Ann@Client.example' } }],
    subjectContains: ['invoice', '  ', 'order'],
    hasAttachments: true,
    sentToMe: false,
    withinSizeRange: { minimumSize: 10, maximumSize: 500 },
    importance: 'high',
    someFuturePredicate: ['kept'],
    '@odata.type': '#microsoft.graph.messageRulePredicates',
  },
  exceptions: { isAutomaticReply: true },
  actions: { moveToFolder: 'fld-clients', markAsRead: true, stopProcessingRules: true, assignCategories: [] },
};

describe('rules model', () => {
  it('catalogues every documented predicate and action exactly once', () => {
    expect(new Set(PREDICATES.map((p) => p.key)).size).toBe(PREDICATES.length);
    expect(PREDICATES).toHaveLength(30);
    expect(new Set(ACTIONS.map((a) => a.key)).size).toBe(ACTIONS.length);
    expect(ACTIONS).toHaveLength(11);
  });

  it('reads a Graph rule into rows, in catalogue order, keeping what it cannot show', () => {
    const f = fromGraph(rule);
    expect(f.name).toBe('Clients to folder');
    expect(f.conditions.map((r) => r.key)).toEqual(['fromAddresses', 'subjectContains', 'hasAttachments', 'importance', 'withinSizeRange']);
    expect(f.conditions[0].value).toEqual({ kind: 'people', people: [{ name: 'Ann', address: 'ann@client.example' }] });
    expect(f.conditions[1].value).toEqual({ kind: 'words', words: ['invoice', 'order'] });
    expect(f.extra.conditions).toEqual({ someFuturePredicate: ['kept'] });
    expect(f.exceptions.map((r) => r.key)).toEqual(['isAutomaticReply']);
    expect(f.actions.map((r) => r.key)).toEqual(['moveToFolder', 'markAsRead', 'stopProcessingRules']);
  });

  it('round-trips: unchanged form → same predicates and actions, unknown ones intact', () => {
    const g = toGraph(fromGraph(rule), rule);
    expect(g.conditions).toEqual({
      fromAddresses: [{ emailAddress: { address: 'ann@client.example', name: 'Ann' } }],
      subjectContains: ['invoice', 'order'],
      hasAttachments: true,
      importance: 'high',
      withinSizeRange: { minimumSize: 10, maximumSize: 500 },
      someFuturePredicate: ['kept'],
      sentToMe: null,
    });
    expect(g.actions).toEqual({ moveToFolder: 'fld-clients', markAsRead: true, stopProcessingRules: true, assignCategories: null });
  });

  it('a removed row is cleared in Outlook (sent as null), not left behind', () => {
    const f = fromGraph(rule);
    f.conditions = f.conditions.filter((r) => r.key !== 'hasAttachments');
    expect(toGraph(f, rule).conditions?.hasAttachments).toBeNull();
  });

  it('validates what Outlook would refuse or what makes no sense', () => {
    const empty: RuleForm = { name: ' ', enabled: true, conditions: [], exceptions: [], actions: [], extra: { conditions: {}, exceptions: {}, actions: {} } };
    expect(validate(empty)).toEqual(['Give the rule a name.', 'Add at least one action.']);
    const f: RuleForm = {
      ...empty,
      name: 'x',
      conditions: [{ key: 'subjectContains', value: blankValue('words') }, { key: 'withinSizeRange', value: { kind: 'size', min: 9, max: 2 } }],
      actions: [{ key: 'moveToFolder', value: blankValue('folder') }, { key: 'delete', value: { kind: 'flag' } }, { key: 'permanentDelete', value: { kind: 'flag' } }],
    };
    expect(validate(f)).toEqual([
      'Add at least one word for “subject includes”.',
      'The smallest size can’t be more than the largest.',
      'Choose a folder for “move to folder”.',
      'Choose either “Move to Deleted Items” or “Delete permanently”, not both.',
    ]);
    expect(validate(fromGraph(rule))).toEqual([]);
  });

  it('summarises a rule in one line', () => {
    expect(summary(fromGraph(rule), (id) => (id === 'fld-clients' ? 'Clients' : '?'))).toBe(
      'From Ann and Subject includes “invoice”, “order” and Has an attachment and Importance is high and Size is between 10–500 KB → Move to Clients, Mark as read, Stop processing more rules',
    );
    expect(summary({ ...fromGraph({ actions: { markAsRead: true } }) }, () => '')).toBe('Every message → Mark as read');
  });

  it('reorders with the fewest writes, never touching a read-only rule', () => {
    const cur = new Map([
      ['a', { sequence: 1, readOnly: false }],
      ['ro', { sequence: 10, readOnly: true }],
      ['b', { sequence: 11, readOnly: false }],
    ]);
    expect(planSequences(['a', 'b', 'ro'], cur)).toEqual({ changes: [{ id: 'b', sequence: 2 }] });
    expect(planSequences(['b', 'a', 'ro'], cur)).toEqual({ changes: [{ id: 'b', sequence: 1 }, { id: 'a', sequence: 2 }] });
    expect(planSequences(['a', 'ro', 'b'], cur)).toEqual({ changes: [] });
    const tight = new Map([
      ['a', { sequence: 1, readOnly: false }],
      ['ro', { sequence: 2, readOnly: true }],
      ['b', { sequence: 3, readOnly: false }],
    ]);
    expect(planSequences(['a', 'b', 'ro'], tight)).toEqual({ blockedBy: 'ro' });
    expect(planSequences(['ro', 'a', 'b'], tight)).toEqual({ changes: [{ id: 'a', sequence: 3 }, { id: 'b', sequence: 4 }] });
  });
});
