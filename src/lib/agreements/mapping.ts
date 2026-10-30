/**
 * Renders one agreement kind from the CRM: every PDF field's value, the
 * fixed values, the selected principals' slots, and the list of CRM fields
 * that were read (the snapshot and the "data changed after sending" banner
 * are built from that list). Pure — the PDF itself is `pdf.ts`'s job.
 */
import type { AgreementKindDef, AgreementProblem, AgreementSource, CrmValues, Used } from './kinds/types';
import type { Signer } from './signers';
import { winAnsi } from './format';

export type Rendered = {
  /** PDF field name → text (text fields, or the option of a radio group) or checked. */
  byPdfField: Record<string, string | boolean>;
  used: Used[];
  usedFieldKeys: string[];
};

const PAIRED = { owners: 'owner_ownership', privates: 'owner_private' } as const;

export function ownersOf(values: CrmValues): { owners: CrmValues[]; privates: CrmValues[] } {
  const owners = Array.isArray(values[PAIRED.owners]) ? (values[PAIRED.owners] as CrmValues[]) : [];
  const privates = Array.isArray(values[PAIRED.privates]) ? (values[PAIRED.privates] as CrmValues[]) : [];
  return { owners, privates };
}

export function renderAgreement(kind: AgreementKindDef, src: AgreementSource, signers: Signer[]): Rendered {
  const byPdfField: Record<string, string | boolean> = {};
  const used: Used[] = [];
  const seen = new Set<string>();
  const touch = (u: Used) => {
    const k = `${u.fieldKey}|${u.kind}|${u.member ?? ''}|${u.index ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    used.push(u);
  };

  for (const [pdf, value] of Object.entries(kind.fixed)) byPdfField[pdf] = typeof value === 'string' ? value : value;
  for (const m of kind.mapping) {
    const f = m.fill(src);
    if (f.check !== undefined) byPdfField[m.pdf] = f.check;
    else if (f.text !== undefined) byPdfField[m.pdf] = winAnsi(f.text);
    for (const u of f.used ?? []) touch(u);
  }

  const { owners, privates } = ownersOf(src.values);
  for (const slot of kind.principals) {
    const signer = signers.find((s) => s.slot === slot.slot);
    if (!signer) continue; // an unused slot stays blank
    const owner = owners[signer.index] ?? {};
    const priv = privates[signer.index] ?? {};
    for (const f of slot.fields) byPdfField[f.pdf] = winAnsi(f.fill(owner, priv, src));
    for (const member of Object.keys(owner)) touch({ fieldKey: PAIRED.owners, member, index: signer.index, kind: 'value' });
    for (const member of Object.keys(priv)) touch({ fieldKey: PAIRED.privates, member, index: signer.index, kind: 'value' });
  }
  // The signer set itself depends on every owner's percentage and email.
  owners.forEach((_o, i) => {
    touch({ fieldKey: PAIRED.owners, member: 'percentage', index: i, kind: 'value' });
    touch({ fieldKey: PAIRED.owners, member: 'email', index: i, kind: 'value' });
  });

  return { byPdfField, used, usedFieldKeys: [...new Set(used.map((u) => u.fieldKey))] };
}

const blank = (x: unknown): boolean =>
  x == null || x === '' || (Array.isArray(x) && x.length === 0) || (typeof x === 'object' && !Array.isArray(x) && Object.values(x as object).every(blank));

/** Spec §5: required fields, conditional rules, totals. "0 counts as filled". */
export function requiredProblems(kind: AgreementKindDef, src: AgreementSource): AgreementProblem[] {
  const out: AgreementProblem[] = [];
  for (const r of kind.required) {
    if (blank(src.values[r.fieldKey])) out.push({ fieldKey: r.fieldKey, message: `${r.label} is empty.` });
  }
  return [...out, ...kind.check(src)];
}
