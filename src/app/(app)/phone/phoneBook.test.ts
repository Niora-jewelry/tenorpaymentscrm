import { describe, expect, it } from 'vitest';
import { callDuration, initials, isMissed, matches, nameBook } from './phoneBook';
import type { Contact } from '@/lib/phone/contacts';

const contact = (id: string, name: string, numbers: string[], company: string | null = null): Contact => ({
  id,
  displayName: name,
  company,
  email: null,
  notes: null,
  recordId: null,
  source: 'manual',
  numbers: numbers.map((e164, i) => ({ id: `${id}-${i}`, e164, label: null, isPrimary: i === 0 })),
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
});

describe('nameBook', () => {
  it('maps every number of every contact to its name', () => {
    const book = nameBook([contact('a', 'Dana Whitfield', ['+17323515922', '+12014481290'], 'Budget Max LLC')]);
    expect(book.get('+17323515922')).toEqual({ contactId: 'a', name: 'Dana Whitfield', company: 'Budget Max LLC' });
    expect(book.get('+12014481290')?.name).toBe('Dana Whitfield');
    expect(book.get('+19999999999')).toBeUndefined();
  });

  it('keeps the first contact when two share a number', () => {
    const book = nameBook([contact('a', 'First', ['+17323515922']), contact('b', 'Second', ['+17323515922'])]);
    expect(book.get('+17323515922')?.name).toBe('First');
  });
});

describe('matches', () => {
  it('matches everything when the search is empty', () => {
    expect(matches('  ', 'anything')).toBe(true);
  });
  it('matches words anywhere, ignoring case', () => {
    expect(matches('whit', 'Dana Whitfield')).toBe(true);
    expect(matches('WHIT', 'Dana Whitfield')).toBe(true);
    expect(matches('zz', 'Dana Whitfield')).toBe(false);
  });
  it('matches digits however the number was written', () => {
    expect(matches('732 351', '+17323515922')).toBe(true);
    expect(matches('(732) 351-5922', '+17323515922')).toBe(true);
    expect(matches('5555', '+17323515922')).toBe(false);
  });
  it('skips empty fields', () => {
    expect(matches('dana', null, undefined, 'Dana')).toBe(true);
  });
});

describe('initials', () => {
  it('takes first and last word', () => {
    expect(initials('Dana Q Whitfield')).toBe('DW');
  });
  it('takes two letters from one word', () => {
    expect(initials('rivka')).toBe('RI');
  });
  it('never returns empty', () => {
    expect(initials('   ')).toBe('?');
  });
});

describe('callDuration', () => {
  it('reads like a phone', () => {
    expect(callDuration(0)).toBe('0:00');
    expect(callDuration(24)).toBe('0:24');
    expect(callDuration(252)).toBe('4:12');
    expect(callDuration(null)).toBe('0:00');
  });
});

describe('isMissed', () => {
  it('is an incoming call nobody answered', () => {
    expect(isMissed({ direction: 'in', status: 'no-answer' })).toBe(true);
    expect(isMissed({ direction: 'in', status: 'completed' })).toBe(false);
    expect(isMissed({ direction: 'out', status: 'no-answer' })).toBe(false);
  });
});
