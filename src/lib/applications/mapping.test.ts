import { describe, expect, it } from 'vitest';
import {
  answersForPdf,
  buildWrite,
  classify,
  cleanDate,
  cleanNumber,
  parseAddress,
  parseTargetKey,
  prefillAnswers,
  proposalsFrom,
  receivedDays,
  monthsIn,
  ssnOnFile,
  targetKey,
  type CrmValues,
  type Proposal,
} from './mapping';
import { answerKeys, QUESTIONS } from './catalog';

const labels = (field: string, key: string) => `${field}:${key}`;
const find = (ps: Proposal[], key: string) => ps.find((p) => targetKey(p.target) === key);

const CRM: CrmValues = {
  legal_business_name: 'Acme Holdings LLC',
  dba: "Joe's Pizza",
  merchant_address: { street: '1 Main St', street2: '', city: 'Austin', state: 'TX', zip: '78701', country: 'United States' },
  contact: [{ name: 'Joe', email: 'joe@acme.test', phone: '5125550100' }],
  merchant_website: 'https://acme.test',
  owner_ownership: [{ first: 'Joe', last: 'Van Der Berg', title: 'CEO', percentage: '60', email: 'joe@acme.test', phone: '5125550100' }],
  owner_private: [{ ssn: '123456789' }],
  ein: '121234567',
  account_number: '000111222',
  monthly_acq_volume: '50000',
  td_ach_return: '',
  charge_to_service: '2_days',
  seasonal: ['No'],
  sales_method: { ecommerce: 20, in_person: 70, mail_phone: 10 },
};

describe('prefill (CRM → application)', () => {
  const a = prefillAnswers(CRM, labels);

  it('fills the six acceptance-checklist fields', () => {
    expect(a.legal_business_name).toBe('Acme Holdings LLC');
    expect(a.dba).toBe("Joe's Pizza");
    expect(a.merchant_address).toMatchObject({ street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' });
    expect(a.contact_email).toBe('joe@acme.test');
    expect(a.contact_phone).toBe('5125550100');
    expect(a.merchant_website).toBe('https://acme.test');
  });

  it('never prefills an SSN or a Private value', () => {
    const all = JSON.stringify(a);
    expect(all).not.toContain('123456789');
    expect(all).not.toContain('121234567');
    expect(all).not.toContain('000111222');
    expect(Object.keys(a).some((k) => k.endsWith('_ssn'))).toBe(false);
    expect(ssnOnFile(CRM)).toEqual({ 1: '•••-••-6789' });
  });

  it('R10 joins first and last name with a space', () => {
    expect(a.owner1_name).toBe('Joe Van Der Berg');
  });

  it('R2–R4 prefills the card and ACH question with the same value', () => {
    expect(a.monthly_acq_volume).toBe('50000');
    expect(a.monthly_ach_volume).toBe('50000');
  });

  it('R1 and R6 prefill Yes/No from whether the field has a value', () => {
    expect(a.ach_refunds).toBe('No');
    expect(a.accepts_payment_before_delivery).toBe('Yes');
  });

  it('R11 prefills one % box per option', () => {
    expect(a.sales_method_internet).toBe('20');
    expect(a.sales_method_in_person).toBe('70');
    expect(a.sales_method_mail_phone).toBe('10');
  });

  it('a months value of "No" is Seasonal = No', () => {
    expect(a.seasonal).toBe('No');
  });

  it('the PDF gets dates as MM/DD/YYYY and the address on one line', () => {
    const pdf = answersForPdf({ ...a, business_founded_date: '2019-03-07' });
    expect(pdf.business_founded_date).toBe('03/07/2019');
    expect(pdf.merchant_address).toBe('1 Main St, Austin, TX 78701');
  });
});

describe('return (application → CRM)', () => {
  it('R2–R4: the higher of the card and ACH answers wins', () => {
    const ps = proposalsFrom({ monthly_acq_volume: '$50,000', monthly_ach_volume: '10,000' }, {}, labels);
    expect(find(ps, 'field:monthly_acq_volume')?.value).toBe('50000');
    const ps2 = proposalsFrom({ average_ach_transaction_amount: '250' }, {}, labels);
    expect(find(ps2, 'field:avg_transaction')?.value).toBe('250');
  });

  it('R1 and R6: those Yes/No answers are never written back', () => {
    const ps = proposalsFrom({ ach_refunds: 'Yes', accepts_payment_before_delivery: 'No' }, {}, labels);
    expect(ps.find((p) => p.fieldKey === 'td_ach_return')).toBeUndefined();
    expect(find(ps, 'field:ach_refunds')?.value).toBe('yes');
    expect(find(ps, 'field:accepts_payment_before_delivery')).toBeUndefined();
    expect(ps.find((p) => p.fieldKey === 'charge_to_service')).toBeUndefined();
  });

  it('R5: Monthly ACH transactions is written like any field', () => {
    expect(find(proposalsFrom({ ach_monthly_transactions: '1,200' }, {}, labels), 'field:ach_monthly_transactions')?.value).toBe('1200');
  });

  it('R7 and R8: details and comments go into that question’s notes', () => {
    const ps = proposalsFrom(
      { bankruptcy: 'Yes', bankruptcy_details: 'Ch. 7 in 2015', cc_termination_details: 'MATCH list 2020', seasonal_details: 'Summer', product_received_comments: 'Ships from CA' },
      {},
      labels,
    );
    expect(find(ps, 'note:bankruptcy')?.value).toBe('Ch. 7 in 2015');
    expect(find(ps, 'note:cc_termination')?.value).toBe('MATCH list 2020');
    expect(find(ps, 'note:seasonal')?.value).toBe('Summer');
    expect(find(ps, 'note:order_to_service')?.value).toBe('Ships from CA');
  });

  it('R9 and R10: owners split at the first space; SSN goes to Private', () => {
    const ps = proposalsFrom({ owner2_name: 'Mary Ann Smith', owner2_ssn: '123-45-6789', owner2_percentage: '40%' }, {}, labels);
    expect(find(ps, 'member:owner_ownership.1.first')?.value).toBe('Mary');
    expect(find(ps, 'member:owner_ownership.1.last')?.value).toBe('Ann Smith');
    expect(find(ps, 'member:owner_ownership.1.percentage')?.value).toBe('40');
    const ssn = find(ps, 'member:owner_private.1.ssn');
    expect(ssn?.value).toBe('123456789');
    expect(ssn?.display).toBe('•••-••-6789');
  });

  it('online, first and last are written as typed — a two-word first name stays whole', () => {
    const ps = proposalsFrom({ owner1_first: 'Mary Ann', owner1_last: 'Smith', owner1_name: 'ignored when first/last exist' }, {}, labels);
    expect(find(ps, 'member:owner_ownership.0.first')?.value).toBe('Mary Ann');
    expect(find(ps, 'member:owner_ownership.0.last')?.value).toBe('Smith');
    expect(answersForPdf({ owner1_first: 'Mary Ann', owner1_last: 'Smith' }).owner1_name).toBe('Mary Ann Smith');
    expect(answersForPdf({ owner1_first: 'Mary Ann', owner1_last: 'Smith' })).not.toHaveProperty('owner1_first');
  });

  it('R11: each % box maps to its own option', () => {
    const ps = proposalsFrom({ customer_type_b2c: '60', customer_type_b2b: '30%', customer_type_government: '10' }, {}, labels);
    expect(find(ps, 'field:customer_type')?.value).toEqual({ individual: 60, business: 30, gov: 10 });
  });

  it('a blank or Off answer is no answer, never "No"', () => {
    const ps = proposalsFrom({ bankruptcy: '', cc_termination: '', seasonal: '', inventory: [] }, {}, labels);
    expect(ps).toEqual([]);
  });

  it('Bankruptcy is Yes / No, as on the PDF (client, 28 Oct)', () => {
    expect(find(proposalsFrom({ bankruptcy: 'Yes' }, {}, labels), 'field:bankruptcy')?.value).toBe('yes');
    expect(find(proposalsFrom({ bankruptcy: 'No' }, {}, labels), 'field:bankruptcy')?.value).toBe('never');
    // Prefill reads the new Yes/No value and an older Business/Personal/Never list alike.
    expect(prefillAnswers({ bankruptcy: 'yes' }, labels).bankruptcy).toBe('Yes');
    expect(prefillAnswers({ bankruptcy: 'business' }, labels).bankruptcy).toBe('Yes');
    expect(prefillAnswers({ bankruptcy: 'never' }, labels).bankruptcy).toBe('No');
    expect(prefillAnswers({ bankruptcy: ['never'] }, labels).bankruptcy).toBe('No');
    expect(prefillAnswers({ bankruptcy: ['personal'] }, labels).bankruptcy).toBe('Yes');
  });

  it('Seasonal: "which months?" fills the months; the text also goes to notes', () => {
    const ps = proposalsFrom({ seasonal: 'Yes', seasonal_details: 'Busy from June to August, and again in Dec' }, { seasonal: ['No'] }, labels);
    expect(find(ps, 'field:seasonal')?.value).toEqual(['Jun', 'Jul', 'Aug', 'Dec']);
    expect(find(ps, 'note:seasonal')?.value).toContain('June to August');
    // Months on file prefill the box.
    expect(prefillAnswers({ seasonal: ['Nov', 'Dec'] }, labels)).toMatchObject({ seasonal: 'Yes', seasonal_details: 'Nov, Dec' });
  });

  it('months are read from how people write them', () => {
    expect(monthsIn('Nov - Feb')).toEqual(['Jan', 'Feb', 'Nov', 'Dec']);
    expect(monthsIn('summer')).toEqual(['Jun', 'Jul', 'Aug']);
    expect(monthsIn('holiday season')).toEqual(['Nov', 'Dec']);
    expect(monthsIn('May and September')).toEqual(['May', 'Sep']);
    // "may" as an ordinary word is not the month.
    expect(monthsIn('hours may vary')).toEqual([]);
    expect(monthsIn('')).toEqual([]);
  });

  it('a square-footage box that spans two CRM ranges is a pick, never a guess', () => {
    const p = find(proposalsFrom({ square_footage: ['1000_5000'] }, {}, labels), 'field:square_footage');
    expect(p?.candidates?.map((c) => c.value)).toEqual(['501_2500', '2501_5000']);
    expect(find(proposalsFrom({ square_footage: ['above_10000'] }, {}, labels), 'field:square_footage')?.value).toBe('10000');
  });

  it('inventory boxes land as the CRM’s own multi-select keys', () => {
    expect(find(proposalsFrom({ inventory: ['on_site', 'fulfillment_center'] }, {}, labels), 'field:inventory')?.value).toEqual(['on_site', 'fulfillment_center']);
    expect(find(proposalsFrom({ inventory: ['none', 'off_site_warehouse'] }, {}, labels), 'field:inventory')?.value).toEqual(['none', 'off_site']);
    expect(prefillAnswers({ inventory: ['off_site', 'third_party_storage'] }, labels).inventory).toEqual(['off_site_warehouse', 'third_party_storage']);
    expect(prefillAnswers({ inventory: 'on_site' }, labels).inventory).toEqual(['on_site']);
  });

  it('501–2,500 sq ft prefills as the 1,000–5,000 box (the client, 29 Oct 2026)', () => {
    expect(prefillAnswers({ square_footage: '501_2500' }, labels).square_footage).toEqual(['1000_5000']);
  });

  it('entity type Other against a Gov / Public CRM value is the same answer', () => {
    expect(find(proposalsFrom({ entity_type: ['other'] }, { entity_type: 'gov' }, labels), 'field:entity_type')).toBeUndefined();
    expect(find(proposalsFrom({ entity_type: ['corporation'] }, {}, labels), 'field:entity_type')?.value).toBe('corp');
  });

  it('delivery time is one of the CRM choices on the application (client, 28 Oct)', () => {
    expect(find(proposalsFrom({ product_received_time: '6-10 days' }, {}, labels), 'field:order_to_service')?.value).toBe('6_10_days');
    expect(find(proposalsFrom({ product_received_time: '11+ days' }, {}, labels), 'field:order_to_service')?.value).toBe('11_days');
    expect(prefillAnswers({ order_to_service: '2_5_days' }, labels).product_received_time).toBe('2-5 days');
  });

  it('product received time from an older free-text PDF maps to the CRM bucket, or asks', () => {
    expect(find(proposalsFrom({ product_received_time: '3-5 days' }, {}, labels), 'field:order_to_service')?.value).toBe('2_5_days');
    expect(find(proposalsFrom({ product_received_time: 'same day' }, {}, labels), 'field:order_to_service')?.value).toBe('24_hours');
    expect(find(proposalsFrom({ product_received_time: '2 weeks' }, {}, labels), 'field:order_to_service')?.value).toBe('11_days');
    expect(find(proposalsFrom({ product_received_time: 'depends' }, {}, labels), 'field:order_to_service')?.candidates).toHaveLength(4);
  });

  it('a PDF address line is split into parts when it can be', () => {
    expect(parseAddress('1 Main St, Suite 2, Austin, tx 78701')).toEqual({ street: '1 Main St', street2: 'Suite 2', city: 'Austin', state: 'TX', zip: '78701' });
    expect(parseAddress('somewhere odd').street).toBe('somewhere odd');
  });
});

describe('the review rules (classify)', () => {
  const crm: CrmValues = { dba: 'Old Name', legal_business_name: '', monthly_acq_volume: '50000', square_footage: '2501_5000' };
  const ps = proposalsFrom(
    { dba: 'New Name', legal_business_name: 'Acme LLC', monthly_acq_volume: '$50,000.00', square_footage: ['1000_5000'] },
    crm,
    labels,
  );
  const status = (key: string) => classify(find(ps, key)!, crm).status;

  it('CRM empty, answer given → written automatically', () => expect(status('field:legal_business_name')).toBe('applied'));
  it('same as CRM → nothing to do (50,000 = $50,000.00)', () => expect(status('field:monthly_acq_volume')).toBe('same'));
  it('different → held for review', () => expect(status('field:dba')).toBe('pending'));
  it('a pick whose candidates include the CRM value → nothing to do', () => expect(status('field:square_footage')).toBe('same'));
  it('answer blank, CRM has a value → CRM kept (no proposal at all)', () => {
    expect(proposalsFrom({ dba: '' }, crm, labels)).toEqual([]);
  });
});

describe('one write', () => {
  it('merges members into the current owners and pads the paired SSN group', () => {
    const crm: CrmValues = { owner_ownership: [{ first: 'Joe', last: 'B', title: 'CEO' }], owner_private: [{ ssn: '111223333' }] };
    const w = buildWrite(
      [
        { target: { kind: 'member', field: 'owner_ownership', index: 1, member: 'first' }, value: 'Mary', question: 'x' },
        { target: { kind: 'member', field: 'owner_ownership', index: 0, member: 'title' }, value: 'Owner', question: 'x' },
        { target: { kind: 'note', field: 'bankruptcy' }, value: 'Ch. 7', question: 'Bankruptcy details' },
      ],
      crm,
    );
    expect(w.values.owner_ownership).toEqual([{ first: 'Joe', last: 'B', title: 'Owner' }, { first: 'Mary' }]);
    expect(w.values.owner_private).toEqual([{ ssn: '111223333' }, {}]);
    expect(w.notes).toEqual([{ field_key: 'bankruptcy', body: 'Bankruptcy details: Ch. 7' }]);
  });
});

describe('helpers and catalog', () => {
  it('numbers lose $, % and commas; junk is no answer', () => {
    expect(cleanNumber('$1,234.50')).toBe('1234.5');
    expect(cleanNumber('12%')).toBe('12');
    expect(cleanNumber('n/a')).toBe('');
  });
  it('dates from what people type', () => {
    expect(cleanDate('3/7/2019')).toBe('2019-03-07');
    expect(cleanDate('2019-03-07')).toBe('2019-03-07');
    expect(cleanDate('02/30/2019')).toBe('');
    expect(cleanDate('2015')).toBe('2015-01-01');
  });
  it('days from free text', () => {
    expect(receivedDays('48 hours')).toBe(2);
    expect(receivedDays('1 week')).toBe(7);
    expect(receivedDays('whenever')).toBeNull();
  });
  it('target keys round-trip', () => {
    for (const k of ['field:dba', 'note:seasonal', 'member:owner_ownership.2.first']) expect(targetKey(parseTargetKey(k)!)).toBe(k);
    expect(parseTargetKey('field:../x')).toBeNull();
  });
  it('the removed questions are gone and the new ones are in', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(ids.some((i) => /type_of_business|terminals/.test(i))).toBe(false);
    expect(ids).toContain('service_model');
    expect(ids).toContain('ach_monthly_transactions');
    expect(ids).toContain('return_policy');
    expect(answerKeys().has('owner4_ssn')).toBe(true);
    expect(answerKeys().has('sales_method_internet')).toBe(true);
  });
});
