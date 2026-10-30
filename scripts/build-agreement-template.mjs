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
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { PDFArray, PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFRawStream, PDFString, PDFTextField, decodePDFRawStream } from 'pdf-lib';

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

// Some of Maverick's forms reuse a field name (the ACH agreement has three
// "Routing Number" boxes, one per bank account). They arrive as ONE field
// with several widgets, so filling it would print the same number in every
// account. Each extra widget becomes a field of its own — the widget dict
// gets the field keys (FT, DA, Ff) and its own name, _2, _3 … in reading
// order — and the first keeps the original name.
{
  let split = 0;
  const fieldsArray = doc.getForm().acroForm.dict.lookup(PDFName.of('Fields'), PDFArray);
  for (const f of doc.getForm().getFields()) {
    if (!(f instanceof PDFTextField)) continue;
    const widgets = f.acroField.getWidgets();
    if (widgets.length < 2) continue;
    const parent = f.acroField.dict;
    const ordered = widgets
      .map((w) => ({ w, page: pageIndex.get(w.P()?.toString() ?? '') ?? 0, y: w.getRectangle().y }))
      .sort((a, b) => a.page - b.page || b.y - a.y);
    const kids = parent.lookup(PDFName.of('Kids'), PDFArray);
    ordered.slice(1).forEach(({ w }, i) => {
      const ref = doc.context.getObjectRef(w.dict);
      for (const k of ['FT', 'DA', 'Ff', 'Q', 'MaxLen']) {
        const v = parent.get(PDFName.of(k));
        if (v !== undefined) w.dict.set(PDFName.of(k), v);
      }
      w.dict.set(PDFName.of('T'), PDFString.of(`${f.getName()}_${i + 2}`));
      w.dict.delete(PDFName.of('Parent'));
      if (kids) for (let j = kids.size() - 1; j >= 0; j--) if (kids.get(j) === ref) kids.remove(j);
      if (ref) fieldsArray.push(ref);
      split++;
    });
  }
  if (split) {
    await writeFile(out, await doc.save({ updateFieldAppearances: false }));
    console.log('widgets split into fields of their own:', split);
  }
}
// Some pages (the ACH agreement's legal terms) are text drawn as outlines,
// tens of thousands of curve operators with six-decimal coordinates — 18 MB
// for eight pages. Coordinates are rounded to 0.1 pt (0.035 mm, below what a
// 600 dpi printer resolves) and the streams recompressed at maximum.
{
  const before = (await readFile(out)).byteLength;
  const d = await PDFDocument.load(await readFile(out));
  let touched = 0;
  for (const page of d.getPages()) {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [page.node.get(PDFName.of('Contents'))] : [];
    for (const ref of refs) {
      const stream = d.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;
      const decoded = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      if (decoded.length < 200_000) continue;
      const rounded = decoded.replace(/-?\d+\.\d{2,}/g, (n) => String(Math.round(Number(n) * 10) / 10));
      d.context.assign(ref, d.context.stream(deflateSync(Buffer.from(rounded, 'latin1'), { level: 9 }), { Filter: 'FlateDecode' }));
      touched++;
    }
  }
  if (touched) {
    await writeFile(out, await d.save({ updateFieldAppearances: false, useObjectStreams: true }));
    console.log(`outline-heavy streams rounded: ${touched} (${(before / 1e6).toFixed(1)} MB → ${((await readFile(out)).byteLength / 1e6).toFixed(1)} MB)`);
  }
}

// Re-read what was saved, so the field map reflects the template as shipped.
const doc2 = split2(await readFile(out));
async function split2(bytes) { return PDFDocument.load(bytes); }
const typeOf = (f) =>
  f instanceof PDFTextField ? 'text' : f instanceof PDFCheckBox ? 'checkbox' : f instanceof PDFRadioGroup ? 'radio' : f instanceof PDFDropdown ? 'dropdown' : f instanceof PDFOptionList ? 'list' : 'other';

const fields = [];
const shipped = await doc2;
const pages2 = shipped.getPages();
const pageIndex2 = new Map(pages2.map((p, i) => [p.ref.toString(), i]));
for (const f of shipped.getForm().getFields()) {
  const type = typeOf(f);
  const widgets = f.acroField.getWidgets().map((w) => {
    const r = w.getRectangle();
    const pRef = w.P();
    const page = pRef ? pageIndex2.get(pRef.toString()) : undefined;
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
  pages: pages2.map((p, i) => ({ page: i + 1, width: +p.getWidth().toFixed(2), height: +p.getHeight().toFixed(2), rotation: p.getRotation().angle })),
  fields,
};
await writeFile(path.join(dir, `${kind}.fields.json`), JSON.stringify(meta, null, 2) + '\n');
console.log(`${kind}: ${pages2.length} pages, ${fields.length} fields → ${path.relative(process.cwd(), out)} + ${kind}.fields.json`);
