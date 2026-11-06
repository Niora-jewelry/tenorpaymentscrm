import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { QUESTIONS, SECTIONS, type Answers } from './catalog';
import { copySections, submittedCopyPdf } from './submittedCopy';

const answers: Answers = {
  legal_business_name: 'Full Flow Test LLC',
  merchant_address: { street: '100 Alpha Street', street2: 'Suite 200', city: 'Austin', state: 'TX', zip: '78701' },
  building_ownership: 'Lease',
  square_footage: ['2501_5000'],
  monthly_acq_volume: '40000',
  sales_method_internet: '10',
  sales_method_in_person: '90',
  sales_method_mail_phone: '0',
  inventory: ['on_site', 'other'],
  owner1_first: 'Test',
  owner1_last: 'One',
  owner1_percentage: '100',
  owner1_ssn: '123456789',
  owner1_dob: '1980-02-03',
};

const row = (label: string, a: Answers = answers, onFile: Record<number, string> = {}) =>
  copySections(a, onFile)
    .flatMap((s) => s.rows)
    .find((r) => r.label === label)?.value;

describe('the copy of a submitted application', () => {
  it('holds every question on the form, blank ones as a dash', () => {
    const labels = copySections(answers, {}).flatMap((s) => s.rows.map((r) => r.label));
    for (const q of QUESTIONS) expect(labels).toContain(q.label);
    expect(row('DBA (If different than legal)')).toBe('—');
  });

  it('shows answers as the merchant saw them', () => {
    expect(row('Address')).toBe('100 Alpha Street, Suite 200, Austin, TX 78701');
    expect(row('Do you own, lease or rent the property?')).toBe('Lease');
    expect(row('Estimated square footage')).toBe('2501-5000');
    expect(row('Average monthly credit card volume')).toBe('$40000');
    expect(row('Where is your inventory stored (select all applicable)?')).toBe('On-site, Other');
    expect(row('Estimate the breakdown of credit card payment type (must equal 100%)')).toBe('Internet/eCommerce: 10%\nIn Person: 90%\nMail/Phone: 0%');
    expect(row('Owner 1: date of birth')).toBe('02/03/1980');
  });

  it('never holds a whole SSN', () => {
    expect(row('Owner 1: SSN')).toBe('•••-••-6789');
    expect(JSON.stringify(copySections(answers, {}))).not.toContain('123456789');
  });

  it('says an SSN is on file when the merchant typed none', () => {
    const a: Answers = { owner1_first: 'Test' };
    expect(row('Owner 1: SSN', a, { 1: '•••-••-1234' })).toBe('On file (•••-••-1234)');
  });

  it('lists only the owners given', () => {
    expect(row('Owner 2: name')).toBeUndefined();
    expect(copySections({}, {}).find((s) => s.title === SECTIONS[1]!.title)?.rows).toEqual([]);
  });

  it('draws a PDF, whatever a merchant typed', async () => {
    const long = `${'word '.repeat(300)}https://example.test/${'x'.repeat(400)}`;
    const bytes = await submittedCopyPdf(
      { ...answers, return_policy: long, dba: 'Café 北京 🍕\ttab' },
      { label: 'APP-000300', merchant: 'Café 北京', submittedAt: new Date('2026-11-06T09:50:00Z'), ssnOnFile: {} },
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});
