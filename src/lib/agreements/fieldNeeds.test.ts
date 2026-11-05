import { describe, expect, it } from 'vitest';
import { maverickAch } from './kinds/maverickAch';
import { maverickMerchant } from './kinds/maverickMerchant';
import { requiredFromFieldNeeds, requiredProblems } from './mapping';
import type { AgreementSource } from './kinds/types';

const field = (key: string, agreementNeed: string, type = 'text', label = `CRM ${key}`) => ({ key, label, type, agreementNeed });
const source = (values: Record<string, unknown>): AgreementSource => ({
  values,
  addresses: {},
  notes: {},
  label: (_f, c) => c,
  sentAt: new Date('2026-11-05'),
});
const emptyKeys = (kind: typeof maverickMerchant, values: Record<string, unknown>) =>
  requiredProblems(kind, source(values)).map((p) => p.fieldKey);

describe('requiredFromFieldNeeds', () => {
  it('takes only Required fields from Presets', () => {
    const list = requiredFromFieldNeeds(maverickMerchant, [field('a', 'required'), field('b', 'optional'), field('c', 'none')]);
    expect(list.map((r) => r.fieldKey)).toEqual(['a']);
  });

  it('leaves repeat groups to the signer rules', () => {
    expect(requiredFromFieldNeeds(maverickMerchant, [field('owners', 'required', 'repeat_group')])).toEqual([]);
  });

  it('keeps the kind\'s own wording, and uses the field label otherwise', () => {
    const worded = maverickMerchant.required.find((r) => r.fieldKey === 'prior_processor')!;
    const list = requiredFromFieldNeeds(maverickMerchant, [field('prior_processor', 'required'), field('brand_new', 'required')]);
    expect(list).toEqual([
      { fieldKey: 'prior_processor', label: worded.label },
      { fieldKey: 'brand_new', label: 'CRM brand_new' },
    ]);
  });

  it('an admin adding a field blocks the send, and taking one off stops blocking', () => {
    const kind = {
      ...maverickMerchant,
      check: () => [],
      required: requiredFromFieldNeeds(maverickMerchant, [field('added_by_admin', 'required'), field('legal_business_name', 'none')]),
    };
    expect(emptyKeys(kind, {})).toEqual(['added_by_admin']);
    expect(emptyKeys(kind, { added_by_admin: 'x' })).toEqual([]);
  });

  it('agrees with the spec on what counts as empty', () => {
    const kind = { ...maverickMerchant, check: () => [], required: [{ fieldKey: 'a', label: 'A' }] };
    expect(emptyKeys(kind, { a: 0 })).toEqual([]);
    expect(emptyKeys(kind, { a: '   ' })).toEqual(['a']);
  });

  it('the ACH kind is not touched: its list stays its own', () => {
    expect(maverickAch.required.length).toBeGreaterThan(0);
    expect(emptyKeys({ ...maverickAch, check: () => [] }, {})).toEqual(maverickAch.required.map((r) => r.fieldKey));
  });
});
