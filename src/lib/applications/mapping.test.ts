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

  it('the ACH questions show the record’s own ACH figures when it has them', () => {
    const own = prefillAnswers({ monthly_acq_volume: '50000', monthly_ach_volume: '12000', avg_transaction: '40', ach_avg_transaction: '250', max_transaction: '900', ach_max_transaction: '5000' }, labels);
    expect(own.monthly_acq_volume).toBe('50000');
    expect(own.monthly_ach_volume).toBe('12000');
    expect(own.average_ach_transaction_amount).toBe('250');
    expect(own.maximum_ach_transaction_amount).toBe('5000');
    expect(own.average_transaction_amount).toBe('40');
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

/**
 * The client's "app fields.xlsx" (CRM field → application question), row by
 * row. Every row that names an application question: the answer lands in that
 * CRM field, and the CRM field prefills that question. The sheet itself is a
 * client document and stays out of the repository, so its rows live here.
 */
describe('app fields.xlsx: every application question and its CRM field', () => {
  const address = { street: '1 Main St', street2: '', city: 'Austin', state: 'TX', zip: '78701' };
  const answers = {
    legal_business_name: 'Acme Holdings LLC', dba: 'Joe Pizza', merchant_address: address, retail_address: address,
    contact_email: 'joe@acme.test', contact_phone: '5125550100', merchant_website: 'https://acme.test', business_founded_date: '2019-04-02',
    entity_type: ['partnership'], building_ownership: 'Own', area_zoned: ['commercial'], square_footage: ['1_1000'],
    seasonal: 'Yes', seasonal_details: 'June, July', inventory: ['on_site'], advertising_method: 'Instagram',
    product_received_time: '2-5 days', return_policy: 'Refunds within 30 days', bankruptcy: 'No', cc_termination: 'No',
    customer_type_b2c: '100', customer_profile_local: '100', sales_method_in_person: '100', payment_codes_ccd: '100',
    monthly_acq_volume: '50000', average_transaction_amount: '40', maximum_transaction_amount: '900',
    ach_monthly_returns: '2', ach_refunds: 'Yes',
    owner1_first: 'Joe', owner1_last: 'Berg', owner1_title: 'CEO', owner1_phone: '5125550100', owner1_email: 'joe@acme.test', owner1_percentage: '60',
    owner1_ssn: '123-45-6789', prior_processor: 'Square', prior_pos: 'Clover',
  };
  const landed = new Set(proposalsFrom(answers, {}, labels).map((p) => targetKey(p.target)));

  // [sheet row ("Cells"), the application question, where it must land]
  const ROWS: [string, string, string][] = [
    ['Merchant Address', 'Address', 'field:merchant_address'],
    ['Contact Email', 'Business email address', 'member:contact.0.email'],
    ['Contact Phone', 'business phone number', 'member:contact.0.phone'],
    ['Legal Business Name', 'Legal/corporate name', 'field:legal_business_name'],
    ['Merchant Website', 'Website address', 'field:merchant_website'],
    ['ACH Return', 'Do you issue refunds via ACH? (its own field since 30 Oct)', 'field:ach_refunds'],
    ['Retail Address', 'Retail address', 'field:retail_address'],
    ['DBA', 'DBA', 'field:dba'],
    ['Entity Type', 'Type of entity', 'field:entity_type'],
    ['Business Founded Date', 'Business founded date', 'field:business_founded_date'],
    ['Seasonal', 'Is the business seasonal', 'field:seasonal'],
    ['Seasonal', '(add notes section also)', 'note:seasonal'],
    ['How Long After Order Is Product Received', 'How long after order is service/product received', 'field:order_to_service'],
    ['Building Ownership', 'Do you own, lease or rent the property', 'field:building_ownership'],
    ['Area Zoned', 'How is the property zoned', 'field:area_zoned'],
    ['Square Footage', 'Estimated square footage', 'field:square_footage'],
    ['Inventory', 'Where is your inventory stored (select all applicable)?', 'field:inventory'],
    ['Advertising Method', 'List your primary advertising methods', 'field:advertising_method'],
    ['Bankruptcy', 'has the business or any of its principals ever filed for bankruptcy', 'field:bankruptcy'],
    ['Customer Type', 'breakdown of your customer base (must equal 100%)', 'field:customer_type'],
    ['Customer Profile', 'customers geographic distribution (must equal 100%)', 'field:customer_profile'],
    ['Sales Method', 'breakdown of credit card payment type (must equal 100%)', 'field:sales_method'],
    ['Return policy', 'What is your return policy (enter N/A if none)?', 'field:refund_policy'],
    ['Monthly ACQ Volume', 'Average monthly credit card volume / ACH volume', 'field:monthly_acq_volume'],
    ['Average Transaction Amount', 'Average ticket / Average ACH transaction amount', 'field:avg_transaction'],
    ['Maximum Transaction Amount', 'High ticket / Maximum ACH transaction amount', 'field:max_transaction'],
    ['CC Termination', 'ever been terminated from accepting bank cards?', 'field:cc_termination'],
    ['ACH Monthly Returns', '# of Monthly ACH Returns', 'field:ach_monthly_returns'],
    ['Payment Codes', 'percentage of your ACH transactions by type (must total 100%)', 'field:payment_codes'],
    ['SSN', 'Social security number', 'member:owner_private.0.ssn'],
    ['First Name', 'Corporate officer/Owner name', 'member:owner_ownership.0.first'],
    ['Last Name', 'Corporate officer/Owner name', 'member:owner_ownership.0.last'],
    ['Title', 'Title', 'member:owner_ownership.0.title'],
    ['Phone', 'Phone number', 'member:owner_ownership.0.phone'],
    ['Email', 'Email address', 'member:owner_ownership.0.email'],
    ['Percentage', 'Ownership %', 'member:owner_ownership.0.percentage'],
    ['Prior Processor', 'Current processing company', 'field:prior_processor'],
    ['Prior POS', 'Current terminal type or POS', 'field:prior_pos'],
  ];

  it.each(ROWS)('%s ← “%s” lands in %s', (_cell, _question, target) => {
    expect(landed.has(target)).toBe(true);
  });

  it('and the CRM fields prefill those questions', () => {
    const crm: CrmValues = {
      legal_business_name: 'Acme Holdings LLC', dba: 'Joe', merchant_address: address, retail_address: address,
      contact: [{ email: 'joe@acme.test', phone: '5125550100' }], merchant_website: 'https://acme.test', business_founded_date: '2019-04-02',
      entity_type: 'partnership', building_ownership: 'owns', area_zoned: 'commercial', seasonal: ['jun', 'jul'],
      inventory: ['on_site'], advertising_method: 'Instagram', refund_policy: '30 days', bankruptcy: 'never', cc_termination: 'no',
      monthly_acq_volume: '50000', avg_transaction: '40', max_transaction: '900', ach_monthly_returns: '2', ach_refunds: 'yes',
      owner_ownership: [{ first: 'Joe', last: 'Berg', title: 'CEO', percentage: '60', email: 'joe@acme.test', phone: '5125550100' }],
      prior_processor: 'Square', prior_pos: 'Clover',
    };
    const a = prefillAnswers(crm, labels);
    for (const id of ['legal_business_name', 'dba', 'merchant_address', 'retail_address', 'contact_email', 'contact_phone', 'merchant_website',
      'business_founded_date', 'entity_type', 'building_ownership', 'area_zoned', 'seasonal', 'inventory', 'advertising_method', 'return_policy',
      'bankruptcy', 'cc_termination', 'monthly_acq_volume', 'average_transaction_amount', 'maximum_transaction_amount', 'ach_monthly_returns',
      'ach_refunds', 'owner1_first', 'owner1_last', 'owner1_title', 'owner1_percentage', 'owner1_email', 'owner1_phone', 'prior_processor', 'prior_pos']) {
      expect(a[id], id).toBeTruthy();
    }
  });
});
