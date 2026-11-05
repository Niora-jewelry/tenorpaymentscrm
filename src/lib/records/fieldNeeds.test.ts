import { describe, expect, it } from 'vitest';
import { glowStageFrom, noteIsNeeded } from './fieldNeeds';
import { isFilled, requiredFlagProblems } from './fieldProblems';
import type { Config } from './config';

describe('glowStageFrom (the spec\'s stage table)', () => {
  it('no application sent yet: orange and blue', () => {
    expect(glowStageFrom(null, null)).toBe('application');
  });

  it.each(['sent', 'opened', 'submitted', 'pdf_uploaded', 'reviewed'])('application %s: red and purple', (status) => {
    expect(glowStageFrom(status, null)).toBe('agreement');
  });

  it.each(['voided', 'expired'])('application %s: back to orange and blue', (status) => {
    expect(glowStageFrom(status, null)).toBe('application');
  });

  it.each(['sending', 'sent', 'viewed', 'partially_signed', 'completed', 'declined', 'expired', 'delivery_failed'])(
    'agreement %s: no glows, whatever the application says',
    (status) => {
      expect(glowStageFrom('sent', status)).toBe('none');
      expect(glowStageFrom(null, status)).toBe('none');
    },
  );

  it('a voided agreement gives the stage back to the application', () => {
    expect(glowStageFrom('reviewed', 'voided')).toBe('agreement');
    expect(glowStageFrom('voided', 'voided')).toBe('application');
    expect(glowStageFrom(null, 'voided')).toBe('application');
  });
});

describe('noteIsNeeded', () => {
  const bankruptcy = { in: ['yes', 'business', 'personal'] };
  const seasonal = { not_in: ['No'] };

  it('a dropdown: only the listed choices', () => {
    expect(noteIsNeeded(bankruptcy, 'business')).toBe(true);
    expect(noteIsNeeded(bankruptcy, 'never')).toBe(false);
  });

  it('a months field: anything other than No', () => {
    expect(noteIsNeeded(seasonal, ['Jan', 'Feb'])).toBe(true);
    expect(noteIsNeeded(seasonal, ['No'])).toBe(false);
  });

  it('an empty field never needs its note', () => {
    for (const empty of [null, undefined, '', '   ', []]) {
      expect(noteIsNeeded(bankruptcy, empty)).toBe(false);
      expect(noteIsNeeded(seasonal, empty)).toBe(false);
    }
  });

  it('no rule, no note', () => {
    expect(noteIsNeeded(null, 'business')).toBe(false);
    expect(noteIsNeeded(undefined, 'business')).toBe(false);
  });
});

describe('requiredFlagProblems with a form list', () => {
  const field = (key: string, required: boolean, applicationNeed: string) => ({ key, required, applicationNeed, label: key });
  const config = {
    fields: [field('flagged', true, 'none'), field('listed', false, 'required'), field('optional', false, 'optional')],
  } as unknown as Config;
  const keys = ['flagged', 'listed', 'optional'];

  it('defaults to the old Required flag, so other documents are unchanged', () => {
    expect(requiredFlagProblems(config, {}, keys, new Set()).map((p) => p.fieldKey)).toEqual(['flagged']);
  });

  it('a form can pass its own list', () => {
    const problems = requiredFlagProblems(config, {}, keys, new Set(), (f) => f.required || f.applicationNeed === 'required');
    expect(problems.map((p) => p.fieldKey)).toEqual(['flagged', 'listed']);
  });

  it('a field the sender cannot see is named without its value', () => {
    const [problem] = requiredFlagProblems(config, { listed: 'secret' }, ['listed'], new Set(['listed']), (f) => f.applicationNeed === 'required');
    expect(problem?.message).toContain('can’t see');
    expect(JSON.stringify(problem)).not.toContain('secret');
  });

  it('0 counts as filled, spaces only as empty', () => {
    expect(isFilled(0)).toBe(true);
    expect(isFilled('   ')).toBe(false);
  });
});
