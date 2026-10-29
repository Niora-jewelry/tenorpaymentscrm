import { describe, expect, it } from 'vitest';
import { isPhone, problemsWith, sanitizeAnswers } from './validate';

const owner = { owner1_name: 'Joe Smith', owner1_percentage: '60' };

describe('online form checks', () => {
  it('passes a sound application', () => {
    expect(problemsWith({ ...owner, sales_method_internet: '50', sales_method_in_person: '50' })).toEqual({});
  });

  it('a 100% group must add up to 100', () => {
    expect(problemsWith({ ...owner, sales_method_internet: '50', sales_method_in_person: '30' }).sales_method).toMatch(/100%.*80%/);
    expect(problemsWith({ ...owner, customer_type_b2c: '120' }).customer_type).toMatch(/0 to 100/);
    // An untouched group is not an error.
    expect(problemsWith(owner).payment_codes).toBeUndefined();
  });

  it('ownership must add up to at least 51%', () => {
    expect(problemsWith({ owner1_name: 'A B', owner1_percentage: '30' }).owners).toMatch(/30%/);
    expect(problemsWith({ owner1_name: 'A B', owner1_percentage: '30', owner2_name: 'C D', owner2_percentage: '21' }).owners).toBeUndefined();
    expect(problemsWith({}).owner1_name).toMatch(/at least one owner/);
  });

  it('emails and phone numbers must be valid', () => {
    const p = problemsWith({ ...owner, contact_email: 'joe@', contact_phone: '555-01', owner1_email: 'x@y.com', owner1_phone: '(512) 555-0100' });
    expect(p.contact_email).toBeDefined();
    expect(p.contact_phone).toBeDefined();
    expect(p.owner1_email).toBeUndefined();
    expect(p.owner1_phone).toBeUndefined();
    expect(isPhone('+44 20 7946 0958')).toBe(true);
  });

  it('details are required when Yes is picked', () => {
    expect(problemsWith({ ...owner, bankruptcy: 'Yes' }).bankruptcy_details).toBeDefined();
    expect(problemsWith({ ...owner, bankruptcy: 'Yes', bankruptcy_details: 'Ch 7' }).bankruptcy_details).toBeUndefined();
    expect(problemsWith({ ...owner, bankruptcy: 'No' }).bankruptcy_details).toBeUndefined();
  });

  it('an SSN must have 9 digits', () => {
    expect(problemsWith({ ...owner, owner1_ssn: '123-45-678' }).owner1_ssn).toBeDefined();
    expect(problemsWith({ ...owner, owner1_ssn: '123-45-6789' }).owner1_ssn).toBeUndefined();
  });
});

describe('sanitizeAnswers', () => {
  it('keeps only the application’s own keys and options', () => {
    const a = sanitizeAnswers({
      dba: 'Joe',
      evil: 'x',
      building_ownership: 'Castle',
      area_zoned: ['commercial', 'moon', 3],
      merchant_address: { street: '1 Main', city: 'Austin', state: 'TX', zip: '78701', extra: 'no' },
      owner1_ssn: '123456789',
    });
    expect(a).toEqual({
      dba: 'Joe',
      area_zoned: ['commercial'],
      merchant_address: { street: '1 Main', street2: '', city: 'Austin', state: 'TX', zip: '78701' },
      owner1_ssn: '123456789',
    });
  });
  it('rejects non-objects', () => {
    expect(sanitizeAnswers('x')).toEqual({});
    expect(sanitizeAnswers([1])).toEqual({});
  });
});
