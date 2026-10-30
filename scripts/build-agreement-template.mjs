/**
 * Builds the field map for a merchant agreement template, from the PDF as
 * Maverick supplies it. Run whenever the agreement PDF changes:
 *
 *   node scripts/build-agreement-template.mjs <kind> <decrypted.pdf>
 *
 * Maverick's PDFs are AES-256 encrypted (empty user password, owner
 * restrictions only). pdf-lib cannot open those, so decrypt a copy first —
 * once, offline — with pikepdf or qpdf, and pass the decrypted file:
 *
 *   python -c "import pikepdf; pikepdf.open('TapDash CC Agreement.pdf').save('cc.pdf', encryption=False)"
 *   qpdf --decrypt "TapDash CC Agreement.pdf" cc.pdf
 *
 * The template is copied to src/lib/agreements/template/<file> and every form
 * field is written to <kind>.fields.json: name, type, page (1-based), rect in
 * PDF points (origin bottom-left), the page size, and for checkboxes and
 * radios their "on" value. The agreement mapping (kinds/<kind>.ts) and its
 * tests are checked against this file, so a field renamed in a new PDF
 * version fails a test instead of printing nothing.
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFTextField } from 'pdf-lib';

const FILES = {
  maverick_merchant: 'Maverick_Merchant_Agreement_v1.8.pdf',
  maverick_ach: 'Maverick_ACH_Agreement_v1.7.pdf',
};

const [, , kind, src] = process.argv;
if (!kind || !src || !FILES[kind]) {
  console.error(`usage: node scripts/build-agreement-template.mjs <${Object.keys(FILES).join('|')}> <decrypted.pdf>`);
  process.exit(1);
}
const dir = path.resolve('src/lib/agreements/template');
await mkdir(dir, { recursive: true });
const out = path.join(dir, FILES[kind]);
if (path.resolve(src) !== out) await copyFile(src, out);

const doc = await PDFDocument.load(await readFile(out));
if (doc.isEncrypted) throw new Error('still encrypted — decrypt the copy first (see the header)');
const pages = doc.getPages();
const pageIndex = new Map(pages.map((p, i) => [p.ref.toString(), i]));
const typeOf = (f) =>
  f instanceof PDFTextField ? 'text' : f instanceof PDFCheckBox ? 'checkbox' : f instanceof PDFRadioGroup ? 'radio' : f instanceof PDFDropdown ? 'dropdown' : f instanceof PDFOptionList ? 'list' : 'other';

const fields = [];
for (const f of doc.getForm().getFields()) {
  const type = typeOf(f);
  const widgets = f.acroField.getWidgets().map((w) => {
    const r = w.getRectangle();
    const pRef = w.P();
    const page = pRef ? pageIndex.get(pRef.toString()) : undefined;
    // A checkbox's "on" state is the one appearance key that is not /Off.
    const ap = w.dict.lookup(PDFName.of('AP'));
    const n = ap?.lookup?.(PDFName.of('N'));
    const on = n && typeof n.keys === 'function' ? n.keys().map((k) => k.asString().slice(1)).find((k) => k !== 'Off') ?? null : null;
    return { page: page === undefined ? null : page + 1, x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), on };
  });
  const entry = { name: f.getName(), type, widgets };
  if (type === 'radio') entry.options = f.getOptions();
  if (type === 'dropdown' || type === 'list') entry.options = f.getOptions();
  if (type === 'text') { const m = f.getMaxLength(); if (m) entry.maxLength = m; }
  fields.push(entry);
}
const meta = {
  kind,
  file: FILES[kind],
  pages: pages.map((p, i) => ({ page: i + 1, width: +p.getWidth().toFixed(2), height: +p.getHeight().toFixed(2), rotation: p.getRotation().angle })),
  fields,
};
await writeFile(path.join(dir, `${kind}.fields.json`), JSON.stringify(meta, null, 2) + '\n');
console.log(`${kind}: ${pages.length} pages, ${fields.length} fields → ${path.relative(process.cwd(), out)} + ${kind}.fields.json`);
