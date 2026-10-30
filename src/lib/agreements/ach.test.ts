import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { maverickAch } from './kinds/maverickAch';
import { maverickMerchant } from './kinds/maverickMerchant';
import type { AgreementSource } from './kinds/types';
import { renderAgreement, requiredProblems, signerDetailProblems } from './mapping';
import { selectSigners } from './signers';

vi.mock('server-only', () => ({}));

type FieldsFile = { fields: { name: string; type: string }[] };
const fieldsFile = JSON.parse(readFileSync(path.resolve('src/lib/agreements/template', maverickAch.fieldsFile), 'utf8')) as FieldsFile;
const byName = new Map(fieldsFile.fields.map((f) => [f.name, f]));

const owners = [
  { first: 'Jane', last: 'Doe', title: 'CEO', email: 'jane@zz.test', phone: '5125550101', percentage: 70, address: { street: '2 Oak', city: 'Austin', state: 'TX', zip: '78702' }, dob: '1980-01-02' },
  { first: 'John', last: 'Roe', title: 'CFO', email: 'john@zz.test', phone: '5125550102', percentage: 30 },
];
const FULL: Record<string, unknown> = {
  legal_business_name: 'ZZ Acme Holdings LLC', ein: '123456789', dba: '',
  merchant_address: { street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  business_phone: '5125550100', business_email: 'joe@zz.test', merchant_website: 'https://zz.test',
  ach_monthly_transactions: 120, monthly_ach_volume: 25000, ach_avg_transaction: 208.33, ach_max_transaction: 1500, ach_monthly_returns: 2,
  ach_credits_required: 'yes', describe_product_service: 'Pizza', mcc_code: '5812', payment_codes: { ppd: 60, ccd: 30, web: 10, tel: 0 },
  entity_type: 'llc', business_founded_date: '2019-11-15', building_type: 'shopping_center', building_ownership: 'leases', area_zoned: 'commercial', square_footage: '501_2500',
  bankruptcy: 'never', prior_ach_provider: 'No', ach_termination: 'no', customer_type: { individual: 60, business: 30, gov: 10 },
  charge_to_service: '2_days', when_charged: 'time_of_order', refund_policy: '30 days', recurring_subscription: 'yes',
  routing_number: '111000025', account_number: '987654321',
  td_ach_transaction_fee: 0.25, td_ach_bin: 0.5, td_ach_monthly_gateway_fee: '', td_ach_return: 5, td_ach_debit_unauthorized_fee: '', td_ach_exception_fee: '',
  owner_ownership: owners, owner_private: [{ ssn: '123456789', dl_number: 'TX123', dl_expiry: '2030-05-06' }, { ssn: '987654321' }],
};
const source = (values: Record<string, unknown>, extra: Partial<AgreementSource> = {}): AgreementSource => ({
  values,
  addresses: {},
  notes: {},
  label: (_f, c) => c,
  sentAt: new Date(Date.UTC(2026, 9, 27)),
  ...extra,
});
const signers = selectSigners(owners.map((o, index) => ({ index, ...o }))).signers;

describe('the Maverick ACH agreement mapping', () => {
  const names = [
    ...maverickAch.mapping.map((m) => m.pdf),
    ...Object.keys(maverickAch.fixed),
    ...maverickAch.principals.flatMap((p) => [...p.fields.map((f) => f.pdf), ...p.signatures.flatMap((s) => [s.signature, s.date])]),
  ];
  it('names only fields the PDF has, each once', () => {
    expect(names.filter((n) => !byName.has(n))).toEqual([]);
    expect([...new Set(names.filter((n, i) => names.indexOf(n) !== i))]).toEqual([]);
  });

  const f = renderAgreement(maverickAch, source(FULL, { notes: { recurring_subscription: 'Monthly memberships', ach_credits_required: 'Refunds by credit' } }), signers).byPdfField;
  it('one Business phone and email fill both pairs of boxes (the client, 30 Oct 2026)', () => {
    expect(f['Customer Service Number']).toBe('(512) 555-0100');
    expect(f['Contact Number']).toBe('(512) 555-0100');
    expect(f['Customer Service Email']).toBe('joe@zz.test');
    expect(f['Contact Email']).toBe('joe@zz.test');
  });
  it('processing figures come from the ACH fields', () => {
    expect(f['# of Monthly ACH Transactions']).toBe('120');
    expect(f['Average Monthly ACH Sales Volume']).toBe('25000.00');
    expect(f['Average ACH Transaction Amount']).toBe('208.33');
    expect(f['Maximum Transaction Amount']).toBe('1500.00');
    expect(f['# of Monthly ACH Returns']).toBe('2');
  });
  it('ACH credits Yes: the Yes box, its details, and Credits on bank account 1', () => {
    expect(f.CheckBox3).toBe(true);
    expect(f.CheckBox2).toBe(false);
    expect(f['If yes, provide details:']).toBe('Refunds by credit');
    expect(f.CheckBox45).toBe(true);
    expect(f.CheckBox44).toBe(true);
    expect(f.CheckBox46).toBe(true);
  });
  it('SEC codes, entity, location (Leases = Rents)', () => {
    expect([f['PPD Percentage'], f['CCD Percentage'], f['Web Percentage'], f['Tel Percentage']]).toEqual(['60', '30', '10', '0']);
    expect(f.CheckBox8).toBe(true); // LLC
    expect(f.CheckBox15).toBe(true); // Rents
    expect(f.CheckBox20).toBe(true); // 501-2,500
    expect(f['Years in business']).toBe('6');
  });
  it('prior ACH processor "No" → No, current processor blank; termination No', () => {
    expect(f.CheckBox30).toBe(true);
    expect(f.CheckBox31).toBe(false);
    expect(f['If yes, current processor']).toBe('');
    expect(f.CheckBox32).toBe(true);
  });
  it('recurring Yes prints its note', () => {
    expect(f.CheckBox43).toBe(true);
    expect(f['If yes, please provide details']).toBe('Monthly memberships');
  });
  it('fees: from the CRM, 0 if blank; setup 0, NOC always 5', () => {
    expect(f['Inital Setup Fee']).toBe('0.00');
    expect(f['Per Transaction Fee']).toBe('0.25');
    expect(f['Rate (debit transactions only)']).toBe('0.5');
    expect(f['Monthly Maintenance Fee']).toBe('0.00');
    expect(f['Return Item Processing']).toBe('5.00');
    expect(f['Notification of Change']).toBe('5.00');
    expect(f['FED Unauthorized Return Fee']).toBe('0.00');
    expect(f['Exception/Corrections Processing']).toBe('0.00');
  });
  it('principals in slots 1 and 2; bank accounts 2 and 3 blank', () => {
    expect(f['First Name Principal 1']).toBe('Jane');
    expect(f['SSN Principal 1']).toBe('123-45-6789');
    expect(f['Drivers License/Exp Date Principal 1']).toBe('TX123 exp. 05/06/2030');
    expect(f['First Name Principal 2']).toBe('John');
    expect(f['First Name Principal 3']).toBeUndefined();
    expect(f['Routing Number']).toBe('111000025');
    expect(f['Routing Number_2']).toBeUndefined();
  });
});

describe('ACH pre-send problems', () => {
  const keys = (values: Record<string, unknown>, extra: Partial<AgreementSource> = {}) => requiredProblems(maverickAch, source(values, extra)).map((p) => p.fieldKey);
  it('a complete record has none', () => expect(keys(FULL)).toEqual([]));
  it('the new ACH amounts and the prior ACH provider are required', () =>
    expect(keys({ ...FULL, ach_avg_transaction: '', ach_max_transaction: '', prior_ach_provider: '' }).sort()).toEqual(['ach_avg_transaction', 'ach_max_transaction', 'prior_ach_provider']));
  it('SEC codes must total 100%', () => expect(keys({ ...FULL, payment_codes: { ppd: 60, ccd: 30, web: 0, tel: 0 } })).toEqual(['payment_codes']));
  it('ACH termination Yes never blocks on its note; bankruptcy Yes needs the kind', () => {
    expect(keys({ ...FULL, ach_termination: 'yes' })).toEqual([]);
    expect(keys({ ...FULL, bankruptcy: 'yes' })).toEqual(['bankruptcy']);
  });
});

describe('every selected signer is complete before a send (spec §5)', () => {
  const complete = { first: 'Jane', last: 'Doe', title: 'CEO', email: 'jane@zz.test', phone: '5125550101', percentage: 100, dob: '1980-01-02', address: { street: '2 Oak', city: 'Austin', state: 'TX', zip: '78702' } };
  const priv = { ssn: '123456789', dl_number: 'TX123', dl_expiry: '2030-05-06' };
  const check = (o: Record<string, unknown>, p: Record<string, unknown>) => signerDetailProblems(source({ owner_ownership: [o], owner_private: [p] }), [0]);

  it('a complete signer has no problems', () => expect(check(complete, priv)).toEqual([]));
  it('each Ownership detail is named, on the Ownership field', () => {
    expect(check({ ...complete, title: '  ', phone: '', dob: null }, priv)).toEqual([{ fieldKey: 'owner_ownership', index: 0, message: 'Jane Doe needs a title, a phone number and a date of birth.' }]);
  });
  it('a partial address is not an address: the agreement has a box for each part', () => {
    expect(check({ ...complete, address: { street: '2 Oak', city: 'Austin', state: 'TX', zip: '' } }, priv)[0]?.message).toBe('Jane Doe needs a full home address.');
  });
  it('each Private detail is its own item on the Private field, so it can be masked', () => {
    expect(check(complete, { ssn: '', dl_number: '', dl_expiry: '' })).toEqual([{ fieldKey: 'owner_private', index: 0, message: "Jane Doe needs an SSN, a driver's license number and a driver's license expiry date." }]);
  });
  it('a missing Private row counts as empty', () => expect(check(complete, {})).toHaveLength(1));
  it('only the selected owners are checked', () => {
    const values = { owner_ownership: [complete, { first: 'Sam', last: 'Small', percentage: 5 }], owner_private: [priv] };
    expect(signerDetailProblems(source(values), [0])).toEqual([]);
  });
  it('selectSigners still names the selected owners when another problem blocks the send', () => {
    const r = selectSigners([{ index: 0, first: 'Jane', last: 'Doe', email: 'nope', title: '', percentage: 100 }]);
    expect(r.signers).toEqual([]);
    expect(r.selected).toEqual([0]);
  });
  it('spaces only count as empty; a 0 counts as filled', () => {
    expect(requiredProblems(maverickAch, source({ ...FULL, refund_policy: '   ' })).map((p) => p.fieldKey)).toEqual(['refund_policy']);
    expect(requiredProblems(maverickAch, source({ ...FULL, ach_monthly_returns: 0 })).map((p) => p.fieldKey)).toEqual([]);
  });
});

describe('the words each kind uses', () => {
  it('names the signed file as the spec does', () => {
    expect(maverickMerchant.fileLabel).toBe('Merchant Agreement');
    expect(maverickAch.fileLabel).toBe('ACH Agreement');
  });
});

describe('the ACH agreement PDF', () => {
  it('fills, flattens, and marks two signing places per principal', async () => {
    const { fillAndFlatten, loadTemplate, signatureSpots } = await import('./pdf');
    const { pdf, fields } = await loadTemplate(maverickAch);
    const out = await fillAndFlatten(maverickAch, pdf, renderAgreement(maverickAch, source(FULL), signers).byPdfField);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(8);
    expect(doc.getForm().getFields().length).toBe(0);
    expect(out.byteLength).toBeLessThan(12_000_000);
    const spots = signatureSpots(maverickAch, fields, signers);
    expect(spots).toHaveLength(2 * 2 * 2); // two signers × (acceptance + guarantee) × (signature + date)
    expect(new Set(spots.map((s) => s.page))).toEqual(new Set([4]));
  }, 60_000);
});
