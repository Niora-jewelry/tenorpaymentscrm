/**
 * The small builders every agreement kind's mapping is written in: a text
 * box from one field, a box ticked by a choice, one part of a percent split,
 * a four-box address. Kept here so the Maverick merchant and ACH agreements
 * read the CRM the same way.
 */
import type { AgreementSource, CrmValues, Fill, MappingEntry, Used } from './types';
import { addressParts, str } from '../format';
import { percent } from '../format';

export const v = (src: AgreementSource, key: string) => src.values[key];
export const used = (fieldKey: string, kind: Used['kind'] = 'value'): Used[] => [{ fieldKey, kind }];

/** A text box from one CRM field, through a formatter. */
export const text = (pdf: string, key: string, fmt: (x: unknown) => string = str): MappingEntry => ({
  pdf,
  fill: (src) => ({ text: fmt(v(src, key)), used: used(key) }),
});

/** A text box from one CRM field, with a value printed when the field is empty ("0 if blank"). */
export const textOr = (pdf: string, key: string, fmt: (x: unknown) => string, empty: string): MappingEntry => ({
  pdf,
  fill: (src) => ({ text: fmt(v(src, key)) || empty, used: used(key) }),
});

/** A box ticked when the CRM choice is one of the given keys. */
export const tick = (pdf: string, key: string, when: string[]): MappingEntry => ({
  pdf,
  fill: (src) => ({ check: when.includes(str(v(src, key)).toLowerCase()), used: used(key) }),
});

/** One part of a percent split. */
export const part = (pdf: string, key: string, partKey: string): MappingEntry => ({
  pdf,
  fill: (src) => {
    const split = v(src, key);
    const n = split && typeof split === 'object' && !Array.isArray(split) ? (split as Record<string, unknown>)[partKey] : undefined;
    return { text: percent(n), used: used(key) };
  },
});

/** The four boxes an address prints into: street (+ unit), city, state, zip. */
export const addressBlock = (street: string, city: string, state: string, zip: string, key: string, onlyIf?: (src: AgreementSource) => boolean): MappingEntry[] => {
  const when = (src: AgreementSource) => (onlyIf ? onlyIf(src) : true);
  const pick = (f: (a: ReturnType<typeof addressParts>) => string) => (src: AgreementSource): Fill => ({ text: when(src) ? f(addressParts(v(src, key))) : '', used: used(key) });
  return [
    { pdf: street, fill: pick((a) => [a.street, a.street2].filter(Boolean).join(', ')) },
    { pdf: city, fill: pick((a) => a.city) },
    { pdf: state, fill: pick((a) => a.state) },
    { pdf: zip, fill: pick((a) => a.zip) },
  ];
};

/** "If yes, please explain" — the field's note, printed only when the answer is Yes. */
export const noteWhenYes = (pdf: string, key: string): MappingEntry => ({
  pdf,
  fill: (src) => ({ text: str(v(src, key)).toLowerCase() === 'yes' ? (src.notes[key] ?? '') : '', used: [{ fieldKey: key, kind: 'note' }] }),
});

export const hasDba = (src: AgreementSource) => Boolean(str(v(src, 'dba')));
export const bankruptcy = (src: AgreementSource) => str(v(src, 'bankruptcy')).toLowerCase();
export const ownerText = (o: CrmValues, k: string) => str(o[k]);

/** Sum of a percent split's parts; NaN when the field is not a split. */
export const splitTotal = (split: unknown) =>
  split && typeof split === 'object' && !Array.isArray(split) ? Object.values(split as Record<string, unknown>).reduce<number>((s, x) => s + (Number(x) || 0), 0) : NaN;
