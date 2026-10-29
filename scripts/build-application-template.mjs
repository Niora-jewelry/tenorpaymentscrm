/**
 * Builds the merchant application template the CRM sends, from the client's
 * revised PDF (TapDash_Application_v2.pdf). Re-run whenever that PDF changes:
 *
 *   node scripts/build-application-template.mjs <TapDash_Application_v2.pdf>
 *
 * Writes src/lib/applications/template/TapDash_Application_v2.pdf. The design
 * is untouched; only form fields change, per the client's decisions
 * (28 Oct 2026):
 *
 *   · Area zoned — "Only one tick allowed". Its three checkboxes become ONE
 *     choice: a radio field whose buttons keep the original checkbox
 *     drawings, so the page looks the same and a viewer allows one tick.
 *     Entity type ("select one" on the form itself) and Estimated square
 *     footage (ranges that cannot both be true) get the same treatment.
 *     Field names stay the group name (area_zoned, entity_type,
 *     square_footage); each button's value is the option (commercial, …).
 *   · "How long does it take for the customer to receive the product or
 *     service?" — "Set choices on pdf also/online app". The text box becomes a
 *     dropdown in the same place with the CRM's choices.
 *
 * Every other field — names, positions, the hidden tapdash_app_id — is
 * exactly as the client made it.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, PDFString, StandardFonts, rgb } from 'pdf-lib';

const SINGLE_CHOICE_GROUPS = ['area_zoned', 'entity_type', 'square_footage'];
export const RECEIVED_OPTIONS = ['24 hours', '2-5 days', '6-10 days', '11+ days'];

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/build-application-template.mjs <TapDash_Application_v2.pdf>');
  process.exit(1);
}
const out = path.resolve('src/lib/applications/template/TapDash_Application_v2.pdf');

const doc = await PDFDocument.load(await readFile(src));
const form = doc.getForm();
const ctx = doc.context;
const fieldsArray = form.acroForm.dict.lookup(PDFName.of('Fields'), PDFArray);

/** Field refs in the AcroForm /Fields array whose name starts `<group>__`. */
function groupRefs(group) {
  const refs = [];
  for (let i = 0; i < fieldsArray.size(); i++) {
    const ref = fieldsArray.get(i);
    const dict = ctx.lookup(ref, PDFDict);
    const t = dict.lookup(PDFName.of('T'));
    const name = t ? t.decodeText() : '';
    if (name.startsWith(`${group}__`)) refs.push({ index: i, ref, dict, option: name.slice(group.length + 2) });
  }
  return refs;
}

for (const group of SINGLE_CHOICE_GROUPS) {
  const members = groupRefs(group);
  if (members.length < 2) throw new Error(`${group}: expected a checkbox group, found ${members.length}`);
  const da = members[0].dict.lookup(PDFName.of('DA'));
  // Radio (bit 16) + NoToggleToOff (bit 15): one choice, and clicking the
  // chosen one again does not clear it.
  const parent = ctx.obj({
    FT: PDFName.of('Btn'),
    T: PDFString.of(group),
    Ff: (1 << 15) | (1 << 14),
    V: PDFName.of('Off'),
    Kids: members.map((m) => m.ref),
  });
  if (da) parent.set(PDFName.of('DA'), da);
  const parentRef = ctx.register(parent);
  for (const m of members) {
    // The checkbox was a merged field+widget; it becomes a widget of the group.
    for (const k of ['T', 'FT', 'Ff', 'V', 'DV']) m.dict.delete(PDFName.of(k));
    m.dict.set(PDFName.of('Parent'), parentRef);
    m.dict.set(PDFName.of('AS'), PDFName.of('Off'));
    // Its "on" drawing (the tick) is renamed from /Yes to the option's value.
    const ap = m.dict.lookup(PDFName.of('AP'), PDFDict);
    for (const kind of ['N', 'D']) {
      const states = ap.lookup(PDFName.of(kind));
      if (!(states instanceof PDFDict)) continue;
      const onKey = states.keys().find((k) => k.asString() !== '/Off');
      if (!onKey) continue;
      const stream = states.get(onKey);
      states.delete(onKey);
      states.set(PDFName.of(m.option), stream);
    }
  }
  // Replace the members in /Fields with the one group field.
  const indices = members.map((m) => m.index).sort((a, b) => b - a);
  for (const i of indices) fieldsArray.remove(i);
  fieldsArray.push(parentRef);
}

// The delivery-time question: a dropdown where the text box was.
const old = form.getTextField('product_received_time');
const widget = old.acroField.getWidgets()[0];
const rect = widget.getRectangle();
const pageRef = widget.P();
const page = doc.getPages().find((p) => p.ref === pageRef);
// Removed by hand: pdf-lib's removeField needs a stored appearance, and the
// client's empty text boxes have none. The field is its own widget, so its
// one ref goes from /Fields and from the page's /Annots.
{
  const ref = old.ref;
  for (let i = fieldsArray.size() - 1; i >= 0; i--) if (fieldsArray.get(i) === ref) fieldsArray.remove(i);
  const annots = page.node.lookup(PDFName.of('Annots'), PDFArray);
  for (let i = annots.size() - 1; i >= 0; i--) if (annots.get(i) === ref) annots.remove(i);
}
const helv = await doc.embedFont(StandardFonts.Helvetica);
const dropdown = form.createDropdown('product_received_time');
dropdown.setOptions(RECEIVED_OPTIONS);
dropdown.addToPage(page, {
  ...rect,
  font: helv,
  textColor: rgb(0.1, 0.12, 0.15),
  // The form's own field fill, so the box looks like every other on the page.
  backgroundColor: rgb(0.941, 0.945, 0.953),
  borderWidth: 0,
});
dropdown.updateAppearances(helv);

// Every choice starts unselected. The client's PDF ships with "Rent" already
// chosen for "Do you own, lease or rent the property?" (V and AS set), so a
// merchant who never touched it would have returned "Rent". A sent PDF must
// show only what the CRM knows; prefill selects the rest.
for (const field of doc.getForm().getFields()) {
  const dict = field.acroField.dict;
  if (dict.lookup(PDFName.of('FT')) !== PDFName.of('Btn')) continue;
  dict.set(PDFName.of('V'), PDFName.of('Off'));
  dict.delete(PDFName.of('DV'));
  for (const w of field.acroField.getWidgets()) w.dict.set(PDFName.of('AS'), PDFName.of('Off'));
}

// The client's tick boxes have a drawing for "ticked" only. With nothing to
// draw for "not ticked", Chrome and Edge invent a bordered square of their own
// over the printed box, off-centre and across the label. An empty "not ticked"
// drawing lets the printed box show, as it does in Acrobat and Preview.
let blanks = 0;
for (const field of doc.getForm().getFields()) {
  if (field.acroField.dict.lookup(PDFName.of('FT')) !== PDFName.of('Btn')) continue;
  for (const w of field.acroField.getWidgets()) {
    const n = w.dict.lookup(PDFName.of('AP'), PDFDict)?.lookup(PDFName.of('N'));
    if (!(n instanceof PDFDict) || n.has(PDFName.of('Off'))) continue;
    const { width, height } = w.getRectangle();
    n.set(PDFName.of('Off'), ctx.register(ctx.formXObject([], { BBox: [0, 0, width, height] })));
    blanks++;
  }
}
console.log('empty "not ticked" drawings added:', blanks);

// The client's Yes/No radios carry some appearance drawings as streams written
// straight inside their /AP dictionaries. A stream must be an object of its
// own; pdf.js and pdf-lib let it pass, Chrome and Edge (PDFium) do not — they
// then drew no radio at all, and drew page 2's first answers again on page 1
// under the legal name. Each such stream is moved into an object of its own;
// the drawing itself is unchanged.
let lifted = 0;
for (const pg of doc.getPages()) {
  const annots = pg.node.lookup(PDFName.of('Annots'), PDFArray);
  if (!annots) continue;
  for (let i = 0; i < annots.size(); i++) {
    const ap = ctx.lookup(annots.get(i), PDFDict).lookup(PDFName.of('AP'));
    if (!(ap instanceof PDFDict)) continue;
    for (const kind of ['N', 'D', 'R']) {
      const raw = ap.get(PDFName.of(kind));
      if (raw instanceof PDFStream) {
        ap.set(PDFName.of(kind), ctx.register(raw));
        lifted++;
      } else if (raw instanceof PDFDict) {
        for (const [state, v] of raw.entries()) {
          if (v instanceof PDFStream) {
            raw.set(state, ctx.register(v));
            lifted++;
          }
        }
      }
    }
  }
}
console.log('appearance streams moved into objects of their own:', lifted);

// Appearances are generated; NeedAppearances stays off (the client found some
// viewers draw radios wrongly with it on).
form.acroForm.dict.delete(PDFName.of('NeedAppearances'));

await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, await doc.save({ updateFieldAppearances: false }));
console.log('wrote', path.relative(process.cwd(), out));
