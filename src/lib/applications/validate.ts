/**
 * The online form's checks before submit (spec, Online path), shared by the
 * browser (to say what is wrong next to the field) and the server (which is
 * the one that decides).
 *
 *  · each "must equal 100%" group adds up to 100;
 *  · ownership adds up to at least 51%;
 *  · emails and phone numbers are valid;
 *  · an "If yes, provide details" box is required when Yes is picked.
 *
 * Plus input hygiene: only the application's own keys, bounded lengths.
 */
import { MAX_OWNERS, QUESTIONS, answerKeys, ownerField, type AddressAnswer, type Answers, type AnswerValue, type SectionId } from './catalog';

export type Problems = Record<string, string>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_TEXT = 2000;
const KEYS = answerKeys();
const CHOICE_IDS = new Map(QUESTIONS.filter((q) => q.options).map((q) => [q.id, new Set(q.options!.map((o) => o.value))]));

export const isEmail = (s: string) => EMAIL.test(s.trim());
export const phoneDigits = (s: string) => s.replace(/\D/g, '');
/** US numbers, with or without +1, or an international number of 8–15 digits. */
export const isPhone = (s: string) => {
  const d = phoneDigits(s);
  return /^[\d\s()+.\-x]+$/i.test(s.trim()) && d.length >= 10 && d.length <= 15;
};
const num = (s: unknown) => {
  const n = Number(String(s ?? '').replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const filled = (v: AnswerValue | undefined) =>
  typeof v === 'string' ? v.trim() !== '' : Array.isArray(v) ? v.length > 0 : !!v && Object.values(v).some((x) => x.trim() !== '');

/**
 * Keeps only what the application asks, in the shapes it asks for. Anything
 * else in a submitted payload is dropped, never stored.
 */
export function sanitizeAnswers(raw: unknown): Answers {
  const out: Answers = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEYS.has(k)) continue;
    const choices = CHOICE_IDS.get(k);
    if (typeof v === 'string') {
      const s = v.slice(0, MAX_TEXT);
      if (choices && s && !choices.has(s)) continue;
      out[k] = s;
    } else if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === 'string' && (!choices || choices.has(x)));
      out[k] = [...new Set(list)];
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const part = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : '');
      const a: AddressAnswer = { street: part(o.street, 200), street2: part(o.street2, 200), city: part(o.city, 100), state: part(o.state, 40), zip: part(o.zip, 20) };
      out[k] = a;
    }
  }
  return out;
}

/** The section an answer key is asked in — owners and the 51% total are the
 *  Ownership page; a details or comments box is its question's page. */
export function sectionOfKey(key: string): SectionId {
  if (key === 'owners' || /^owner\d+_/.test(key)) return 'ownership';
  const q = QUESTIONS.find(
    (x) => x.id === key || x.details?.id === key || x.comments?.id === key || (x.kind === 'percent_group' && key.startsWith(`${x.id}_`)),
  );
  return q?.section ?? 'business';
}

/** The problems on one page of the form. */
export function problemsInSection(p: Problems, section: SectionId): Problems {
  return Object.fromEntries(Object.entries(p).filter(([k]) => sectionOfKey(k) === section));
}

/** Every problem, keyed by the answer key it belongs to. Empty means submit. */
export function problemsWith(a: Answers, ssnOnFile: Record<number, string> = {}): Problems {
  const p: Problems = {};

  for (const q of QUESTIONS) {
    const v = a[q.id];
    if (q.kind === 'email' && typeof v === 'string' && v.trim() && !isEmail(v)) p[q.id] = 'Enter a valid email address.';
    if (q.kind === 'phone' && typeof v === 'string' && v.trim() && !isPhone(v)) p[q.id] = 'Enter a valid phone number, with area code.';
    if (q.kind === 'percent_group') {
      const parts = (q.options ?? []).map((o) => a[`${q.id}_${o.value}`]);
      if (parts.some((x) => filled(x))) {
        const bad = parts.find((x) => filled(x) && (Number.isNaN(num(x)) || num(x) < 0 || num(x) > 100));
        const total = parts.reduce<number>((s, x) => s + (filled(x) ? num(x) || 0 : 0), 0);
        if (bad !== undefined) p[q.id] = 'Each part must be a number from 0 to 100.';
        else if (Math.abs(total - 100) > 0.01) p[q.id] = `These must add up to 100% (now ${Math.round(total * 100) / 100}%).`;
      }
    }
    if (q.details?.requiredWhen && v === q.details.requiredWhen && !filled(a[q.details.id])) {
      p[q.details.id] = 'Please provide details.';
    }
  }

  // Owners: any owner with something filled needs a name; the listed
  // ownership must add up to at least 51%.
  let ownership = 0;
  let anyOwner = false;
  for (let n = 1; n <= MAX_OWNERS; n++) {
    const parts = ['name', 'first', 'last', 'title', 'percentage', 'email', 'phone', 'ssn'] as const;
    const has = parts.some((x) => filled(a[ownerField(n, x)])) || (n === 1 && !!ssnOnFile[1]);
    if (!has) continue;
    anyOwner = true;
    const named = filled(a[ownerField(n, 'name')]) || (filled(a[ownerField(n, 'first')]) && filled(a[ownerField(n, 'last')]));
    if (!named) p[ownerField(n, 'name')] = 'Enter the owner’s first and last name.';
    const pct = a[ownerField(n, 'percentage')];
    if (filled(pct)) {
      const x = num(pct);
      if (Number.isNaN(x) || x <= 0 || x > 100) p[ownerField(n, 'percentage')] = 'Enter a percentage from 1 to 100.';
      else ownership += x;
    }
    const email = a[ownerField(n, 'email')];
    if (typeof email === 'string' && email.trim() && !isEmail(email)) p[ownerField(n, 'email')] = 'Enter a valid email address.';
    const phone = a[ownerField(n, 'phone')];
    if (typeof phone === 'string' && phone.trim() && !isPhone(phone)) p[ownerField(n, 'phone')] = 'Enter a valid phone number, with area code.';
    const ssn = a[ownerField(n, 'ssn')];
    if (typeof ssn === 'string' && ssn.trim() && phoneDigits(ssn).length !== 9) p[ownerField(n, 'ssn')] = 'A Social Security number has 9 digits.';
  }
  if (!anyOwner) p[ownerField(1, 'name')] = 'Add at least one owner.';
  else if (ownership < 51) p.owners = `Ownership listed adds up to ${Math.round(ownership * 100) / 100}% — it must be at least 51%.`;

  return p;
}
