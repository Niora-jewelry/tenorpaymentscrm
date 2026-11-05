import { describe, expect, it } from 'vitest';
import { billedByChoices, displayValue, EQUIPMENT_COLUMNS, normalizeProviderName, parseColumnValue, providerNameTaken } from './columns';

const value = (kind: Parameters<typeof parseColumnValue>[0], raw: unknown) => {
  const r = parseColumnValue(kind, raw);
  return r.ok ? r.value : `REFUSED`;
};

describe('the eleven columns', () => {
  it('are in the order the spec gives', () => {
    expect(EQUIPMENT_COLUMNS.map((c) => c.column)).toEqual([
      'provider_id', 'billed_by', 'billed_to', 'item', 'item_amount',
      'monthly_fee', 'per_item_fee', 'one_time_fee', 'volume_fee', 'notes', 'proposal',
    ]);
  });
});

describe('blank is nothing, never 0', () => {
  it.each(['money', 'percent', 'whole', 'text', 'long_text', 'provider', 'billed_by', 'billed_to'] as const)('%s', (kind) => {
    expect(value(kind, '')).toBeNull();
    expect(value(kind, '   ')).toBeNull();
    expect(value(kind, null)).toBeNull();
  });

  it('a typed 0 is a 0', () => {
    expect(value('money', '0')).toBe('0.00');
    expect(value('whole', '0')).toBe(0);
    expect(value('percent', '0')).toBe('0');
  });

  it('draws blank as blank', () => {
    expect(displayValue('money', null)).toBe('');
    expect(displayValue('percent', undefined)).toBe('');
    expect(displayValue('money', 0)).toBe('0.00');
  });
});

describe('money', () => {
  it.each([
    ['12', '12.00'],
    ['12.5', '12.50'],
    ['$1,250.75', '1250.75'],
    ['.5', '0.50'],
    ['007', '7.00'],
  ])('%s is %s', (raw, want) => expect(value('money', raw)).toBe(want));

  it.each(['abc', '1.234', '-5', '12345678901', '.'])('refuses %s', (raw) => expect(value('money', raw)).toBe('REFUSED'));

  it('draws with two decimals', () => expect(displayValue('money', 12.5)).toBe('12.50'));
});

describe('whole number', () => {
  it('takes commas', () => expect(value('whole', '1,200')).toBe(1200));
  it.each(['1.5', '-1', 'x', '99999999999'])('refuses %s', (raw) => expect(value('whole', raw)).toBe('REFUSED'));
});

describe('percentage', () => {
  it.each([
    ['2.5', '2.5'],
    ['2.5%', '2.5'],
    ['100', '100'],
    ['.25', '0.25'],
  ])('%s is %s', (raw, want) => expect(value('percent', raw)).toBe(want));
  it.each(['100.01', '-1', 'x', '1.23456'])('refuses %s', (raw) => expect(value('percent', raw)).toBe('REFUSED'));
});

describe('the rest', () => {
  it('text is trimmed and capped', () => {
    expect(value('text', '  Terminal ')).toBe('Terminal');
    expect(value('text', 'x'.repeat(201))).toBe('REFUSED');
    expect(value('long_text', 'x'.repeat(2001))).toBe('REFUSED');
  });
  it('choices are only the choices', () => {
    expect(value('billed_by', 'tenor')).toBe('tenor');
    expect(value('billed_by', 'NMI')).toBe('REFUSED');
    expect(value('billed_to', 'iso')).toBe('iso');
    expect(value('billed_to', 'tenor')).toBe('REFUSED');
  });
  it('a provider is an id, never a name', () => {
    expect(value('provider', '00000000-0000-4000-8000-000000000001')).toBe('00000000-0000-4000-8000-000000000001');
    expect(value('provider', 'NMI')).toBe('REFUSED');
  });
  it('the checkbox is a yes or no', () => {
    expect(value('checkbox', true)).toBe(true);
    expect(value('checkbox', false)).toBe(false);
    expect(value('checkbox', null)).toBe(false);
    expect(value('checkbox', 'yes')).toBe('REFUSED');
  });
  it('refuses an object anywhere', () => {
    expect(value('money', { a: 1 })).toBe('REFUSED');
    expect(value('text', ['x'])).toBe('REFUSED');
  });
});

describe('Billed by', () => {
  const values = (...args: Parameters<typeof billedByChoices>) => billedByChoices(...args).map((c) => c.label);

  it('only Tenor until a provider is picked', () => {
    expect(values(null, true, null)).toEqual(['Tenor']);
  });
  it('the second choice is the current provider', () => {
    expect(billedByChoices('NMI', true, null)).toEqual([{ value: 'tenor', label: 'Tenor' }, { value: 'provider', label: 'NMI' }]);
  });
  it('follows the provider rather than storing a name', () => {
    expect(values('Valor', true, 'provider')).toEqual(['Tenor', 'Valor']);
  });
  it('the provider being Tenor offers one, not two the same', () => {
    expect(values('Tenor', true, null)).toEqual(['Tenor']);
    expect(values('tenor', true, 'provider')).toEqual(['tenor']);
  });
  it('a hidden provider column never gives the name away', () => {
    expect(values(null, false, null)).toEqual(['Tenor']);
    expect(values(null, false, 'provider')).toEqual(['Tenor', 'Provider on this row']);
  });
});

describe('provider names', () => {
  it('tidies spaces', () => expect(normalizeProviderName('  Blue   Sky ')).toBe('Blue Sky'));
  it('sees a duplicate through case and spaces', () => {
    const list = [{ name: 'Accept.blue' }, { name: 'NMI' }];
    expect(providerNameTaken('nmi', list)).toBe(true);
    expect(providerNameTaken(' ACCEPT.BLUE ', list)).toBe(true);
    expect(providerNameTaken('Blue Sky', list)).toBe(false);
  });
});
