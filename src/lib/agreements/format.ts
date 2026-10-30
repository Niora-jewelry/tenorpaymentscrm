/**
 * How a CRM value is printed on an agreement (spec §6, "Formatting"):
 * dates MM/DD/YYYY · dollar amounts with 2 decimals · percentages as the
 * number only (the form prints the % sign) · SSN ###-##-#### · EIN
 * ##-####### · checkboxes checked or not. Pure functions, no CRM knowledge.
 */

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** "1,234.5" / "$1,234.50" / 1234.5 → 1234.5; anything else → null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/[$,%\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 0.75 · 7.50 · 1234.00 — two decimals, no symbol (the form prints "$"). */
export const money = (v: unknown): string => {
  const n = num(v);
  return n === null ? '' : n.toFixed(2);
};
/** 2.95 · 0.10 — the number only; the form prints "%". Trailing zeros kept to two places. */
export const percent = (v: unknown): string => {
  const n = num(v);
  return n === null ? '' : (Math.round(n * 100) / 100).toString();
};
/** A plain count ("12"). */
export const count = (v: unknown): string => {
  const n = num(v);
  return n === null ? '' : String(Math.round(n));
};

/** YYYY-MM-DD (the CRM's date) or anything Date can read → MM/DD/YYYY. */
export function usDate(v: unknown): string {
  const s = str(v);
  if (!s) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

/** Full years from the founded date to the send date, rounded down; under a
 *  year is 0 (spec: founded 11/15/2019, sent 10/27/2026 → 6). */
export function yearsSince(founded: unknown, at: Date): string {
  const s = str(founded);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const d = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  let years = at.getUTCFullYear() - d.getUTCFullYear();
  const beforeAnniversary = at.getUTCMonth() < d.getUTCMonth() || (at.getUTCMonth() === d.getUTCMonth() && at.getUTCDate() < d.getUTCDate());
  if (beforeAnniversary) years -= 1;
  return String(Math.max(0, years));
}

export const digits = (v: unknown): string => str(v).replace(/\D/g, '');
/** 123456789 → 123-45-6789; anything else prints as typed. */
export const ssn = (v: unknown): string => {
  const d = digits(v);
  return d.length === 9 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : str(v);
};
/** 123456789 → 12-3456789. */
export const ein = (v: unknown): string => {
  const d = digits(v);
  return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : str(v);
};
/** 5125550100 / +15125550100 → (512) 555-0100; anything else as typed. */
export const phone = (v: unknown): string => {
  const d = digits(v);
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : str(v);
};

export type AddressParts = { street: string; street2: string; city: string; state: string; zip: string };
export function addressParts(v: unknown): AddressParts {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { street: str(o.street), street2: str(o.street2), city: str(o.city), state: str(o.state), zip: str(o.zip) };
}
/** "12 Main St, Suite 4" — street and unit only; city, state and zip have their own boxes. */
export const streetLine = (v: unknown): string => {
  const a = addressParts(v);
  return [a.street, a.street2].filter(Boolean).join(', ');
};
/** The whole address on one line, for a box that has no city/state/zip of its own. */
export const addressLine = (v: unknown): string => {
  const a = addressParts(v);
  const cityState = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.street, a.street2, cityState].filter(Boolean).join(', ');
};

export const yesNo = (v: unknown): 'Yes' | 'No' | '' => {
  const s = str(v).toLowerCase();
  return s === 'yes' ? 'Yes' : s === 'no' ? 'No' : '';
};

/** Values the form's Helvetica cannot draw (curly quotes, dashes, non-Latin)
 *  are replaced with their plain equivalents or dropped, so a fill never
 *  throws on one character. */
export function winAnsi(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

/** The seven equipment/software providers, joined once each, "NA" when none (spec §6). */
export function equipmentList(values: unknown[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = str(v);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.length ? out.join(', ') : 'NA';
}
