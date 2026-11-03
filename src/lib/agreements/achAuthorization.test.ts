import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { maverickAch } from './kinds/maverickAch';
import { maverickMerchant } from './kinds/maverickMerchant';
import { renderAgreement } from './mapping';
import { selectSigners } from './signers';
import type { AgreementSource } from './kinds/types';

vi.mock('server-only', () => ({}));

const owners = [
  { first: 'John', last: 'Roe', title: 'CFO', email: 'john@zz.test', phone: '5125550102', percentage: 35 },
  { first: 'Jane', last: 'Doe', title: 'CEO', email: 'jane@zz.test', phone: '5125550101', percentage: 65 },
];
const source = (fee: unknown): AgreementSource => ({
  values: {
    legal_business_name: 'ZZ Acme Holdings LLC', routing_number: '021000021', account_number: '000123456789',
    owner_ownership: owners, td_monthly_fee_tapdash: fee,
  },
  addresses: {},
  notes: {},
  label: (_f, c) => c,
  sentAt: new Date(Date.UTC(2026, 10, 3)),
});
const signers = selectSigners(owners.map((o, index) => ({ index, ...o }))).signers;

async function pageText(pdf: Uint8Array, page: number): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    standardFontDataUrl: new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
  }).promise;
  const p = await doc.getPage(page);
  const content = await p.getTextContent();
  const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
  await doc.destroy();
  return text.replace(/\s+/g, ' ');
}

describe('the ACH Authorization Form (ACH Agreement addition, 3 Nov 2026)', () => {
  it('is added only when the Monthly Dashboard Fee holds an amount', async () => {
    const { achAuthorization } = await import('./achAuthorization');
    expect(achAuthorization(source(''), signers).include).toBe(false);
    expect(achAuthorization(source(null), signers).include).toBe(false);
    expect(achAuthorization(source(0), signers).include).toBe(false);
    const on = achAuthorization(source('49.5'), signers);
    expect(on.include).toBe(true);
    expect(on.amount).toBe('$49.50');
  });

  it('is signed by the largest shareholder among the signers', async () => {
    const { achAuthorization } = await import('./achAuthorization');
    const a = achAuthorization(source(25), signers);
    expect(a.signer?.name).toBe('Jane Doe');
    expect(a.used.map((u) => u.fieldKey)).toEqual(expect.arrayContaining(['td_monthly_fee_tapdash', 'legal_business_name', 'routing_number', 'account_number', 'owner_ownership']));
  });

  it.each([
    ['card', maverickMerchant],
    ['ACH', maverickAch],
  ])('is the last page of the %s agreement, in Tenor’s name, with the new debit wording', async (_name, kind) => {
    const { fillAndFlatten, loadTemplate } = await import('./pdf');
    const { achAuthorization, appendAchAuthorization } = await import('./achAuthorization');
    const { pdf } = await loadTemplate(kind);
    const src = source('49.5');
    const filled = await fillAndFlatten(kind, pdf, renderAgreement(kind, src, signers).byPdfField);
    const before = (await PDFDocument.load(filled)).getPageCount();
    const { bytes, spots } = await appendAchAuthorization(filled, achAuthorization(src, signers));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(before + 1);

    const text = await pageText(bytes, before + 1);
    expect(text).toContain('ACH AUTHORIZATION FORM');
    expect(text).toContain('Tenor Payments LLC');
    expect(text).toContain('support@tenorpayments.com');
    expect(text).not.toMatch(/tapdash/i);
    expect(text).toContain('Debits will occur monthly in the amount of $49.50 as well as any other amounts owed under the governing agreement between the parties.');
    expect(text).toContain('ZZ Acme Holdings LLC');
    expect(text).toContain('021000021');
    expect(text).toContain('000123456789');
    expect(text).toContain('Jane Doe');
    expect(text).toContain('CEO');

    // The signer's signature and date, on that page, inside it.
    expect(spots.map((s) => s.kind)).toEqual(['signature', 'date']);
    for (const s of spots) {
      expect(s.page).toBe(before + 1);
      expect(s.slot).toBe(signers.find((x) => x.name === 'Jane Doe')!.slot);
      expect(s.x).toBeGreaterThan(0);
      expect(s.x + s.w).toBeLessThan(s.pageWidth);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y + s.h).toBeLessThan(s.pageHeight);
    }
  });
});
