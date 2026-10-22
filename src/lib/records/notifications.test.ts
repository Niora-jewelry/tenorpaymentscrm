import { describe, it, expect } from 'vitest';
import { hrefFor, reconcileMentions } from './notifications';

const A = { id: '11111111-1111-4111-8111-111111111111', name: 'Alex Chen' };
const B = { id: '22222222-2222-4222-8222-222222222222', name: 'Maylyn' };
const roster = [A, B];

describe('reconcileMentions — the ids a client claims, checked against the text', () => {
  it('keeps a person whose @Name is in the body', () => {
    expect(reconcileMentions('Ping @Alex Chen please', [A.id], roster)).toEqual([A.id]);
  });

  it('drops a person whose tag was deleted from the text', () => {
    expect(reconcileMentions('Ping please', [A.id], roster)).toEqual([]);
  });

  it('drops an id that is not a candidate at all', () => {
    expect(reconcileMentions('@Nobody Here', ['33333333-3333-4333-8333-333333333333'], roster)).toEqual([]);
  });

  it('dedupes a person claimed twice', () => {
    expect(reconcileMentions('@Maylyn and @Maylyn', [B.id, B.id], roster)).toEqual([B.id]);
  });

  it('keeps order of the claim, not of the roster', () => {
    expect(reconcileMentions('@Maylyn then @Alex Chen', [B.id, A.id], roster)).toEqual([B.id, A.id]);
  });
});

describe('hrefFor — where a notification opens', () => {
  const rec = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const mod = { slug: 'leads' };

  it('a mention opens the record at its tab, sub-tab and item', () => {
    expect(hrefFor({ id: 'n1', source_kind: 'mention_field', record_id: rec, tab_key: 'application', subtab_key: 'general' }, mod)).toBe(
      `/leads?record=${rec}&tab=application&subtab=general&n=n1`,
    );
  });

  it('an update mention has no sub-tab', () => {
    expect(hrefFor({ id: 'n2', source_kind: 'mention_update', record_id: rec, tab_key: 'updates', subtab_key: null }, mod)).toBe(
      `/leads?record=${rec}&tab=updates&n=n2`,
    );
  });

  it('a mention on a record the viewer can no longer open has no link', () => {
    expect(hrefFor({ id: 'n3', source_kind: 'mention_update', record_id: rec, tab_key: 'updates' }, undefined)).toBeNull();
  });

  it('a phone alert opens Communication at the matching sub-tab', () => {
    expect(hrefFor({ id: 'n4', source_kind: 'voicemail', record_id: rec }, mod)).toBe(`/leads?record=${rec}&tab=communication&subtab=recordings`);
    expect(hrefFor({ id: 'n5', source_kind: 'sms', record_id: rec }, mod)).toBe(`/leads?record=${rec}&tab=communication&subtab=text`);
  });

  it('a phone alert without a record (or an unopenable one) falls back to the Phone page', () => {
    expect(hrefFor({ id: 'n6', source_kind: 'call', record_id: null }, undefined)).toBe('/phone');
    expect(hrefFor({ id: 'n7', source_kind: 'call', record_id: rec }, undefined)).toBe('/phone');
  });

  it('encodes keys that are not URL-safe', () => {
    expect(hrefFor({ id: 'n8', source_kind: 'mention_field', record_id: rec, tab_key: 'a b', subtab_key: 'c&d' }, mod)).toBe(
      `/leads?record=${rec}&tab=a%20b&subtab=c%26d&n=n8`,
    );
  });
});
