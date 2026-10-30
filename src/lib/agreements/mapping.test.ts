import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { maverickMerchant } from './kinds/maverickMerchant';
import type { AgreementSource } from './kinds/types';
import { renderAgreement, requiredProblems } from './mapping';
import { selectSigners } from './signers';

type FieldsFile = { fields: { name: string; type: string; options?: string[] }[] };
const fieldsFile = JSON.parse(readFileSync(path.resolve('src/lib/agreements/template', maverickMerchant.fieldsFile), 'utf8')) as FieldsFile;
const byName = new Map(fieldsFile.fields.map((f) => [f.name, f]));

const labels: Record<string, Record<string, string>> = {
  recurring_subscription: { yes: 'Yes', no: 'No' },
};
const source = (values: Record<string, unknown>, extra: Partial<AgreementSource> = {}): AgreementSource => ({
  values,
  addresses: {},
  notes: {},
  label: (f, c) => labels[f]?.[c] ?? c,
  sentAt: new Date(Date.UTC(2026, 9, 27)),
  ...extra,
});

const FULL: Record<string, unknown> = {
  legal_business_name: 'ZZ Acme Holdings LLC', ein: '123456789', merchant_address: { street: '1 Main St', street2: '', city: 'Austin', state: 'TX', zip: '78701' },
  dba: '', business_phone: '5125550100', business_email: 'joe@zz.test', merchant_website: 'https://zz.test',
  avg_transaction: 120.5, max_transaction: '2,500', monthly_acq_volume: 50000, amex_monthly_volume: 5000, describe_product_service: 'Pizza', mcc_code: '5812',
  entity_type: 'llc', business_founded_date: '2019-11-15', building_type: 'shopping_center', building_ownership: 'leases', area_zoned: 'commercial', square_footage: '501_2500',
  bankruptcy: 'never', prior_processor: 'No', cc_termination: 'no', amex_esa: '', ebt_fns: '12345',
  sales_method: { in_person: 70, mail_phone: 10, ecommerce: 20 }, routing_number: '111000025', account_number: '987654321',
  refund_policy: '30 days', inventory: ['on_site'], third_party_shipping: 'no', recurring_subscription: 'yes',
  customer_type: { individual: 60, business: 30, gov: 10 }, customer_profile: { local: 100, national: 0, international: 0 },
  charge_to_service: '2_days', order_to_service: '2_5_days', when_charged: 'time_of_order', advertising_method: 'Google', seasonal: ['Jun', 'Jul'],
  pricing_model: 'ic', td_vmd_volume: 2.95, td_pin_debit_volume: 1.1, td_amex_volume: 3.5, td_ebt_volume: '', td_ebt_auth_fee: '', td_pin_debit_auth_fee: 0.1,
  td_vmd_auth_fee: 0.1, td_batch_fee: 0.25, td_vmd_transaction_fee: '', td_chargeback_fee: 25, td_avs_fee: 0.05, td_monthly_fee: 10, td_pci_fee: 9.95,
  vtd_gateway_provider: 'Authorize.net', ovmp_pos_provider: 'Clover', td_gateway_provider_mav: 'authorize.NET',
  owner_ownership: [
    { first: 'Jane', last: 'Doe', title: 'CEO', email: 'jane@zz.test', phone: '5125550101', percentage: 60, address: { street: '2 Oak', street2: '', city: 'Austin', state: 'TX', zip: '78702' }, dob: '1980-01-02' },
    { first: 'John', last: 'Roe', title: 'CFO', email: 'john@zz.test', phone: '5125550102', percentage: 40 },
  ],
  owner_private: [{ ssn: '123456789', dl_number: 'TX123', dl_expiry: '2030-05-06' }, { ssn: '987654321' }],
};

describe('the Maverick agreement mapping names only fields the PDF has', () => {
  const names = [
    ...maverickMerchant.mapping.map((m) => m.pdf),
    ...Object.keys(maverickMerchant.fixed),
    ...maverickMerchant.principals.flatMap((p) => [...p.fields.map((f) => f.pdf), ...p.signatures.flatMap((s) => [s.signature, s.date])]),
  ];
  it('every mapped, fixed and principal field exists', () => {
    const missing = names.filter((n) => !byName.has(n));
    expect(missing).toEqual([]);
  });
  it('no PDF field is filled twice', () => {
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect([...new Set(dupes)]).toEqual([]);
  });
  it('radio answers are options the PDF offers', () => {
    const r = renderAgreement(maverickMerchant, source(FULL), selectSigners(ownerInputs(FULL)).signers);
    for (const [name, value] of Object.entries(r.byPdfField)) {
      const f = byName.get(name)!;
      if (f.type === 'radio' && typeof value === 'string' && value) expect(f.options, name).toContain(value);
      if (f.type === 'checkbox') expect(typeof value, name).toBe('boolean');
      if (f.type === 'text') expect(typeof value, name).toBe('string');
    }
  });
});

function ownerInputs(values: Record<string, unknown>) {
  return (values.owner_ownership as Record<string, string>[]).map((o, index) => ({ index, first: o.first, last: o.last, email: o.email, title: o.title, percentage: o.percentage }));
}

describe('rendering the spec’s rules', () => {
  const r = renderAgreement(maverickMerchant, source(FULL, { notes: { recurring_subscription: 'Monthly plans' } }), selectSigners(ownerInputs(FULL)).signers);
  const f = r.byPdfField;
  it('business block, formatting', () => {
    expect(f['FEDERAL TAX ID NUMBER']).toBe('12-3456789');
    expect(f['CUSTOMER SERVICE NUMBER']).toBe('(512) 555-0100');
    expect(f['AVERAGE TRANSACTION AMOUNT']).toBe('120.50');
    expect(f['MAXIMUM TRANSACTION AMOUNT']).toBe('2500.00');
    expect(f['YEARS IN BUSINESS']).toBe('6');
  });
  it('DBA empty → "Same as above" ticked, DBA name and address blank', () => {
    expect(f['Information same as above corporate  legal']).toBe(true);
    expect(f['MERCHANT NAME DBA OR TRADE NAME']).toBe('');
    expect(f['LOCATION ADDRESS_2']).toBe('');
    expect(f['LOCATION ADDRESS']).toBe('1 Main St');
  });
  it('Leases ticks Rents; square footage keeps the CRM range', () => {
    expect(f.RENTS).toBe(true);
    expect(f.OWNS).toBe(false);
    expect(f['5012500']).toBe(true);
  });
  it('prior processor "No" → process cards No, current processor blank', () => {
    expect(f['DOES THIS BUSINESS CURRENTLY PROCESS CARDS']).toBe('NO_2');
    expect(f['CURRENT PROCESSOR']).toBe('');
  });
  it('bankruptcy never filed', () => {
    expect(f['NEVER FILED']).toBe(true);
    expect(f['BUSINESS BANKRUPTCY']).toBe(false);
  });
  it('IC+: IC+ % = VMD volume, both pass-through boxes ticked, no rate box', () => {
    expect(f.Percentage).toBe('2.95');
    expect(f['Passthrough Network Fees']).toBe(true);
    expect(f['Passthrough Network Fees_2']).toBe(true);
    expect(f['Flat Rate']).toBe(false);
  });
  it('fixed values print as listed', () => {
    expect(f.fill_39).toBe('0.75');
    expect(f.fill_38).toBe('7.50');
    expect(f.fill_44).toBe('0.00');
    expect(f['fill_51.0']).toBe('9.95');
    expect(f['ROUTING NUMBER_2']).toBeUndefined();
    expect(f['VISA MASTERCARD DISCOVER']).toBe(true);
    expect(f.undefined).toBe('YES');
  });
  it('empty fees print 0', () => {
    expect(f.Percentage_7).toBe('0');
    expect(f['Authorization Fee_2']).toBe('0.00');
    expect(f.fill_33).toBe('0.00');
  });
  it('equipment joins the providers once each, in order', () => {
    expect(f['ii  PLEASE LIST EQUIPMENT ANDOR SOFTWARE USED TO PROCESS CARDS POINTOFSALE TERMINAL PAYMENT GATEWAY ETC']).toBe('Authorize.net, Clover');
  });
  it('recurring: "Choice – notes"', () => {
    expect(f['iii  DO YOU OFFER RECURRING AND TIMEEXTENDED SERVICES SUBSCRIPTIONS MEMBERSHIPS RECURRING PLANS ETC IF YES PLEASE DESCRIBE AND INCLUDE DURATION']).toBe('Yes - Monthly plans');
  });
  it('seasonal ticks the months and answers Yes', () => {
    expect(f.JUNE).toBe(true);
    expect(f.JULY).toBe(true);
    expect(f.MAY).toBe(false);
    expect(f['xi IS YOUR BUSINESS SEASONAL']).toBe('YES_4');
  });
  it('principals: slot 1 is the largest owner, slot 2 next, slots 3–4 blank', () => {
    expect(f.FIRST).toBe('Jane');
    expect(f.SSN).toBe('123-45-6789');
    expect(f.OWNERSHIP).toBe('60');
    expect(f['HOME ADDRESS']).toBe('2 Oak');
    expect(f['DRIVERS LICENSE NUMBER AND EXP DATE']).toBe('TX123 exp. 05/06/2030');
    expect(f['DATE OF BIRTH']).toBe('01/02/1980');
    expect(f.FIRST_2).toBe('John');
    expect(f.FIRST_3).toBeUndefined();
  });
  it('records what it read', () => {
    expect(r.usedFieldKeys).toContain('legal_business_name');
    expect(r.usedFieldKeys).toContain('owner_private');
    expect(r.used.some((u) => u.fieldKey === 'inventory' && u.kind === 'address')).toBe(true);
  });
});

describe('Flat Rate', () => {
  it('only the Flat Rate box, IC+ % = 0, pass-through unticked', () => {
    const f = renderAgreement(maverickMerchant, source({ ...FULL, pricing_model: 'fr' }), []).byPdfField;
    expect(f['Flat Rate']).toBe(true);
    expect(f.Surcharge).toBe(false);
    expect(f.Percentage).toBe('0');
    expect(f['Passthrough Network Fees']).toBe(false);
  });
});

describe('pre-send problems (spec §5 + 30 Oct rulings)', () => {
  const keys = (values: Record<string, unknown>, extra: Partial<AgreementSource> = {}) => requiredProblems(maverickMerchant, source(values, extra)).map((p) => p.fieldKey);
  it('a complete record has none', () => expect(keys(FULL)).toEqual([]));
  it('empty EIN, empty return policy, sales method at 90%', () => {
    const k = keys({ ...FULL, ein: '', refund_policy: '', sales_method: { in_person: 70, mail_phone: 10, ecommerce: 10 } });
    expect([...k].sort()).toEqual(['ein', 'refund_policy', 'sales_method']);
  });
  it('0 counts as filled', () => expect(keys({ ...FULL, td_pci_fee: 0 })).toEqual([]));
  it('bankruptcy "Yes" blocks until a kind is picked; a kind needs its note', () => {
    expect(keys({ ...FULL, bankruptcy: 'yes' })).toEqual(['bankruptcy']);
    expect(keys({ ...FULL, bankruptcy: 'business' })).toEqual(['bankruptcy']);
    expect(keys({ ...FULL, bankruptcy: 'business' }, { notes: { bankruptcy: 'Ch. 7, 2015' } })).toEqual([]);
  });
  it('entity type / inventory Other, and third-party storage, block', () => {
    expect(keys({ ...FULL, entity_type: 'other' })).toEqual(['entity_type']);
    expect(keys({ ...FULL, inventory: ['on_site', 'other'] })).toEqual(['inventory']);
    expect(keys({ ...FULL, inventory: ['third_party_storage'] })).toEqual(['inventory']);
  });
  it('off-site inventory needs the warehouse address', () => {
    expect(keys({ ...FULL, inventory: ['off_site'] })).toEqual(['inventory']);
    expect(keys({ ...FULL, inventory: ['off_site'] }, { addresses: { inventory: { street: '9 Dock Rd', city: 'Austin', state: 'TX', zip: '78701' } } })).toEqual([]);
  });
  it('seasonal months need no note; a CC termination note never blocks (spec §5)', () => {
    expect(keys({ ...FULL, seasonal: ['Jun'] })).toEqual([]);
    expect(keys({ ...FULL, seasonal: ['No'] })).toEqual([]);
    expect(keys({ ...FULL, cc_termination: 'yes' })).toEqual([]);
  });
  it('prior processor must be "No" or a name', () => expect(keys({ ...FULL, prior_processor: '' })).toEqual(['prior_processor']));
});
