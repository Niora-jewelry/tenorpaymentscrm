/**
 * The copy of an online application as the merchant submitted it.
 *
 * Client test of 6 Nov 2026: "No copy of the submitted application … answers
 * lost cannot be recovered." The link's draft is cleared on submit, and the CRM
 * only ever held the answers it wrote, so nothing kept what actually came back.
 *
 * Drawn from the catalog rather than filled into the PDF template, so it holds
 * every question the online form asks, including the ones the template has no
 * field for. An SSN appears masked: the number itself lands in the Private
 * sub-tab, and a copy that a wider group can open has no need of it.
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { TENOR } from '@/lib/brand/tenor';
import { MAX_OWNERS, OWNER_LABELS, QUESTIONS, SECTIONS, ownerField, type AnswerValue, type Answers, type Question } from './catalog';
import { addressLine, parseAddress } from './mapping';

export type CopyRow = { label: string; value: string };
export type CopySection = { title: string; rows: CopyRow[] };

const BLANK = '—';
const text = (v: AnswerValue | undefined) => (typeof v === 'string' ? v.trim() : '');
const usDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
};
const address = (v: AnswerValue | undefined) => (v ? addressLine(parseAddress(v)) : '');

function shown(q: Question, a: Answers): string {
  const v = a[q.id];
  const label = (x: string) => q.options?.find((o) => o.value === x)?.label ?? x;
  switch (q.kind) {
    case 'address':
      return address(v);
    case 'money':
      return text(v) ? `$${text(v).replace(/^\$/, '')}` : '';
    case 'date':
      return usDate(text(v));
    case 'radio':
      return text(v) ? label(text(v)) : '';
    case 'checkboxes':
    case 'single_checkbox':
      return (Array.isArray(v) ? v : text(v) ? [text(v)] : []).map(label).join(', ');
    case 'percent_group':
      return (q.options ?? [])
        .filter((o) => text(a[`${q.id}_${o.value}`]))
        .map((o) => `${o.label}: ${text(a[`${q.id}_${o.value}`]).replace(/%$/, '')}%`)
        .join('\n');
    default:
      return text(v);
  }
}

/** Every question in form order, with what was answered. Blank questions stay, as a dash. */
export function copySections(a: Answers, ssnOnFile: Record<number, string>): CopySection[] {
  return SECTIONS.map((s) => {
    if (s.id === 'ownership') {
      const rows: CopyRow[] = [];
      for (let n = 1; n <= MAX_OWNERS; n++) {
        const name = [text(a[ownerField(n, 'first')]), text(a[ownerField(n, 'last')])].filter(Boolean).join(' ') || text(a[ownerField(n, 'name')]);
        const ssn = text(a[ownerField(n, 'ssn')]).replace(/\D/g, '');
        if (!name && !ssn && !ssnOnFile[n]) continue;
        const pct = text(a[ownerField(n, 'percentage')]).replace(/%$/, '');
        rows.push(
          { label: `Owner ${n}: name`, value: name || BLANK },
          { label: `Owner ${n}: ${OWNER_LABELS.title.toLowerCase()}`, value: text(a[ownerField(n, 'title')]) || BLANK },
          { label: `Owner ${n}: ${OWNER_LABELS.percentage.toLowerCase()}`, value: pct ? `${pct}%` : BLANK },
          { label: `Owner ${n}: ${OWNER_LABELS.email.toLowerCase()}`, value: text(a[ownerField(n, 'email')]) || BLANK },
          { label: `Owner ${n}: ${OWNER_LABELS.phone.toLowerCase()}`, value: text(a[ownerField(n, 'phone')]) || BLANK },
          { label: `Owner ${n}: ${OWNER_LABELS.dob.toLowerCase()}`, value: usDate(text(a[ownerField(n, 'dob')])) || BLANK },
          { label: `Owner ${n}: ${OWNER_LABELS.address.toLowerCase()}`, value: address(a[ownerField(n, 'address')]) || BLANK },
          { label: `Owner ${n}: SSN`, value: ssn.length >= 4 ? `•••-••-${ssn.slice(-4)}` : ssnOnFile[n] ? `On file (${ssnOnFile[n]})` : BLANK },
        );
      }
      return { title: s.title, rows };
    }
    const rows: CopyRow[] = [];
    for (const q of QUESTIONS.filter((x) => x.section === s.id)) {
      rows.push({ label: q.label, value: shown(q, a) || BLANK });
      if (q.details && text(a[q.details.id])) rows.push({ label: q.details.label, value: text(a[q.details.id]) });
      if (q.comments && text(a[q.comments.id])) rows.push({ label: q.comments.label, value: text(a[q.comments.id]) });
    }
    return { title: s.title, rows };
  });
}

// ── drawing ─────────────────────────────────────────────────────────────────

const PAGE = { w: 612, h: 792, margin: 48 };
const LABEL_W = 232;
const VALUE_X = PAGE.margin + LABEL_W + 16;
const VALUE_W = PAGE.w - PAGE.margin - VALUE_X;
const SIZE = 9.5;
const LINE = 13;
const NAVY = rgb(16 / 255, 35 / 255, 71 / 255);
const INK = rgb(0.13, 0.17, 0.24);
const MUTED = rgb(0.38, 0.44, 0.52);
const RULE = rgb(0.88, 0.9, 0.93);
const LOGO_PATH = path.join(process.cwd(), 'src', 'lib', 'agreements', 'template', 'tenor-logo.png');

/** Standard fonts draw WinAnsi only, and throw on anything else a merchant can type. */
function encodable(font: PDFFont): (s: string) => string {
  const known = new Set(font.getCharacterSet());
  return (s) => [...s.replace(/\s/g, ' ')].map((c) => (known.has(c.codePointAt(0)!) ? c : '?')).join('');
}

function wrap(raw: string, font: PDFFont, width: number, clean: (s: string) => string): string[] {
  const out: string[] = [];
  for (const para of raw.split('\n')) {
    let line = '';
    for (const word of clean(para).split(' ')) {
      let w = word;
      // A long unbroken string (a URL) is cut rather than run off the page.
      while (font.widthOfTextAtSize(w, SIZE) > width) {
        let n = w.length;
        while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), SIZE) > width) n--;
        if (line) out.push(line);
        line = '';
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, SIZE) > width) {
        out.push(line);
        line = w;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

export async function submittedCopyPdf(
  answers: Answers,
  meta: { label: string; merchant: string; submittedAt: Date; ssnOnFile: Record<number, string> },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${meta.label} submitted application`);
  doc.setCreator(TENOR.legalName);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = encodable(regular);

  let page: PDFPage = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - PAGE.margin;
  const room = (needed: number) => {
    if (y - needed >= PAGE.margin + 24) return;
    page = doc.addPage([PAGE.w, PAGE.h]);
    y = PAGE.h - PAGE.margin;
  };

  try {
    const logo = await doc.embedPng(await readFile(LOGO_PATH));
    const h = 26;
    page.drawImage(logo, { x: PAGE.w - PAGE.margin - (logo.width / logo.height) * h, y: y - h + 6, width: (logo.width / logo.height) * h, height: h });
  } catch {
    // The copy matters; the logo does not.
  }
  page.drawText('Merchant application', { x: PAGE.margin, y: y - 12, size: 18, font: bold, color: NAVY });
  y -= 32;
  const submitted = meta.submittedAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  page.drawText(clean(`${meta.label}  ·  ${meta.merchant}`), { x: PAGE.margin, y, size: 10.5, font: bold, color: INK });
  y -= 15;
  page.drawText(`Submitted online on ${submitted}. These are the merchant's answers exactly as sent.`, { x: PAGE.margin, y, size: SIZE, font: regular, color: MUTED });
  y -= 26;

  for (const section of copySections(answers, meta.ssnOnFile)) {
    if (!section.rows.length) continue;
    room(48);
    page.drawText(clean(section.title), { x: PAGE.margin, y, size: 11.5, font: bold, color: NAVY });
    y -= 8;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.w - PAGE.margin, y }, thickness: 1, color: NAVY });
    y -= 15;
    for (const row of section.rows) {
      const left = wrap(row.label, regular, LABEL_W, clean);
      const right = wrap(row.value, regular, VALUE_W, clean);
      const height = Math.max(left.length, right.length) * LINE;
      room(height + 6);
      left.forEach((l, i) => page.drawText(l, { x: PAGE.margin, y: y - i * LINE, size: SIZE, font: regular, color: MUTED }));
      right.forEach((l, i) => page.drawText(l, { x: VALUE_X, y: y - i * LINE, size: SIZE, font: regular, color: INK }));
      y -= height - LINE + 6;
      page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.w - PAGE.margin, y }, thickness: 0.5, color: RULE });
      y -= 13;
    }
    y -= 12;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const foot = clean(`${TENOR.legalName}  ·  ${meta.label}  ·  Page ${i + 1} of ${pages.length}`);
    p.drawText(foot, { x: PAGE.margin, y: 30, size: 8, font: regular, color: MUTED });
  });
  return doc.save();
}
