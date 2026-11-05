import { describe, expect, it } from 'vitest';
import { activeGlows, fieldGlow, isEmptyValue, memberGlow, requiredCount, signerRows, signersFor, type GlowField, type GlowGroup, type GlowMember } from './fieldGlow';
import { noteIsNeeded } from './fieldNeeds';

const onBoth: GlowField = { type: 'text', applicationNeed: 'required', agreementNeed: 'optional' };

describe('the two colours of a stage', () => {
  it('orange and blue, then red and purple, then nothing', () => {
    expect(activeGlows('application')).toEqual(['application_required', 'application_optional']);
    expect(activeGlows('agreement')).toEqual(['agreement_required', 'agreement_optional']);
    expect(activeGlows('none')).toEqual([]);
  });
});

describe('a field glows only while it is empty', () => {
  it.each([
    ['null', null, true],
    ['nothing typed', '', true],
    ['only spaces', '   ', true],
    ['an empty multi-select', [], true],
    ['an empty object', {}, true],
    ['a value of 0', 0, false],
    ['the text 0', '0', false],
    ['a word', 'x', false],
    ['false', false, false],
  ])('%s', (_name, value, empty) => {
    expect(isEmptyValue('text', value)).toBe(empty);
  });

  it('turns off when filled and back on when cleared', () => {
    expect(fieldGlow(onBoth, 'application', '', false)?.kind).toBe('application_required');
    expect(fieldGlow(onBoth, 'application', 'x', false)).toBeNull();
    expect(fieldGlow(onBoth, 'application', '  ', false)?.kind).toBe('application_required');
  });

  it('a percentage group keeps glowing until it totals 100', () => {
    expect(isEmptyValue('percent_split', null)).toBe(true);
    expect(isEmptyValue('percent_split', { a: 40 })).toBe(true);
    expect(isEmptyValue('percent_split', { a: '60%', b: 40 })).toBe(false);
    expect(isEmptyValue('percent_split', { a: 100, b: 0 })).toBe(false);
    expect(isEmptyValue('percent_split', { a: 70, b: 40 })).toBe(true);
  });

  it('an address needs a street and a city', () => {
    expect(isEmptyValue('address', { street: '', city: '' })).toBe(true);
    expect(isEmptyValue('address', { street: '1 Main', city: ' ' })).toBe(true);
    expect(isEmptyValue('address', { street: '1 Main', city: 'Reno' })).toBe(false);
  });
});

describe('the colour follows the stage', () => {
  it('a field on both forms changes colour', () => {
    expect(fieldGlow(onBoth, 'application', '', false)?.kind).toBe('application_required');
    expect(fieldGlow(onBoth, 'agreement', '', false)?.kind).toBe('agreement_optional');
  });

  it('nothing once the agreement has gone out', () => {
    expect(fieldGlow(onBoth, 'none', '', false)).toBeNull();
  });

  it('a field on neither form never glows', () => {
    expect(fieldGlow({ type: 'text' }, 'application', '', false)).toBeNull();
    expect(fieldGlow({ type: 'text', applicationNeed: 'none', agreementNeed: 'none' }, 'agreement', '', false)).toBeNull();
  });

  it('says what it means in words', () => {
    expect(fieldGlow(onBoth, 'application', '', false)?.meaning).toBe('Required for application');
    expect(fieldGlow(onBoth, 'agreement', '', false)?.meaning).toBe('Optional for agreement');
  });
});

describe('conditional notes', () => {
  const bankruptcy: GlowField = { type: 'dropdown', agreementNeed: 'required', agreementNoteNeed: 'required', agreementNoteWhen: { in: ['yes', 'business'] } };
  const seasonal: GlowField = { type: 'dropdown', agreementNeed: 'required', agreementNoteNeed: 'optional', agreementNoteWhen: { not_in: ['no'] } };

  it('reads the value against the rule', () => {
    expect(noteIsNeeded({ in: ['yes'] }, 'yes')).toBe(true);
    expect(noteIsNeeded({ in: ['yes'] }, 'no')).toBe(false);
    expect(noteIsNeeded({ not_in: ['no'] }, ['jan'])).toBe(true);
    expect(noteIsNeeded({ not_in: ['no'] }, 'no')).toBe(false);
    expect(noteIsNeeded({ not_in: ['no'] }, '')).toBe(false);
    expect(noteIsNeeded(null, 'yes')).toBe(false);
  });

  it('Bankruptcy Yes without a note glows; with one it stops; No never asks', () => {
    expect(fieldGlow(bankruptcy, 'agreement', 'yes', false)?.meaning).toBe('Required for agreement: add a note');
    expect(fieldGlow(bankruptcy, 'agreement', 'yes', true)).toBeNull();
    expect(fieldGlow(bankruptcy, 'agreement', 'no', false)).toBeNull();
  });

  it('Seasonal asks unless it is No, and never blocks', () => {
    expect(fieldGlow(seasonal, 'agreement', 'yes', false)?.kind).toBe('agreement_optional');
    expect(fieldGlow(seasonal, 'agreement', 'no', false)).toBeNull();
  });

  it('a note rule belongs to the agreement stage only', () => {
    expect(fieldGlow(bankruptcy, 'application', 'yes', false)).toBeNull();
  });

  it('an empty field glows as the field, not as its note', () => {
    expect(fieldGlow(bankruptcy, 'agreement', '', false)?.meaning).toBe('Required for agreement');
  });
});

describe('repeat rows', () => {
  const email: GlowMember = { key: 'email', type: 'email', application_need: 'required', agreement_need: 'required' };
  const none = new Set<number>();

  it('application stage: the first row is required, further rows optional', () => {
    expect(memberGlow(email, 'application', 0, true, none, '')?.kind).toBe('application_required');
    expect(memberGlow(email, 'application', 1, true, none, '')?.kind).toBe('application_optional');
  });

  it('agreement stage: only the owners chosen to sign', () => {
    const signers = new Set([1]);
    expect(memberGlow(email, 'agreement', 1, true, signers, '')?.kind).toBe('agreement_required');
    expect(memberGlow(email, 'agreement', 0, true, signers, '')).toBeNull();
  });

  it('a signer needs a whole home address', () => {
    const address: GlowMember = { key: 'address', type: 'address', agreement_need: 'required' };
    const signers = new Set([0]);
    expect(memberGlow(address, 'agreement', 0, true, signers, { street: '1', city: 'R', state: 'NV' })?.required).toBe(true);
    expect(memberGlow(address, 'agreement', 0, true, signers, { street: '1', city: 'R', state: 'NV', zip: '89501' })).toBeNull();
  });
});

describe('who signs follows the agreement rule', () => {
  it('everyone at 25% or more, then the next largest up to 51%', () => {
    const rows = [{ first: 'A', percentage: 30 }, { first: 'B', percentage: 15 }, { first: 'C', percentage: 10 }, { first: 'D', percentage: 5 }];
    expect([...signerRows(rows)].sort()).toEqual([0, 1, 2]);
  });

  it('nobody chosen yet: the first row still has to be filled in', () => {
    expect([...signerRows([])]).toEqual([0]);
    expect([...signerRows([{}])]).toEqual([0]);
  });

  it('a viewer who cannot see the percentages gets the first row', () => {
    expect([...signersFor([], {})]).toEqual([0]);
  });

  it('reads the typed value, not the one the page loaded with', () => {
    const group: GlowGroup = {
      key: 'owners', glowSignersOnly: true, count: 2,
      schema: [{ key: 'percentage', type: 'percentage', agreement_need: 'required' }],
      values: [{ first: 'A', percentage: 100 }, { first: 'B', percentage: 0 }],
    };
    expect([...signersFor([group], {})]).toEqual([0]);
    expect([...signersFor([group], { owners: [{ first: 'A', percentage: 0 }, { first: 'B', percentage: 100 }] })]).toEqual([1]);
  });
});

describe('tab counters count only what glows as required', () => {
  const fields: (GlowField & { id: string })[] = [
    { id: 'a', type: 'text', applicationNeed: 'required' },
    { id: 'b', type: 'text', applicationNeed: 'required' },
    { id: 'c', type: 'text', applicationNeed: 'optional' },
    { id: 'd', type: 'text' },
  ];
  const base = { fields, groups: [], signers: new Set([0]), hasNote: () => false };

  it('leaves out optional and irrelevant fields', () => {
    expect(requiredCount({ ...base, stage: 'application', liveValues: { a: 'x', c: 'y', d: 'z' } })).toEqual({ have: 1, need: 2 });
  });

  it('follows typing', () => {
    expect(requiredCount({ ...base, stage: 'application', liveValues: { a: 'x', b: 'y' } })).toEqual({ have: 2, need: 2 });
    expect(requiredCount({ ...base, stage: 'application', liveValues: { a: '  ', b: 0 } })).toEqual({ have: 1, need: 2 });
  });

  it('no required fields here, or no glows at all: no counter', () => {
    expect(requiredCount({ ...base, stage: 'agreement', liveValues: {} })).toBeNull();
    expect(requiredCount({ ...base, stage: 'none', liveValues: {} })).toBeNull();
  });

  it('a hidden field is not counted', () => {
    expect(requiredCount({ ...base, stage: 'application', liveValues: {}, isHidden: (k) => k === 'b' })).toEqual({ have: 0, need: 1 });
  });

  it('a required note holds the field open', () => {
    const note: (GlowField & { id: string })[] = [{ id: 'n', type: 'text', agreementNeed: 'required', agreementNoteNeed: 'required', agreementNoteWhen: { in: ['yes'] } }];
    expect(requiredCount({ ...base, fields: note, stage: 'agreement', liveValues: { n: 'yes' } })).toEqual({ have: 0, need: 1 });
    expect(requiredCount({ ...base, fields: note, stage: 'agreement', liveValues: { n: 'yes' }, hasNote: () => true })).toEqual({ have: 1, need: 1 });
  });

  it('counts signers only, on every row they fill', () => {
    const group: GlowGroup = {
      key: 'owners', glowSignersOnly: true, count: 2, values: [],
      schema: [{ key: 'title', type: 'text', agreement_need: 'required' }, { key: 'dob', type: 'date', agreement_need: 'required' }],
    };
    expect(requiredCount({ ...base, fields: [], groups: [group], stage: 'agreement', signers: new Set([1]), liveValues: { owners: [{}, { title: 'CEO' }] } })).toEqual({ have: 1, need: 2 });
  });
});
