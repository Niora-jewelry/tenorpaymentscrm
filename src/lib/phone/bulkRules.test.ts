import { describe, expect, it } from 'vitest';
import { groupIdentity, isPersonAuthor, isUsLongCode, parseRecipients, splitNumbers } from './bulkRules';

describe('isUsLongCode', () => {
  it('takes a US or Canada local number', () => {
    expect(isUsLongCode('+17327241779')).toBe(true);
    expect(isUsLongCode('+14165550123')).toBe(true);
  });
  it.each(['+18005550123', '+18335550123', '+18445550123', '+18555550123', '+18665550123', '+18775550123', '+18885550123'])(
    'refuses toll-free %s',
    (n) => expect(isUsLongCode(n)).toBe(false),
  );
  it('refuses international numbers and short codes', () => {
    expect(isUsLongCode('+442071838750')).toBe(false);
    expect(isUsLongCode('+1234')).toBe(false);
    expect(isUsLongCode('12025550101')).toBe(false);
  });
});

describe('splitNumbers', () => {
  it('splits a pasted column and keeps spaces inside a number', () => {
    expect(splitNumbers('(732) 724-1779\r\n732 555 0100, +17325550101;\t7325550102\n\n')).toEqual([
      '(732) 724-1779',
      '732 555 0100',
      '+17325550101',
      '7325550102',
    ]);
  });
  it('reads nothing as nothing', () => expect(splitNumbers(' \n ,, ')).toEqual([]));
});

describe('parseRecipients', () => {
  it('removes duplicates however they were typed, and keeps what cannot be read', () => {
    const r = parseRecipients(['(732) 724-1779', '+17327241779', '7327241779', 'not a number', '12']);
    expect(r.numbers).toEqual(['+17327241779']);
    expect(r.duplicates).toBe(2);
    expect(r.invalid).toEqual(['not a number', '12']);
  });
});

describe('isPersonAuthor', () => {
  it('takes a person texting in', () => expect(isPersonAuthor('+17327241779', 'SMS')).toBe(true));
  it('takes a person when Twilio names no source', () => expect(isPersonAuthor('+17327241779', undefined)).toBe(true));
  it('ignores the CRM line', () => expect(isPersonAuthor(groupIdentity('g1'), 'SMS')).toBe(false));
  it('ignores anything sent through the API', () => {
    expect(isPersonAuthor('+17327241779', 'API')).toBe(false);
    expect(isPersonAuthor('+17327241779', 'SDK')).toBe(false);
  });
  it('ignores a missing author', () => expect(isPersonAuthor(undefined, 'SMS')).toBe(false));
});
