/**
 * The ACH Authorization Form, added as the last page of both agreements
 * ("ACH Agreement addition", client, 3 Nov 2026).
 *
 * - On the card agreement and the ACH agreement alike, as the last page.
 * - Only when Merchant setup › Merchant Pricing › Acquirer › Monthly Dashboard
 *   Fee holds an amount: "If fillable field is empty it is fine and the ach
 *   agreement will not be included". Zero is read as empty: a monthly debit of
 *   nothing is no debit.
 * - Tenor Payments' name and branding throughout, and the debit sentence the
 *   client rewrote: "Debits will occur monthly in the amount of {fee} as well as
 *   any other amounts owed under the governing agreement between the parties."
 * - Filled from the CRM as the client's form marks it: Name on Account and Legal
 *   Business Name from Legal business name; Routing and Account numbers from
 *   Applications › Protected; the signer is the largest shareholder among the
 *   agreement's signers, with their title. Checking is ticked, as on the form.
 *
 * Drawn here rather than kept as a template: the client's PDF is TapDash's, and
 * every word on it that changes is Tenor's. Same layout, same wording.
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { str } from './format';
import type { AgreementSource, Used } from './kinds/types';
import type { SignatureSpot } from './pdf';
import type { Signer } from './signers';

/** The field whose amount decides the page and fills its debit sentence. */
export const DASHBOARD_FEE_KEY = 'td_monthly_fee_tapdash';

export const TENOR = {
  legalName: 'Tenor Payments LLC',
  address: '1815 Lakewood Road, STE 165, Toms River, NJ 08755',
  revocationEmail: 'support@tenorpayments.com',
};

const NAVY = rgb(0x10 / 255, 0x23 / 255, 0x47 / 255);
const INK = rgb(0.13, 0.15, 0.2);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.8, 0.82, 0.86);

export type AchAuthorization = {
  include: boolean;
  amount: string;
  legalName: string;
  routing: string;
  account: string;
  signer: Signer | null;
  used: Used[];
};

function feeAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The largest shareholder among the people signing; the earlier slot on a tie. */
export function largestShareholder(signers: Signer[]): Signer | null {
  return signers.reduce<Signer | null>((best, s) => (!best || s.percentage > best.percentage ? s : best), null);
}

export function achAuthorization(src: AgreementSource, signers: Signer[]): AchAuthorization {
  const fee = feeAmount(src.values[DASHBOARD_FEE_KEY]);
  const signer = largestShareholder(signers);
  return {
    include: fee !== null,
    amount: fee === null ? '' : fee.toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
    legalName: str(src.values.legal_business_name),
    routing: str(src.values.routing_number),
    account: str(src.values.account_number),
    signer,
    used: fee === null
      ? []
      : [
          { fieldKey: DASHBOARD_FEE_KEY, kind: 'value' },
          { fieldKey: 'legal_business_name', kind: 'value' },
          { fieldKey: 'routing_number', kind: 'value' },
          { fieldKey: 'account_number', kind: 'value' },
          ...(signer ? ([{ fieldKey: 'owner_ownership', index: signer.index, member: 'first', kind: 'value' },
                        { fieldKey: 'owner_ownership', index: signer.index, member: 'title', kind: 'value' }] as Used[]) : []),
        ],
  };
}

/** Words that fit `width`, one line each. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Appends the page to an already flattened agreement. Returns the new bytes and
 * the signature and date spots for the signer, in the same terms as the
 * template's own spots (points, origin bottom-left).
 */
export async function appendAchAuthorization(
  flat: Uint8Array,
  ach: AchAuthorization,
): Promise<{ bytes: Uint8Array; spots: SignatureSpot[] }> {
  const doc = await PDFDocument.load(flat);
  const W = 612;
  const H = 792;
  const page = doc.addPage([W, H]);
  const pageNo = doc.getPageCount();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const logo = await doc.embedPng(await readFile(path.join(process.cwd(), 'src', 'lib', 'agreements', 'template', 'tenor-logo.png')));

  const left = 54;
  const right = W - 54;
  const width = right - left;
  let y = H - 50;

  // ── letterhead ────────────────────────────────────────────────────────────
  const logoH = 40;
  const logoW = (logo.width / logo.height) * logoH;
  page.drawImage(logo, { x: left, y: y - logoH, width: logoW, height: logoH });
  page.drawText(TENOR.legalName, { x: right - bold.widthOfTextAtSize(TENOR.legalName, 11), y: y - 16, size: 11, font: bold, color: NAVY });
  page.drawText(TENOR.address, { x: right - regular.widthOfTextAtSize(TENOR.address, 8.5), y: y - 30, size: 8.5, font: regular, color: MUTED });
  y -= logoH + 34;
  const title = 'ACH AUTHORIZATION FORM';
  page.drawText(title, { x: (W - bold.widthOfTextAtSize(title, 15)) / 2, y, size: 15, font: bold, color: NAVY });
  y -= 26;

  const bar = (label: string) => {
    page.drawRectangle({ x: left, y: y - 20, width, height: 20, color: NAVY });
    page.drawText(label, { x: left + 9, y: y - 14, size: 9.5, font: bold, color: rgb(1, 1, 1) });
    y -= 20;
  };
  /** A bordered row: label, then a value (or nothing, for a signature box). */
  const row = (label: string, value: string, h = 26, opts: { split?: { label: string; value: string } } = {}) => {
    page.drawRectangle({ x: left, y: y - h, width, height: h, borderColor: RULE, borderWidth: 0.75 });
    page.drawText(label, { x: left + 9, y: y - h / 2 - 3, size: 8.5, font: regular, color: INK });
    const lw = regular.widthOfTextAtSize(label, 8.5);
    if (value) page.drawText(value, { x: left + 15 + lw, y: y - h / 2 - 4, size: 11, font: regular, color: INK });
    if (opts.split) {
      const mid = left + width * 0.55;
      page.drawLine({ start: { x: mid, y }, end: { x: mid, y: y - h }, color: RULE, thickness: 0.75 });
      page.drawText(opts.split.label, { x: mid + 9, y: y - h / 2 - 3, size: 8.5, font: regular, color: INK });
      const sw = regular.widthOfTextAtSize(opts.split.label, 8.5);
      if (opts.split.value) page.drawText(opts.split.value, { x: mid + 15 + sw, y: y - h / 2 - 4, size: 11, font: regular, color: INK });
    }
    const top = y;
    y -= h;
    return { top, h };
  };
  const tick = (x: number, yy: number, on: boolean, label: string) => {
    page.drawRectangle({ x, y: yy, width: 11, height: 11, borderColor: INK, borderWidth: 0.9 });
    if (on) {
      page.drawLine({ start: { x: x + 2.2, y: yy + 5.6 }, end: { x: x + 4.6, y: yy + 2.6 }, thickness: 1.4, color: INK });
      page.drawLine({ start: { x: x + 4.6, y: yy + 2.6 }, end: { x: x + 9, y: yy + 9 }, thickness: 1.4, color: INK });
    }
    page.drawText(label, { x: x + 16, y: yy + 2, size: 9, font: regular, color: INK });
  };

  // ── bank account ──────────────────────────────────────────────────────────
  bar('BANK ACCOUNT INFORMATION');
  row('Name on Account:', ach.legalName);
  row('Routing Number:', ach.routing);
  row('Account Number:', ach.account);
  const typeRow = row('Account Type:', '');
  const ty = typeRow.top - typeRow.h / 2 - 5.5;
  const tx = left + 15 + regular.widthOfTextAtSize('Account Type:', 8.5);
  tick(tx, ty, true, 'Checking');
  tick(tx + 78, ty, false, 'Savings');
  y -= 16;

  // ── terms ─────────────────────────────────────────────────────────────────
  bar('AUTHORIZATION TERMS');
  y -= 6;
  const paragraphs: { text: string; amount?: string }[] = [
    { text: `The undersigned business entity ("Client") authorizes ${TENOR.legalName} ("Company") to initiate ACH debit entries to the U.S. business bank account identified below.` },
    { text: 'Entries will be initiated as ACH debits under the CCD (Corporate Credit or Debit) Standard Entry Class code pursuant to the NACHA Operating Rules.' },
    { text: `Debits will occur monthly in the amount of ${ach.amount} as well as any other amounts owed under the governing agreement between the parties.`, amount: ach.amount },
    { text: `This authorization will remain in effect until Company receives written notice of revocation at least three (3) business days prior to the next scheduled debit. Revocation must be submitted in writing to ${TENOR.revocationEmail} or by mail to ${TENOR.address}.` },
    { text: 'This authorization may be executed electronically. An electronic signature shall have the same legal effect as a handwritten signature.' },
  ];
  for (const p of paragraphs) {
    for (const line of wrap(p.text, regular, 9, width)) {
      y -= 12;
      drawLine(page, line, left, y, regular, bold, p.amount);
    }
    y -= 5;
  }
  y -= 12;

  // ── signature ─────────────────────────────────────────────────────────────
  bar('AUTHORIZED SIGNATURE');
  row('Legal Business Name:', ach.legalName);
  row('Authorized Signer Name:', ach.signer?.name ?? '', 26, { split: { label: 'Title:', value: ach.signer?.title ?? '' } });
  const signRow = row('Signature:', '', 34, { split: { label: 'Date:', value: '' } });
  y -= 12;
  const note = 'This form complies with the NACHA Operating Rules for CCD one time or recurring debit authorizations. Retain a copy for your records.';
  for (const line of wrap(note, italic, 7.5, width)) {
    page.drawText(line, { x: left, y, size: 7.5, font: italic, color: MUTED });
    y -= 10;
  }

  // Where the signer signs and dates: inside the two boxes of the signature row.
  const sigLabelW = regular.widthOfTextAtSize('Signature:', 8.5);
  const mid = left + width * 0.55;
  const dateLabelW = regular.widthOfTextAtSize('Date:', 8.5);
  const boxY = signRow.top - signRow.h + 5;
  const boxH = signRow.h - 10;
  const spots: SignatureSpot[] = ach.signer
    ? [
        { slot: ach.signer.slot, kind: 'signature', page: pageNo, x: left + 16 + sigLabelW, y: boxY, w: mid - (left + 22 + sigLabelW), h: boxH, pageWidth: W, pageHeight: H },
        { slot: ach.signer.slot, kind: 'date', page: pageNo, x: mid + 16 + dateLabelW, y: boxY, w: right - (mid + 22 + dateLabelW), h: boxH, pageWidth: W, pageHeight: H },
      ]
    : [];
  return { bytes: await doc.save(), spots };
}

/** One line, with the amount in bold where it appears. */
function drawLine(page: PDFPage, line: string, x: number, y: number, regular: PDFFont, bold: PDFFont, amount?: string) {
  const at = amount ? line.indexOf(amount) : -1;
  if (at < 0 || !amount) {
    page.drawText(line, { x, y, size: 9, font: regular, color: INK });
    return;
  }
  const before = line.slice(0, at);
  const after = line.slice(at + amount.length);
  page.drawText(before, { x, y, size: 9, font: regular, color: INK });
  const bx = x + regular.widthOfTextAtSize(before, 9);
  page.drawText(amount, { x: bx, y, size: 9, font: bold, color: INK });
  page.drawText(after, { x: bx + bold.widthOfTextAtSize(amount, 9), y, size: 9, font: regular, color: INK });
}
