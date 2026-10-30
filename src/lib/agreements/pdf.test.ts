import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { maverickMerchant } from './kinds/maverickMerchant';
import { renderAgreement } from './mapping';
import { selectSigners } from './signers';
import type { AgreementSource } from './kinds/types';

vi.mock('server-only', () => ({}));

const owners = [
  { first: 'Jane', last: 'Doe', title: 'CEO', email: 'jane@zz.test', phone: '5125550101', percentage: 60 },
  { first: 'John', last: 'Roe', title: 'CFO', email: 'john@zz.test', phone: '5125550102', percentage: 40 },
];
const src: AgreementSource = {
  values: {
    legal_business_name: 'ZZ Acme Holdings LLC', ein: '123456789', dba: 'ZZ Pizza',
    merchant_address: { street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' },
    entity_type: 'llc', building_ownership: 'leases', square_footage: '501_2500', pricing_model: 'fr', bankruptcy: 'never', prior_processor: 'No', seasonal: ['Jun'],
    sales_method: { in_person: 70, mail_phone: 10, ecommerce: 20 }, td_vmd_volume: 2.95,
    owner_ownership: owners, owner_private: [{ ssn: '123456789' }, { ssn: '987654321' }],
  },
  addresses: {},
  notes: {},
  label: (_f, c) => c,
  sentAt: new Date(Date.UTC(2026, 9, 27)),
};
const signers = selectSigners(owners.map((o, index) => ({ index, ...o }))).signers;

async function pageText(pdf: Uint8Array, page: number): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // A fresh copy: pdf.js transfers the buffer to its worker and leaves the
  // caller's one detached; the standard-font folder keeps it quiet about Dingbats.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    standardFontDataUrl: new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
  }).promise;
  const p = await doc.getPage(page);
  const content = await p.getTextContent();
  const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
  await doc.destroy();
  return text;
}

describe('the Maverick agreement PDF', () => {
  it('fills, keeps the client’s drawings, removes the signature spots and flattens', async () => {
    const { fillAndFlatten, loadTemplate, signatureSpots } = await import('./pdf');
    const { pdf, fields } = await loadTemplate(maverickMerchant);
    const rendered = renderAgreement(maverickMerchant, src, signers);
    const out = await fillAndFlatten(maverickMerchant, pdf, rendered.byPdfField);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(13);
    // Nothing left to edit.
    expect(doc.getForm().getFields().length).toBe(0);
    // The printed values are page content now, not form values.
    const text = await pageText(out, 1);
    expect(text).toContain('ZZ Acme Holdings LLC');
    expect(text).toContain('12-3456789');
    expect(text).toContain('123-45-6789');
    expect(text).toContain('ZZ Pizza');
    expect(await pageText(out, 4)).toContain('ZZ Acme Holdings LLC');
    expect(out.byteLength).toBeLessThan(2_000_000);

    const spots = signatureSpots(maverickMerchant, fields, signers);
    // Two signers × (acceptance + guarantee + bank disclosure) × (signature + date)
    expect(spots).toHaveLength(12);
    expect(spots.filter((s) => s.kind === 'signature' && s.slot === 1).map((s) => s.page)).toEqual([4, 5, 5]);
    expect(spots.every((s) => s.w > 50 && s.h > 5 && s.pageHeight === 786)).toBe(true);
  }, 30_000);

  it('a single signer leaves slots 2–4 without spots', async () => {
    const { loadTemplate, signatureSpots } = await import('./pdf');
    const { fields } = await loadTemplate(maverickMerchant);
    expect(signatureSpots(maverickMerchant, fields, signers.slice(0, 1))).toHaveLength(6);
  });

  it('names the signed file as the spec says', async () => {
    const { agreementFileName } = await import('./pdf');
    expect(agreementFileName('ZZ Acme / Holdings', 'Merchant Agreement', new Date(2026, 9, 27))).toBe('ZZ Acme Holdings - Merchant Agreement - Signed 10-27-2026.pdf');
    expect(agreementFileName('', 'Merchant Agreement')).toBe('Merchant - Merchant Agreement.pdf');
  });
});
