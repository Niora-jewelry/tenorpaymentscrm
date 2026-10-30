/**
 * The agreement PDF: the kind's template filled from `renderAgreement`,
 * then FLATTENED — the signers receive a document they cannot edit (spec
 * §2, "Every pre-filled field is locked. Signers only sign and date"). The
 * only live spots are the signature and date boxes the e-sign service
 * draws, at the rectangles the form's own signature fields mark
 * (`signatureSpots`).
 *
 * Checkbox and radio drawings stay the client's own: text appearances are
 * generated, then the form is flattened without regenerating the rest —
 * the same lesson the application template taught about pdf-lib redrawing
 * boxes in its own style.
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFRadioGroup, PDFTextField, StandardFonts, type PDFField } from 'pdf-lib';
import type { AgreementKindDef } from './kinds/types';
import type { Signer } from './signers';

const TEMPLATE_DIR = path.join(process.cwd(), 'src', 'lib', 'agreements', 'template');

export class TemplateMissingError extends Error {
  constructor(kind: string) {
    super(`The ${kind} agreement template is not installed.`);
    this.name = 'TemplateMissingError';
  }
}

export type TemplateFields = {
  pages: { page: number; width: number; height: number; rotation: number }[];
  fields: { name: string; type: string; widgets: { page: number | null; x: number; y: number; w: number; h: number }[] }[];
};

const cache = new Map<string, { pdf: Uint8Array; fields: TemplateFields }>();
export async function loadTemplate(kind: AgreementKindDef): Promise<{ pdf: Uint8Array; fields: TemplateFields }> {
  const hit = cache.get(kind.key);
  if (hit) return hit;
  try {
    const [pdf, json] = await Promise.all([readFile(path.join(TEMPLATE_DIR, kind.templateFile)), readFile(path.join(TEMPLATE_DIR, kind.fieldsFile), 'utf8')]);
    const loaded = { pdf: new Uint8Array(pdf), fields: JSON.parse(json) as TemplateFields };
    cache.set(kind.key, loaded);
    return loaded;
  } catch {
    throw new TemplateMissingError(kind.label);
  }
}
export async function templateInstalled(kind: AgreementKindDef): Promise<boolean> {
  try {
    await loadTemplate(kind);
    return true;
  } catch {
    return false;
  }
}

/** "[Legal business name] - Merchant Agreement - Signed [MM-DD-YYYY].pdf" (spec §8), or the unsigned name before that. */
export function agreementFileName(legalName: string, kindLabel: string, signedOn?: Date): string {
  const clean = legalName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Merchant';
  if (!signedOn) return `${clean} - ${kindLabel}.pdf`;
  const d = `${String(signedOn.getMonth() + 1).padStart(2, '0')}-${String(signedOn.getDate()).padStart(2, '0')}-${signedOn.getFullYear()}`;
  return `${clean} - ${kindLabel} - Signed ${d}.pdf`;
}

/**
 * Fills and flattens. `byPdfField`: text for text fields, the option for a
 * radio group, a boolean for a checkbox. Every signature and date field is
 * removed first — the e-sign service draws those — and unknown names are
 * ignored, so an older template never throws on a newer mapping.
 */
export async function fillAndFlatten(kind: AgreementKindDef, template: Uint8Array, byPdfField: Record<string, string | boolean>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(template);
  const form = doc.getForm();
  const signatureFields = new Set(kind.principals.flatMap((p) => p.signatures.flatMap((s) => [s.signature, s.date])));
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  ensureOffAppearances(doc);

  for (const field of form.getFields()) {
    const name = field.getName();
    if (signatureFields.has(name)) continue;
    const value = byPdfField[name];
    if (field instanceof PDFTextField) {
      if (typeof value === 'string' && value) {
        const max = field.getMaxLength();
        field.setText(max ? value.slice(0, max) : value);
      }
      field.updateAppearances(helv);
    } else if (field instanceof PDFCheckBox) {
      if (value === true) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup) {
      if (typeof value === 'string' && value && field.getOptions().includes(value)) field.select(value);
    }
  }

  // The signature spots go: the e-sign service places its own there. Removed
  // by hand — pdf-lib's removeField wants a stored appearance, and the form's
  // empty text boxes have none (the application template hit the same thing).
  for (const field of form.getFields()) {
    if (signatureFields.has(field.getName())) dropField(doc, field);
  }
  form.acroForm.dict.delete(PDFName.of('NeedAppearances'));
  // Flatten with the appearances exactly as they are now: the text ones we
  // just drew, the client's own box and radio drawings untouched.
  form.flatten({ updateFieldAppearances: false });
  return doc.save({ updateFieldAppearances: false });
}

/** The client's tick boxes and radios have a drawing for "on" only. Flatten
 *  needs one for every state it bakes in, so an unticked box gets an empty
 *  "Off" drawing — the printed square underneath stays as it is. */
function ensureOffAppearances(doc: PDFDocument): void {
  const ctx = doc.context;
  for (const field of doc.getForm().getFields()) {
    if (!(field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) continue;
    for (const w of field.acroField.getWidgets()) {
      const ap = w.dict.lookup(PDFName.of('AP'), PDFDict);
      const n = ap?.lookup(PDFName.of('N'));
      if (!(n instanceof PDFDict) || n.has(PDFName.of('Off'))) continue;
      const { width, height } = w.getRectangle();
      n.set(PDFName.of('Off'), ctx.register(ctx.formXObject([], { BBox: [0, 0, width, height] })));
    }
  }
}

/** Removes a field and its widgets from the document: each widget from its
 *  page's /Annots, the field from the AcroForm /Fields. */
function dropField(doc: PDFDocument, field: PDFField): void {
  const ctx = doc.context;
  const widgetRefs = new Set<string>();
  for (const w of field.acroField.getWidgets()) {
    const pRef = w.P();
    const page = pRef ? doc.getPages().find((p) => p.ref === pRef) : undefined;
    const ref = ctx.getObjectRef(w.dict);
    if (ref) widgetRefs.add(ref.toString());
    if (!page) continue;
    const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.get(i);
      if (a === ref || ctx.lookup(a, PDFDict) === w.dict) annots.remove(i);
    }
  }
  const fields = doc.getForm().acroForm.dict.lookup(PDFName.of('Fields'), PDFArray);
  if (!fields) return;
  for (let i = fields.size() - 1; i >= 0; i--) {
    const f = fields.get(i);
    if (f === field.ref || widgetRefs.has(f.toString())) fields.remove(i);
  }
}

/** Where the e-sign service draws each selected principal's signature and
 *  date boxes: the template's own field rectangles, in PDF points with the
 *  origin bottom-left, plus the page size so a vendor client can convert. */
export type SignatureSpot = { slot: Signer['slot']; kind: 'signature' | 'date'; page: number; x: number; y: number; w: number; h: number; pageWidth: number; pageHeight: number };

export function signatureSpots(kind: AgreementKindDef, fields: TemplateFields, signers: Signer[]): SignatureSpot[] {
  const byName = new Map(fields.fields.map((f) => [f.name, f]));
  const pageOf = (n: number) => fields.pages.find((p) => p.page === n);
  const out: SignatureSpot[] = [];
  for (const signer of signers) {
    const slot = kind.principals.find((p) => p.slot === signer.slot);
    if (!slot) throw new Error(`no principal slot ${signer.slot} on ${kind.key}`);
    for (const s of slot.signatures) {
      for (const [k, name] of [['signature', s.signature], ['date', s.date]] as const) {
        const f = byName.get(name);
        const w = f?.widgets[0];
        if (!f || !w || w.page === null) throw new Error(`${kind.key}: signature field "${name}" is missing from the template`);
        const page = pageOf(w.page);
        if (!page) throw new Error(`${kind.key}: page ${w.page} is missing from the template`);
        out.push({ slot: signer.slot, kind: k, page: w.page, x: w.x, y: w.y, w: w.w, h: w.h, pageWidth: page.width, pageHeight: page.height });
      }
    }
  }
  return out;
}
