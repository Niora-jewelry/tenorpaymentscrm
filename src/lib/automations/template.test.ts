import { describe, expect, it } from 'vitest';
import { bodyHtml, fill, toLabels, toTokens } from './template';

const fields = [{ key: 'mid', label: 'MID' }, { key: 'dba_name', label: 'DBA name' }];
const v = { contact: 'Sam Rivera', merchant: 'Casa Verde', field: (k: string) => (k === 'mid' ? '123' : '') };

describe('labels and keys', () => {
  it('stores a field by key and reads it back by label', () => {
    const stored = toTokens('Your {MID} and {dba name}', fields);
    expect(stored).toEqual({ text: 'Your {field:mid} and {field:dba_name}', unknown: [] });
    expect(toLabels(stored.text, fields)).toBe('Your {MID} and {DBA name}');
  });

  it('keeps the two named variables as they are, in any case', () => {
    expect(toTokens('{contact name} at {MERCHANT NAME}', fields).text).toBe('{Contact name} at {Merchant name}');
  });

  it('names a variable that means nothing', () => {
    expect(toTokens('Hi {Favourite colour}', fields).unknown).toEqual(['Favourite colour']);
  });

  it('survives a field being renamed', () => {
    expect(toLabels('{field:mid}', [{ key: 'mid', label: 'Merchant ID' }])).toBe('{Merchant ID}');
  });
});

describe('filling in', () => {
  it('fills all three kinds', () => {
    expect(fill('{Contact name}, {Merchant name}, {field:mid}', v)).toBe('Sam Rivera, Casa Verde, 123');
  });

  it('leaves an empty value empty', () => {
    expect(fill('[{field:dba_name}]', v)).toBe('[]');
  });

  it('does not read a value as a replacement pattern', () => {
    expect(fill('{Merchant name}', { ...v, merchant: '$& Sons' })).toBe('$& Sons');
  });
});

describe('the HTML body', () => {
  it('keeps paragraphs and line breaks', () => {
    expect(bodyHtml('One\ntwo\n\nThree', v)).toBe('<p>One<br>two</p><p>Three</p>');
  });

  it('escapes what the admin wrote and what the record holds', () => {
    const html = bodyHtml('<b>{Merchant name}</b>', { ...v, merchant: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
  });
});
