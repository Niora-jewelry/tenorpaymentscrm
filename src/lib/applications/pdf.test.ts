import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFTextField } from 'pdf-lib';

vi.mock('server-only', () => ({}));
const { applicationFileName, fillApplicationPdf, readApplicationPdf } = await import('./pdf');

/** A small fillable PDF named the way the revised application is (Appendix). */
async function template(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  let y = 760;
  const at = () => ({ x: 40, y: (y -= 22), width: 200, height: 16 });
  for (const n of ['legal_business_name', 'dba', 'merchant_address', 'contact_email', 'monthly_acq_volume', 'owner1_name', 'owner1_ssn', 'bankruptcy_details']) {
    form.createTextField(n).addToPage(page, at());
  }
  const id = form.createTextField('tapdash_app_id');
  id.addToPage(page, at());
  id.enableReadOnly();
  for (const o of ['commercial', 'industrial', 'residential']) form.createCheckBox(`area_zoned__${o}`).addToPage(page, { ...at(), width: 12, height: 12 });
  const bo = form.createRadioGroup('building_ownership');
  for (const o of ['Own', 'Lease', 'Rent']) bo.addOptionToPage(o, page, { ...at(), width: 12, height: 12 });
  const bk = form.createRadioGroup('bankruptcy');
  for (const o of ['Yes', 'No']) bk.addOptionToPage(o, page, { ...at(), width: 12, height: 12 });
  form.createTextField('some_unknown_field').addToPage(page, at());
  return doc.save();
}

describe('application PDF', () => {
  it('fills by name, keeps it editable, sets the app id, and reads it all back', async () => {
    const filled = await fillApplicationPdf(
      await template(),
      {
        legal_business_name: 'Acme Holdings LLC',
        dba: "Joe's Pizza",
        merchant_address: '1 Main St, Austin, TX 78701',
        area_zoned: ['commercial', 'residential'],
        building_ownership: 'Lease',
        owner1_ssn: '123456789',
      },
      'APP-000123',
    );
    const doc = await PDFDocument.load(filled);
    const form = doc.getForm();
    // Not flattened: the fields are still there and still editable.
    expect(form.getFields().length).toBeGreaterThan(10);
    expect(form.getTextField('dba').isReadOnly()).toBe(false);
    // NeedAppearances is off.
    expect(form.acroForm.dict.get(PDFName.of('NeedAppearances'))).toBeUndefined();
    // An SSN is never written into the PDF, whatever is passed in.
    expect(form.getTextField('owner1_ssn').getText() ?? '').toBe('');

    const read = await readApplicationPdf(filled);
    expect(read.readable).toBe(true);
    expect(read.appLabel).toBe('APP-000123');
    expect(read.answers.legal_business_name).toBe('Acme Holdings LLC');
    expect(read.answers.area_zoned).toEqual(['commercial', 'residential']);
    expect(read.answers.building_ownership).toBe('Lease');
    // Unanswered radio and blank text are no answer — never "No".
    expect(read.answers.bankruptcy).toBeUndefined();
    expect(read.answers.contact_email).toBeUndefined();
    // Fields that are not part of the application are ignored.
    expect(read.answers).not.toHaveProperty('some_unknown_field');
  });

  it('reads what the merchant typed and ticked', async () => {
    const doc = await PDFDocument.load(await template());
    const form = doc.getForm();
    form.getTextField('owner1_name').setText('Mary Ann Smith');
    form.getTextField('owner1_ssn').setText('123-45-6789');
    form.getTextField('bankruptcy_details').setText('Ch. 7, 2015');
    form.getRadioGroup('bankruptcy').select('Yes');
    form.getCheckBox('area_zoned__industrial').check();
    (form.getField('tapdash_app_id') as PDFTextField).setText('APP-000999');
    const read = await readApplicationPdf(await doc.save());
    expect(read.answers).toMatchObject({
      owner1_name: 'Mary Ann Smith',
      owner1_ssn: '123-45-6789',
      bankruptcy: 'Yes',
      bankruptcy_details: 'Ch. 7, 2015',
      area_zoned: ['industrial'],
    });
    expect(read.appLabel).toBe('APP-000999');
  });

  it('a PDF with no form (scanned or printed to PDF) has no readable fields', async () => {
    const doc = await PDFDocument.create();
    doc.addPage().drawText('Scanned application');
    const read = await readApplicationPdf(await doc.save());
    expect(read).toMatchObject({ readable: false, fieldsFound: 0, appLabel: null, answers: {} });
    expect((await readApplicationPdf(new TextEncoder().encode('not a pdf'))).readable).toBe(false);
  });

  it('names the file after the DBA or legal name', () => {
    expect(applicationFileName("Joe's Pizza")).toBe("TapDash Application - Joe's Pizza.pdf");
    expect(applicationFileName('A/B: "C"')).toBe('TapDash Application - A B C.pdf');
    expect(applicationFileName('')).toBe('TapDash Application - Merchant.pdf');
  });
});

describe('the real application template (built from the client PDF)', () => {
  it('fills and reads every kind of field it holds — one-tick groups, the delivery dropdown, the hidden ID', async () => {
    const { loadTemplate } = await import('./pdf');
    const template = await loadTemplate();
    const filled = await fillApplicationPdf(
      template,
      {
        legal_business_name: 'Acme Holdings LLC',
        area_zoned: ['industrial'],
        entity_type: ['llc'],
        square_footage: ['1000_5000'],
        product_received_time: '2-5 days',
        building_ownership: 'Lease',
        inventory: ['on_site', 'fulfillment_center'],
        bankruptcy: 'No',
      },
      'APP-000042',
    );
    const read = await readApplicationPdf(filled);
    expect(read.readable).toBe(true);
    expect(read.appLabel).toBe('APP-000042');
    expect(read.answers).toMatchObject({
      legal_business_name: 'Acme Holdings LLC',
      area_zoned: ['industrial'],
      entity_type: ['llc'],
      square_footage: ['1000_5000'],
      product_received_time: '2-5 days',
      building_ownership: 'Lease',
      inventory: ['on_site', 'fulfillment_center'],
      bankruptcy: 'No',
    });
    // One tick only: the group is a single field, not three checkboxes.
    const doc = await PDFDocument.load(filled);
    expect(() => doc.getForm().getCheckBox('area_zoned__commercial')).toThrow();
    expect(doc.getForm().getRadioGroup('area_zoned').getSelected()).toBe('industrial');
    // The removed questions are not on it.
    const names = doc.getForm().getFields().map((f) => f.getName());
    expect(names.some((n) => /type_of_business|terminals/.test(n))).toBe(false);
    expect(names).toContain('tapdash_app_id');
  });
});

describe('the blank template', () => {
  it('reads back with no answers — nothing comes pre-selected (the client PDF had "Rent" chosen)', async () => {
    const { loadTemplate } = await import('./pdf');
    const read = await readApplicationPdf(await loadTemplate());
    expect(read.readable).toBe(true);
    expect(read.answers).toEqual({});
    expect(read.appLabel).toBeNull();
  });
});
