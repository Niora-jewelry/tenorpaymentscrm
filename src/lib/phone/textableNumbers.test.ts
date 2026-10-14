/**
 * The rule is "sync-enabled phone fields, and nothing else", and it is easy
 * to widen by accident — a future reader sees Fax sitting right there and
 * wonders why it is excluded. These say why, in cases that fail if it is.
 */
import { describe, it, expect } from 'vitest';
import { textableNumbers, type TextableSource } from './textableNumbers';
import type { Field as ProtoField } from '@/proto/schema';

const field = (over: Partial<ProtoField>): ProtoField =>
  ({ id: 'k', label: 'L', type: 'phone', tab: 'contact', columnIn: [], ...over }) as ProtoField;

const source = (over: Partial<TextableSource> = {}): TextableSource => ({
  fields: [],
  groups: [],
  ...over,
});

describe('textableNumbers', () => {
  it('finds a contact phone inside a repeat group', () => {
    const got = textableNumbers(
      [
        source({
          groups: [
            {
              key: 'contact',
              label: 'Contact',
              schema: [
                { key: 'name', label: 'Name', type: 'text' },
                { key: 'phone', label: 'Phone', type: 'phone', sync: true },
              ],
              values: [{ name: 'James Kowalski', phone: '+13938279041' }],
            },
          ],
        }),
      ],
      {},
    );
    expect(got).toEqual([{ e164: '+13938279041', who: 'James Kowalski', source: 'Contact' }]);
  });

  it('leaves out a phone field that is not sync-enabled', () => {
    /*
     * Fax and Affiliate main phone are real fields on these records and both
     * have sync off. Texting from one would send, and the reply would land on
     * no record — a conversation that goes one way with nobody told.
     */
    const got = textableNumbers(
      [
        source({
          fields: [field({ id: 'fax_number', label: 'Fax number', sync: false })],
          groups: [
            {
              key: 'affiliate',
              label: 'Affiliate',
              schema: [{ key: 'phone', label: 'Phone', type: 'phone', sync: false }],
              values: [{ name: 'Tomas Silva', phone: '+15528807610' }],
            },
          ],
        }),
      ],
      { fax_number: '+18426407899' },
    );
    expect(got).toEqual([]);
  });

  it('lists one row per person when a record has several contacts', () => {
    const got = textableNumbers(
      [
        source({
          groups: [
            {
              key: 'contact',
              label: 'Contact',
              schema: [
                { key: 'name', label: 'Name', type: 'text' },
                { key: 'phone', label: 'Phone', type: 'phone', sync: true },
              ],
              values: [
                { name: 'James Kowalski', phone: '+13938279041' },
                { name: 'Grace Okafor', phone: '+18262461666' },
              ],
            },
          ],
        }),
      ],
      {},
    );
    expect(got.map((n) => n.who)).toEqual(['James Kowalski', 'Grace Okafor']);
  });

  it('counts the same number once, however many places it appears', () => {
    const group = (key: string, label: string) => ({
      key,
      label,
      schema: [
        { key: 'name', label: 'Name', type: 'text' as const },
        { key: 'phone', label: 'Phone', type: 'phone' as const, sync: true },
      ],
      values: [{ name: 'Same Person', phone: '+13938279041' }],
    });
    const got = textableNumbers(
      [source({ groups: [group('contact', 'Contact'), group('owner', 'Owner')] })],
      {},
    );
    expect(got).toHaveLength(1);
  });

  it('skips anything that is not a storable number rather than guessing', () => {
    const got = textableNumbers(
      [
        source({
          groups: [
            {
              key: 'contact',
              label: 'Contact',
              schema: [{ key: 'phone', label: 'Phone', type: 'phone', sync: true }],
              values: [{ phone: '555-0100' }, { phone: '' }, { phone: null }, {}],
            },
          ],
        }),
      ],
      {},
    );
    expect(got).toEqual([]);
  });

  it('falls back to a numbered label when an instance has no name', () => {
    const got = textableNumbers(
      [
        source({
          groups: [
            {
              key: 'contact',
              label: 'Contact',
              schema: [{ key: 'phone', label: 'Phone', type: 'phone', sync: true }],
              values: [{ phone: '+13938279041' }],
            },
          ],
        }),
      ],
      {},
    );
    expect(got[0].who).toBe('Contact 1');
  });
});
