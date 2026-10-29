/**
 * The application PDF: filling it on send, reading it back on upload.
 *
 * Spec, PDF path:
 *  · Fill by field NAME (Appendix). Text: plain text. Checkboxes: ticked.
 *    Radios: the option's own name (/Yes, /No, /Own, /Lease, /Rent).
 *  · Do not flatten — the merchant must still be able to type in it.
 *  · Generate text appearances and leave NeedAppearances OFF; otherwise some
 *    viewers draw the radios wrong (the client tested this).
 *  · tapdash_app_id carries the application ID; hidden and read-only.
 *  · Reading: blank or /Off is no answer, never "No".
 *
 * The template is built from the client's PDF by
 * scripts/build-application-template.mjs: Area zoned, Entity type and Square
 * footage are one-tick groups (radio fields drawn as the original
 * checkboxes), and the delivery-time question is a dropdown. Older returned
 * PDFs with separate `<group>__<option>` checkboxes and a free-text delivery
 * time are still read.
 *
 * The blank template ships with the server code (never served publicly):
 * src/lib/applications/template/TapDash_Application_v2.pdf.
 */
import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFRadioGroup, PDFTextField, StandardFonts } from 'pdf-lib';
import { APP_ID_FIELD, QUESTIONS, answerKeys, type Answers } from './catalog';

export const TEMPLATE_FILE = 'TapDash_Application_v2.pdf';
const TEMPLATE_PATH = path.join(process.cwd(), 'src', 'lib', 'applications', 'template', TEMPLATE_FILE);

export class TemplateMissingError extends Error {
  constructor() {
    super('The application PDF template is not installed yet, so applications cannot be sent.');
  }
}

let cached: Uint8Array | null = null;
export async function loadTemplate(): Promise<Uint8Array> {
  if (cached) return cached;
  try {
    cached = new Uint8Array(await readFile(TEMPLATE_PATH));
    return cached;
  } catch {
    throw new TemplateMissingError();
  }
}
export async function templateInstalled(): Promise<boolean> {
  try {
    await loadTemplate();
    return true;
  } catch {
    return false;
  }
}

/** Checkbox-group questions: `<id>__<option>` fields on the PDF. */
const CHECKBOX_GROUPS = new Set(QUESTIONS.filter((q) => q.kind === 'checkboxes' || q.kind === 'single_checkbox').map((q) => q.id));
/** One-tick groups: a radio field on the template, a one-item list as an answer. */
const SINGLE_CHOICE = new Set(QUESTIONS.filter((q) => q.kind === 'single_checkbox').map((q) => q.id));

/** "TapDash Application - <DBA or Legal Name>.pdf", safe for a file system and Outlook. */
export function applicationFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `TapDash Application - ${clean || 'Merchant'}.pdf`;
}

/**
 * Fills the template. `answers` are already in PDF form (`answersForPdf`):
 * strings for text and radios, option lists for checkbox groups. SSNs never
 * reach here — prefill does not produce them.
 */
export async function fillApplicationPdf(template: Uint8Array, answers: Record<string, string | string[]>, appLabel: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(template);
  const form = doc.getForm();
  for (const field of form.getFields()) {
    const name = field.getName();
    if (name === APP_ID_FIELD && field instanceof PDFTextField) {
      field.setText(appLabel);
      continue;
    }
    if (/_ssn$/.test(name)) continue;
    if (field instanceof PDFTextField) {
      const v = answers[name];
      if (typeof v === 'string' && v) {
        const max = field.getMaxLength();
        field.setText(max ? v.slice(0, max) : v);
      }
    } else if (field instanceof PDFCheckBox) {
      const sep = name.lastIndexOf('__');
      if (sep < 0) continue;
      const group = name.slice(0, sep);
      const opt = name.slice(sep + 2);
      const v = answers[group];
      if (Array.isArray(v) && v.includes(opt)) field.check();
    } else if (field instanceof PDFRadioGroup) {
      // One-tick groups arrive as a one-item list; Yes/No and Own/Lease/Rent as a string.
      const raw = answers[name];
      const v = Array.isArray(raw) ? raw[0] : raw;
      if (typeof v === 'string' && field.getOptions().includes(v)) field.select(v);
    } else if (field instanceof PDFDropdown) {
      const v = answers[name];
      if (typeof v === 'string' && field.getOptions().includes(v)) field.select(v);
    }
  }
  // Text appearances generated now — for text and dropdowns only, so the
  // client's own tick and radio drawings are kept as they are. NeedAppearances
  // stays off; nothing is flattened.
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (const field of form.getFields()) {
    if (field instanceof PDFTextField || field instanceof PDFDropdown) field.updateAppearances(helv);
  }
  form.acroForm.dict.delete(PDFName.of('NeedAppearances'));
  return doc.save({ updateFieldAppearances: false });
}

export type ReadResult = {
  /** False for a scan, a print-to-PDF or a PDF with no form at all. */
  readable: boolean;
  fieldsFound: number;
  appLabel: string | null;
  answers: Answers;
};

/** Reads every application field the PDF holds. Unknown fields are ignored. */
export async function readApplicationPdf(bytes: Uint8Array): Promise<ReadResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return { readable: false, fieldsFound: 0, appLabel: null, answers: {} };
  }
  let fields;
  try {
    fields = doc.getForm().getFields();
  } catch {
    return { readable: false, fieldsFound: 0, appLabel: null, answers: {} };
  }
  const allowed = answerKeys();
  const answers: Answers = {};
  let appLabel: string | null = null;
  let known = 0;

  for (const field of fields) {
    const name = field.getName();
    if (name === APP_ID_FIELD) {
      if (field instanceof PDFTextField) appLabel = (field.getText() ?? '').trim() || null;
      continue;
    }
    if (field instanceof PDFCheckBox) {
      const sep = name.lastIndexOf('__');
      const group = sep < 0 ? '' : name.slice(0, sep);
      if (!CHECKBOX_GROUPS.has(group)) continue;
      known++;
      if (field.isChecked()) {
        const cur = answers[group];
        answers[group] = [...(Array.isArray(cur) ? cur : []), name.slice(sep + 2)];
      }
      continue;
    }
    if (!allowed.has(name)) continue;
    known++;
    if (field instanceof PDFTextField) {
      const v = (field.getText() ?? '').trim();
      if (v) answers[name] = v;
    } else if (field instanceof PDFRadioGroup) {
      const v = field.getSelected();
      if (v && v !== 'Off') answers[name] = SINGLE_CHOICE.has(name) ? [v] : v;
    } else if (field instanceof PDFDropdown) {
      const v = field.getSelected()[0];
      if (v) answers[name] = v;
    }
  }
  return { readable: known > 0, fieldsFound: known, appLabel, answers };
}
