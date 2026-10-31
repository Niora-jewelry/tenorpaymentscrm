import { describe, expect, it } from 'vitest';
import type { FileRow } from '@/lib/records/files';
import type { TabPayload } from './DrawerTabs';
import { fieldHits, matchedPart, memberKey, searchFields } from './fieldHits';

const field = (id: string, label: string, type = 'text') => ({ id, label, type, tab: '', columnIn: [] });

const tab = (over: Partial<TabPayload>): TabPayload =>
  ({ id: 't', key: 't', label: 'T', kind: 'custom', editable: true, subtabs: [], fieldsBySubtab: {}, repeatGroupsBySubtab: {}, hasCustomFieldOrderBySubtab: {}, ...over }) as TabPayload;

const contact = tab({
  id: 'contact',
  label: 'Contact',
  fieldsBySubtab: { _: [field('business_phone', 'Business phone', 'phone'), field('business_email', 'Business email', 'email'), field('support_line', 'Customer service number', 'phone')] as never },
  repeatGroupsBySubtab: {
    _: [{ id: 'g', key: 'contact', label: 'Contacts', max: 5, count: 1, values: [], schema: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'phone', label: 'Phone', type: 'phone' }] }] as never,
  },
});

const pricing = tab({
  id: 'pricing',
  label: 'Pricing',
  subtabs: [{ id: 's1', key: 'td', label: 'TD Merchant Pricing', description: null, comingSoon: false }],
  fieldsBySubtab: { s1: [field('risk', 'Risk Level'), field('gateway', 'Gateway provider')] as never },
});

const files = tab({ id: 'files', label: 'Files', kind: 'files' });
const row = (id: string, name: string) => ({ id, name, recordId: 'r', kind: 'application', locked: true, note: null, position: 0 }) as FileRow;

const all = fieldHits([contact, pricing, files, tab({ id: 'updates', label: 'Updates', kind: 'updates' })], [row('f1', 'Voided check')]);
const labels = (q: string) => searchFields(all, q).map((h) => h.label);

describe('fieldHits', () => {
  it('lists fields, repeat groups and each group member, with where they live', () => {
    const phone = all.find((h) => h.key === memberKey('contact', 'phone'))!;
    expect(phone).toMatchObject({ label: 'Phone', where: 'Contact › Contacts', tabId: 'contact', subtabId: null });
    expect(all.find((h) => h.key === 'contact')).toMatchObject({ label: 'Contacts', type: 'group' });
    expect(all.find((h) => h.key === 'risk')).toMatchObject({ where: 'Pricing › TD Merchant Pricing', subtabId: 's1' });
  });

  it('lists file rows only when the Files tab reached this viewer', () => {
    expect(all.find((h) => h.label === 'Voided check')).toMatchObject({ key: 'f1', where: 'Files', tabId: 'files' });
    expect(fieldHits([contact], [row('f1', 'Voided check')]).some((h) => h.label === 'Voided check')).toBe(false);
  });

  it('gives every entry its own id', () => {
    expect(new Set(all.map((h) => h.id)).size).toBe(all.length);
  });
});

describe('searchFields', () => {
  it('finds every phone field from part of the word, by its real name', () => {
    expect(labels('pho')).toEqual(['Phone', 'Business phone', 'Customer service number']);
  });

  it('ranks an exact name above one that only contains it', () => {
    expect(labels('phone')[0]).toBe('Phone');
  });

  it('matches the middle of a word', () => {
    expect(labels('hone')).toContain('Business phone');
  });

  it('reads several words in any order', () => {
    expect(labels('email business')).toEqual(['Business email']);
  });

  it('uses where a field lives to narrow it', () => {
    expect(labels('contact phone')).toEqual(['Business phone', 'Phone']);
    expect(labels('td risk')).toEqual(['Risk Level']);
  });

  it('finds a field by its kind when the name does not say it', () => {
    expect(labels('phone')).toContain('Customer service number');
  });

  it('forgives a typo', () => {
    expect(labels('phne')).toContain('Business phone');
    expect(labels('emial')).toContain('Business email');
    expect(labels('voidd')).toContain('Voided check');
  });

  it('does not read a short word as a typo of another', () => {
    expect(labels('pho')).not.toContain('Gateway provider');
  });

  it('drops near misses when something really matches', () => {
    expect(labels('risk')).toEqual(['Risk Level']);
  });

  it('finds a file row', () => {
    expect(labels('void')).toEqual(['Voided check']);
  });

  it('ignores case and punctuation', () => {
    expect(labels('BUSINESS-PHONE')).toEqual(['Business phone']);
  });

  it('returns nothing for an empty query or a word that is nowhere', () => {
    expect(labels('   ')).toEqual([]);
    expect(labels('zzqq')).toEqual([]);
  });

  it('does not guess from two letters', () => {
    expect(labels('ph').every((l) => /ph/i.test(l))).toBe(true);
  });
});

describe('matchedPart', () => {
  it('cuts the label around the match', () => {
    expect(matchedPart('Business phone', 'pho')).toEqual(['Business ', 'pho', 'ne']);
  });

  it('leaves a typo whole', () => {
    expect(matchedPart('Business phone', 'phne')).toEqual(['Business phone', '', '']);
  });
});
