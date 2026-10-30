/**
 * Application ⇄ CRM: what each answer is prefilled from, and what it writes.
 *
 * Pure functions over a record's `values`, so every ruling is unit-tested
 * without a database. The spec's eleven mapping rulings are marked R1–R11.
 *
 * ── RULES THAT HOLD FOR EVERY QUESTION ───────────────────────────────────
 *  · Never prefill an SSN or anything from the Private sub-tab (spec,
 *    Security). `prefillAnswers` cannot even see them: it reads only the
 *    keys listed here, and none of them is private.
 *  · A blank answer is no answer — never "No", never a clear (spec, PDF path).
 *  · Where an application answer cannot name ONE CRM value (the PDF's square
 *    footage ranges straddle the CRM's until it is changed to the PDF's;
 *    or Personal; several Inventory boxes ticked against a one-choice field),
 *    the proposal carries `candidates` and the reviewer picks. Nothing is
 *    guessed, and no existing CRM value is reinterpreted.
 */
import type { AddressAnswer, Answers } from './catalog';
import { MAX_OWNERS, ownerField } from './catalog';

export type CrmValues = Record<string, unknown>;

/** Where a proposal writes. */
export type Target =
  | { kind: 'field'; field: string }
  | { kind: 'member'; field: string; index: number; member: string }
  | { kind: 'note'; field: string };

export type Proposal = {
  target: Target;
  /** The CRM field whose grant governs it (a repeat member's group). */
  fieldKey: string;
  question: string;
  value: unknown;
  display: string;
  /** Set when the answer maps to more than one CRM value: the reviewer picks. */
  candidates?: { value: unknown; display: string }[];
};

export type Labels = (fieldKey: string, choiceKey: string) => string;

export const targetKey = (t: Target): string =>
  t.kind === 'field' ? `field:${t.field}` : t.kind === 'note' ? `note:${t.field}` : `member:${t.field}.${t.index}.${t.member}`;

export function parseTargetKey(s: string): Target | null {
  let m = /^field:([a-z0-9_]+)$/.exec(s);
  if (m) return { kind: 'field', field: m[1]! };
  m = /^note:([a-z0-9_]+)$/.exec(s);
  if (m) return { kind: 'note', field: m[1]! };
  m = /^member:([a-z0-9_]+)\.(\d+)\.([a-z0-9_]+)$/.exec(s);
  if (m) return { kind: 'member', field: m[1]!, index: Number(m[2]), member: m[3]! };
  return null;
}

// ── value helpers ───────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const isBlank = (v: unknown): boolean =>
  v == null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => isBlank(x)));

/** "$50,000.00" → "50000", "12.5%" → "12.5". Blank or junk → "". */
export function cleanNumber(raw: unknown): string {
  const s = str(raw).replace(/[$,%\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return '';
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : '';
}

/** Dates as the CRM stores them (YYYY-MM-DD), from what a person types into a PDF. */
export function cleanDate(raw: unknown): string {
  const s = str(raw);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! - (+m[3]! > 50 ? 100 : 0) : +m[3]!;
    return iso(y, +m[1]!, +m[2]!);
  }
  m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return iso(+m[2]!, +m[1]!, 1);
  m = /^(\d{4})$/.exec(s);
  if (m) return iso(+m[1]!, 1, 1);
  return '';
}
function iso(y: number, mo: number, d: number): string {
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const usDate = (isoDate: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : isoDate;
};

const EMPTY_ADDRESS: AddressAnswer = { street: '', street2: '', city: '', state: '', zip: '' };
function crmAddress(v: unknown): AddressAnswer | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const a = { street: str(o.street), street2: str(o.street2), city: str(o.city), state: str(o.state), zip: str(o.zip) };
  return isBlank(a) ? null : a;
}
export function addressLine(a: AddressAnswer): string {
  const csz = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.street, a.street2, csz].filter(Boolean).join(', ');
}
/**
 * One PDF line back into parts: "1 Main St, Suite 2, Austin, TX 78701".
 * The last part with "ST 12345" is state + ZIP, the one before it the city,
 * everything earlier the street. Anything else stays whole in Street, and
 * review shows it.
 */
export function parseAddress(raw: unknown): AddressAnswer {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    return { street: str(o.street), street2: str(o.street2), city: str(o.city), state: str(o.state).toUpperCase(), zip: str(o.zip) };
  }
  const s = str(raw);
  if (!s) return { ...EMPTY_ADDRESS };
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  const last = parts.length >= 3 ? /^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(parts[parts.length - 1]!) : null;
  if (!last) return { ...EMPTY_ADDRESS, street: s };
  const city = parts[parts.length - 2]!;
  const street = parts.slice(0, -2);
  return { street: street[0] ?? '', street2: street.slice(1).join(', '), city, state: last[1]!.toUpperCase(), zip: last[2]! };
}
/** An answer-shaped address as the CRM stores it (with a country). */
const toCrmAddress = (a: AddressAnswer, current: unknown) => ({
  ...a,
  country: (current && typeof current === 'object' && str((current as Record<string, unknown>).country)) || 'United States',
});

// ── translation tables (PDF option ⇄ CRM choice key) ────────────────────────

const BUILDING: Record<string, string> = { Own: 'owns', Lease: 'leases', Rent: 'rents' };
const ENTITY: Record<string, string> = {
  sole_proprietor: 'sole_prop', partnership: 'partnership', corporation: 'corp', llc: 'llc', non_profit: 'np', other: 'other',
};
/** CRM entity types the PDF has no box for read as "Other". */
const ENTITY_AS_OTHER = new Set(['gov', 'public']);
/** Inventory is "select all that apply" on both sides since 30 Oct 2026, with
 * the application's six options; only the off-site key is spelled differently. */
const INVENTORY: Record<string, string> = {
  none: 'none', on_site: 'on_site', off_site_warehouse: 'off_site',
  fulfillment_center: 'fulfillment_center', third_party_storage: 'third_party_storage', other: 'other',
};
const INVENTORY_PREFILL: Record<string, string> = Object.fromEntries(Object.entries(INVENTORY).map(([pdf, crm]) => [crm, pdf]));
/** The PDF's square-footage boxes against the CRM's ranges. The CRM keeps its
 * own ranges — the merchant agreement prints them as they are (the client,
 * 30 Oct 2026). Where a box spans two CRM ranges the reviewer picks; the one
 * CRM range that spans two boxes, 501–2,500, prefills as 1,000–5,000 (the
 * client, 29 Oct 2026). */
const SQFT_RETURN: Record<string, string[]> = {
  '1_1000': ['0_500', '501_2500'],
  '1000_5000': ['501_2500', '2501_5000'],
  '5000_10000': ['5001_10000'],
  above_10000: ['10000'],
};
const SQFT_PREFILL: Record<string, string> = { '0_500': '1_1000', '501_2500': '1000_5000', '2501_5000': '1000_5000', '5001_10000': '5000_10000', '10000': 'above_10000' };
const SALES_METHOD: Record<string, string> = { internet: 'ecommerce', in_person: 'in_person', mail_phone: 'mail_phone' };
const CUSTOMER_TYPE: Record<string, string> = { b2c: 'individual', b2b: 'business', government: 'gov' };
const CUSTOMER_PROFILE: Record<string, string> = { local: 'local', national: 'national', international: 'international' };
const PAYMENT_CODES: Record<string, string> = { ccd: 'ccd', ppd: 'ppd', tel: 'tel', web: 'web' };
const PERCENT_GROUPS: { id: string; field: string; map: Record<string, string>; question: string }[] = [
  { id: 'sales_method', field: 'sales_method', map: SALES_METHOD, question: 'How payments are taken' },
  { id: 'customer_type', field: 'customer_type', map: CUSTOMER_TYPE, question: 'Customer base' },
  { id: 'customer_profile', field: 'customer_profile', map: CUSTOMER_PROFILE, question: 'Customer geography' },
  { id: 'payment_codes', field: 'payment_codes', map: PAYMENT_CODES, question: 'ACH transaction types' },
];
const RECEIVED_BUCKETS = ['24_hours', '2_5_days', '6_10_days', '11_days'] as const;
/** The delivery-time choices as the application shows them (the PDF's
 * dropdown, the online form) ⇄ the CRM's keys. The client, 28 Oct 2026:
 * "Set choices on pdf also/online app". */
const RECEIVED_CHOICES: Record<string, (typeof RECEIVED_BUCKETS)[number]> = {
  '24 hours': '24_hours',
  '2-5 days': '2_5_days',
  '6-10 days': '6_10_days',
  '11+ days': '11_days',
};
const RECEIVED_LABEL = Object.fromEntries(Object.entries(RECEIVED_CHOICES).map(([l, k]) => [k, l])) as Record<string, string>;

/** The CRM's month values, in order (`months` fields store these). */
const MONTH_KEYS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/**
 * Months named in the Seasonal "which months?" answer: "June–August",
 * "Nov, Dec", "summer" … A range between two months covers the months in
 * between. Seasons map to their months. Nothing recognised → [].
 */
export function monthsIn(raw: unknown): string[] {
  const s = str(raw).toLowerCase();
  if (!s) return [];
  const hits: { at: number; m: number }[] = [];
  const re = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g;
  const original = str(raw);
  for (let m = re.exec(s); m; m = re.exec(s)) {
    // "may" is also an ordinary word ("hours may vary"): only "May" is the month.
    if (m[1] === 'may' && original[m.index] !== 'M') continue;
    hits.push({ at: m.index, m: MONTH_KEYS.findIndex((k) => m![1]!.startsWith(k.toLowerCase())) });
  }
  const out = new Set<number>();
  for (let i = 0; i < hits.length; i++) {
    out.add(hits[i]!.m);
    const next = hits[i + 1];
    // "June - August", "June to August", "June through August"
    if (next && /^\s*(?:-|–|—|to|through|thru|until)\s*$/.test(s.slice(hits[i]!.at, next.at).replace(/^[a-z]+/, ''))) {
      for (let k = hits[i]!.m; k !== next.m; k = (k + 1) % 12) out.add(k);
    }
  }
  const SEASONS: Record<string, number[]> = { winter: [11, 0, 1], spring: [2, 3, 4], summer: [5, 6, 7], fall: [8, 9, 10], autumn: [8, 9, 10] };
  for (const [name, ms] of Object.entries(SEASONS)) if (new RegExp(`\\b${name}\\b`).test(s)) ms.forEach((m) => out.add(m));
  if (/\bholiday(s)?\b|\bchristmas\b/.test(s)) [10, 11].forEach((m) => out.add(m));
  return [...out].sort((a, b) => a - b).map((m) => MONTH_KEYS[m]!);
}

/** "same day", "48 hours", "3-5 days", "2 weeks" → whole days, or null. */
export function receivedDays(raw: unknown): number | null {
  const s = str(raw).toLowerCase();
  if (!s) return null;
  if (/same\s*day|immediate|instant|right away|today/.test(s)) return 0;
  const m = /(\d+(?:\.\d+)?)(?:\s*(?:-|to|–)\s*(\d+(?:\.\d+)?))?\s*(hour|hr|day|business day|week|wk|month|mo)?/.exec(s);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  const unit = m[3] ?? 'day';
  const days = unit.startsWith('h') ? n / 24 : unit.startsWith('w') ? n * 7 : unit.startsWith('mo') ? n * 30 : n;
  return Number.isFinite(days) ? days : null;
}
function receivedBucket(days: number): (typeof RECEIVED_BUCKETS)[number] {
  if (days <= 1) return '24_hours';
  if (days <= 5) return '2_5_days';
  if (days <= 10) return '6_10_days';
  return '11_days';
}

const MONTHS_NONE = 'No';

/** Repeat groups that are one list split over two sub-tabs (same `repeat_group_key`). */
const PAIRED_GROUPS: [string, string][] = [['owner_ownership', 'owner_private']];

// ── prefill: CRM → answers ──────────────────────────────────────────────────

/** Owners from the CRM's two owner groups (Ownership; never Private). */
function crmOwners(crm: CrmValues): Record<string, unknown>[] {
  return (Array.isArray(crm.owner_ownership) ? crm.owner_ownership : []).filter(
    (o): o is Record<string, unknown> => !!o && typeof o === 'object',
  );
}

/**
 * The answers the application opens with. Text the merchant can edit; never
 * an SSN or a Private value (the online form shows "On file" for an SSN
 * separately — see `ssnOnFile`).
 */
export function prefillAnswers(crm: CrmValues, labels: Labels): Answers {
  const a: Answers = {};
  const set = (k: string, v: string) => {
    if (v) a[k] = v;
  };

  set('legal_business_name', str(crm.legal_business_name));
  set('dba', str(crm.dba));
  const ma = crmAddress(crm.merchant_address);
  if (ma) a.merchant_address = ma;
  const ra = crmAddress(crm.retail_address);
  if (ra) a.retail_address = ra;
  const bo = Object.entries(BUILDING).find(([, crmKey]) => crmKey === str(crm.building_ownership));
  if (bo) a.building_ownership = bo[0];
  if (str(crm.area_zoned)) a.area_zoned = [str(crm.area_zoned)];
  const sq = SQFT_PREFILL[str(crm.square_footage)];
  if (sq) a.square_footage = [sq];
  const contact = Array.isArray(crm.contact) ? (crm.contact[0] as Record<string, unknown> | undefined) : undefined;
  set('contact_email', str(contact?.email));
  set('contact_phone', str(contact?.phone));
  set('business_founded_date', str(crm.business_founded_date));
  set('merchant_website', str(crm.merchant_website));
  const et = str(crm.entity_type);
  const etPdf = ENTITY_AS_OTHER.has(et) ? 'other' : Object.entries(ENTITY).find(([, k]) => k === et)?.[0];
  if (etPdf) a.entity_type = [etPdf];
  // Bankruptcy in the CRM is the agreement's kind — Business / Personal /
  // Never filed — or a plain Yes (the client, 30 Oct 2026); the application
  // only asks Yes / No. Older shapes (a list; the 28 Oct "no") are still read.
  const bkRaw = crm.bankruptcy;
  const bk = Array.isArray(bkRaw) ? list(bkRaw) : [str(bkRaw)];
  if (bk.includes('yes') || bk.includes('business') || bk.includes('personal')) a.bankruptcy = 'Yes';
  else if (bk.includes('no') || bk.includes('never')) a.bankruptcy = 'No';
  const cc = str(crm.cc_termination);
  if (cc === 'yes' || cc === 'no') a.cc_termination = cc === 'yes' ? 'Yes' : 'No';

  // R10: one name box, joined with a space.
  crmOwners(crm)
    .slice(0, MAX_OWNERS)
    .forEach((o, i) => {
      const n = i + 1;
      set(ownerField(n, 'name'), [str(o.first), str(o.last)].filter(Boolean).join(' '));
      set(ownerField(n, 'first'), str(o.first));
      set(ownerField(n, 'last'), str(o.last));
      set(ownerField(n, 'title'), str(o.title));
      set(ownerField(n, 'percentage'), cleanNumber(o.percentage));
      set(ownerField(n, 'email'), str(o.email));
      set(ownerField(n, 'phone'), str(o.phone));
    });

  set('prior_processor', str(crm.prior_processor));
  set('prior_pos', str(crm.prior_pos));
  // R2–R4: the card and ACH questions are prefilled from the card fields —
  // unless the record holds its own ACH figures (the ACH agreement's fields,
  // 30 Oct 2026), which the ACH questions then show instead.
  const vol = cleanNumber(crm.monthly_acq_volume);
  set('monthly_acq_volume', vol);
  set('monthly_ach_volume', cleanNumber(crm.monthly_ach_volume) || vol);
  const avg = cleanNumber(crm.avg_transaction);
  set('average_transaction_amount', avg);
  set('average_ach_transaction_amount', cleanNumber(crm.ach_avg_transaction) || avg);
  const max = cleanNumber(crm.max_transaction);
  set('maximum_transaction_amount', max);
  set('maximum_ach_transaction_amount', cleanNumber(crm.ach_max_transaction) || max);

  const months = list(crm.seasonal);
  if (months.length) a.seasonal = months.includes(MONTHS_NONE) ? 'No' : 'Yes';
  if (months.length && !months.includes(MONTHS_NONE)) set('seasonal_details', months.join(', '));

  // R11: one % box per option.
  for (const g of PERCENT_GROUPS) {
    const split = crm[g.field];
    if (!split || typeof split !== 'object' || Array.isArray(split)) continue;
    for (const [pdfOpt, crmKey] of Object.entries(g.map)) {
      const v = (split as Record<string, unknown>)[crmKey];
      if (typeof v === 'number' || (typeof v === 'string' && v !== '')) set(`${g.id}_${pdfOpt}`, cleanNumber(v));
    }
  }

  set('advertising_method', str(crm.advertising_method));
  set('return_policy', str(crm.refund_policy));
  const inv = (Array.isArray(crm.inventory) ? list(crm.inventory) : [str(crm.inventory)]).map((k) => INVENTORY_PREFILL[k]).filter((x): x is string => !!x);
  if (inv.length) a.inventory = inv;
  // R6: Yes when How Long After Charge Is Order Shipped has a value.
  a.accepts_payment_before_delivery = str(crm.charge_to_service) ? 'Yes' : 'No';
  const recv = str(crm.order_to_service);
  if (recv && RECEIVED_LABEL[recv]) set('product_received_time', RECEIVED_LABEL[recv]);
  const sm = list(crm.service_model);
  if (sm.length) a.service_model = sm;

  // R5: the new field, like any other.
  set('ach_monthly_transactions', cleanNumber(crm.ach_monthly_transactions));
  set('ach_monthly_returns', cleanNumber(crm.ach_monthly_returns));
  // Its own field since 30 Oct 2026 ("Do you issue refunds via ACH? Please
  // add here"); before that it was read off the ACH Return fee.
  const ar = str(crm.ach_refunds);
  if (ar === 'yes' || ar === 'no') a.ach_refunds = ar === 'yes' ? 'Yes' : 'No';
  else a.ach_refunds = str(crm.td_ach_return) ? 'Yes' : 'No'; // R1, until the field is set

  return a;
}

/** Owners whose SSN is on file, as "•••-••-1234". Never the number. */
export function ssnOnFile(crm: CrmValues): Record<number, string> {
  const out: Record<number, string> = {};
  const priv = Array.isArray(crm.owner_private) ? crm.owner_private : [];
  priv.slice(0, MAX_OWNERS).forEach((p, i) => {
    const digits = str((p as Record<string, unknown> | null)?.ssn).replace(/\D/g, '');
    if (digits.length >= 4) out[i + 1] = `•••-••-${digits.slice(-4)}`;
  });
  return out;
}

/** The text a PDF is filled with: dates as MM/DD/YYYY, addresses on one line, money as typed. */
export function answersForPdf(a: Answers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  // The PDF has one name box per owner.
  for (let n = 1; n <= MAX_OWNERS; n++) {
    const joined = [a[ownerField(n, 'first')], a[ownerField(n, 'last')]].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' ');
    if (joined) out[ownerField(n, 'name')] = joined;
  }
  for (const [k, v] of Object.entries(a)) {
    if (/^owner\d_(first|last)$/.test(k) || (/^owner\d_name$/.test(k) && out[k])) continue;
    if (typeof v === 'string') out[k] = k === 'business_founded_date' ? usDate(v) : v;
    else if (Array.isArray(v)) out[k] = v;
    else out[k] = addressLine(v);
  }
  return out;
}

// ── return: answers → proposals ─────────────────────────────────────────────

const answer = (a: Answers, k: string): string => {
  const v = a[k];
  return typeof v === 'string' ? v.trim() : '';
};
const ticked = (a: Answers, k: string): string[] => {
  const v = a[k];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  return [];
};
const money = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : s;
};

/**
 * Every CRM write the returned answers ask for. Blank answers produce none.
 * Classification against the CRM's current values is `classify`'s job.
 */
export function proposalsFrom(a: Answers, crm: CrmValues, labels: Labels): Proposal[] {
  const out: Proposal[] = [];
  const field = (key: string, question: string, value: unknown, display: string) =>
    out.push({ target: { kind: 'field', field: key }, fieldKey: key, question, value, display });
  const note = (key: string, question: string, body: string) => {
    if (body) out.push({ target: { kind: 'note', field: key }, fieldKey: key, question, value: body, display: body });
  };
  const choice = (key: string, question: string, crmKey: string) => field(key, question, crmKey, labels(key, crmKey));
  const pick = (key: string, question: string, options: string[], shown: string) => {
    const uniq = [...new Set(options)];
    if (uniq.length === 1) return choice(key, question, uniq[0]!);
    out.push({
      target: { kind: 'field', field: key },
      fieldKey: key,
      question,
      value: null,
      display: shown,
      candidates: uniq.map((k) => ({ value: k, display: labels(key, k) })),
    });
  };

  const text = (id: string, key: string, question: string) => {
    const v = answer(a, id);
    if (v) field(key, question, v, v);
  };
  text('legal_business_name', 'legal_business_name', 'Legal business name');
  text('dba', 'dba', 'DBA');

  for (const [id, key, q] of [
    ['merchant_address', 'merchant_address', 'Merchant address'],
    ['retail_address', 'retail_address', 'Retail address'],
  ] as const) {
    const parsed = parseAddress(a[id]);
    if (!isBlank(parsed)) field(key, q, toCrmAddress(parsed, crm[key]), addressLine(parsed));
  }

  const bo = BUILDING[answer(a, 'building_ownership')];
  if (bo) choice('building_ownership', 'Building ownership', bo);

  const zoned = ticked(a, 'area_zoned').filter((z) => ['commercial', 'industrial', 'residential'].includes(z));
  if (zoned.length) pick('area_zoned', 'Area zoned', zoned, zoned.map((z) => labels('area_zoned', z)).join(', '));

  const sqft = ticked(a, 'square_footage').flatMap((s) => SQFT_RETURN[s] ?? []);
  if (sqft.length) {
    const shown = ticked(a, 'square_footage').map((s) => s.replace('above_', 'above ').replace('_', '–')).join(', ');
    pick('square_footage', 'Square footage', sqft, `${shown} sq ft`);
  }

  // Contact Email / Phone: the first contact on the record.
  for (const [id, member, q] of [
    ['contact_email', 'email', 'Contact email'],
    ['contact_phone', 'phone', 'Contact phone'],
  ] as const) {
    const v = answer(a, id);
    if (v) out.push({ target: { kind: 'member', field: 'contact', index: 0, member }, fieldKey: 'contact', question: q, value: v, display: v });
  }

  const founded = cleanDate(answer(a, 'business_founded_date'));
  if (founded) field('business_founded_date', 'Business founded date', founded, usDate(founded));
  text('merchant_website', 'merchant_website', 'Website address');

  const ent = ticked(a, 'entity_type').map((e) => ENTITY[e]).filter((x): x is string => !!x);
  if (ent.length) {
    // "Other" against a CRM type the PDF has no box for is the same answer.
    if (!(ent.length === 1 && ent[0] === 'other' && ENTITY_AS_OTHER.has(str(crm.entity_type)))) {
      pick('entity_type', 'Entity type', ent, ent.map((e) => labels('entity_type', e)).join(', '));
    }
  }

  // Bankruptcy: Yes / No, as on the PDF.
  // Yes lands as the plain "Yes" — someone picks the kind before an agreement
  // can go out; No is "Never filed".
  const bk = answer(a, 'bankruptcy');
  if (bk === 'Yes' || bk === 'No') choice('bankruptcy', 'Bankruptcy', bk === 'Yes' ? 'yes' : 'never');
  // R7: each details box goes into its own question's notes.
  note('bankruptcy', 'Bankruptcy details', answer(a, 'bankruptcy_details'));

  const cc = answer(a, 'cc_termination');
  if (cc === 'Yes' || cc === 'No') choice('cc_termination', 'CC termination', cc === 'Yes' ? 'yes' : 'no');
  note('cc_termination', 'CC termination details', answer(a, 'cc_termination_details'));

  // R9 + R10: owners 1–4, name split at the first space; SSNs to Private.
  for (let n = 1; n <= MAX_OWNERS; n++) {
    const i = n - 1;
    const m = (member: string, q: string, v: string, display = v) => {
      if (v) out.push({ target: { kind: 'member', field: 'owner_ownership', index: i, member }, fieldKey: 'owner_ownership', question: `Owner ${n} — ${q}`, value: v, display });
    };
    // Online: first and last as typed. PDF: one box, split at the first space.
    const first = answer(a, ownerField(n, 'first'));
    const last = answer(a, ownerField(n, 'last'));
    if (first || last) {
      m('first', 'first name', first);
      m('last', 'last name', last);
    } else {
      const name = answer(a, ownerField(n, 'name')).replace(/\s+/g, ' ');
      if (name) {
        const sp = name.indexOf(' ');
        m('first', 'first name', sp < 0 ? name : name.slice(0, sp));
        m('last', 'last name', sp < 0 ? '' : name.slice(sp + 1));
      }
    }
    m('title', 'title', answer(a, ownerField(n, 'title')));
    const pct = cleanNumber(answer(a, ownerField(n, 'percentage')));
    m('percentage', 'ownership %', pct, pct ? `${pct}%` : '');
    m('email', 'email', answer(a, ownerField(n, 'email')));
    m('phone', 'phone', answer(a, ownerField(n, 'phone')));
    const ssn = answer(a, ownerField(n, 'ssn')).replace(/\D/g, '');
    if (ssn) {
      out.push({
        target: { kind: 'member', field: 'owner_private', index: i, member: 'ssn' },
        fieldKey: 'owner_private',
        question: `Owner ${n} — SSN`,
        value: ssn,
        display: `•••-••-${ssn.slice(-4)}`,
      });
    }
  }

  text('prior_processor', 'prior_processor', 'Prior processor');
  text('prior_pos', 'prior_pos', 'Prior POS');

  // R2–R4: card and ACH answers share a field; the higher one is the answer.
  for (const [card, ach, key, q] of [
    ['monthly_acq_volume', 'monthly_ach_volume', 'monthly_acq_volume', 'Monthly ACQ volume'],
    ['average_transaction_amount', 'average_ach_transaction_amount', 'avg_transaction', 'Average transaction amount'],
    ['maximum_transaction_amount', 'maximum_ach_transaction_amount', 'max_transaction', 'Maximum transaction amount'],
  ] as const) {
    const vals = [cleanNumber(answer(a, card)), cleanNumber(answer(a, ach))].filter(Boolean).map(Number);
    if (vals.length) {
      const hi = String(Math.max(...vals));
      field(key, q, hi, money(hi));
    }
  }

  // Seasonal: the CRM holds months; the application only Yes / No.
  const se = answer(a, 'seasonal');
  const months = list(crm.seasonal);
  if (se === 'No') field('seasonal', 'Seasonal', [MONTHS_NONE], 'Not seasonal');
  if (se === 'Yes') {
    // "If yes, which months?" — the months named become the field's value.
    const named = monthsIn(answer(a, 'seasonal_details'));
    if (named.length) field('seasonal', 'Seasonal', named, named.join(', '));
    else if (months.includes(MONTHS_NONE)) field('seasonal', 'Seasonal', [], 'Seasonal (months not given)');
  }
  note('seasonal', 'Seasonal details', answer(a, 'seasonal_details'));

  for (const g of PERCENT_GROUPS) {
    const split: Record<string, number> = {};
    let any = false;
    for (const [pdfOpt, crmKey] of Object.entries(g.map)) {
      const v = cleanNumber(answer(a, `${g.id}_${pdfOpt}`));
      if (v) any = true;
      split[crmKey] = v ? Number(v) : 0;
    }
    if (any) {
      const shown = Object.entries(g.map)
        .map(([, crmKey]) => `${labels(g.field, crmKey)} ${split[crmKey]}%`)
        .join(' · ');
      field(g.field, g.question, split, shown);
    }
  }

  text('advertising_method', 'advertising_method', 'Advertising method');
  text('return_policy', 'refund_policy', 'Return policy');

  const inv = [...new Set(ticked(a, 'inventory').map((i) => INVENTORY[i]).filter((x): x is string => !!x))];
  if (inv.length) field('inventory', 'Inventory', inv, inv.map((k) => labels('inventory', k)).join(', '));

  // R6: the Yes/No about paying before delivery is never written back.

  // How long until the customer receives it → the CRM's buckets.
  const recv = answer(a, 'product_received_time');
  if (recv) {
    // One of the application's choices; free text from an older PDF is read too.
    const exact = RECEIVED_CHOICES[recv];
    const days = exact ? null : receivedDays(recv);
    if (exact) choice('order_to_service', 'How long after order is product received', exact);
    else if (days !== null) choice('order_to_service', 'How long after order is product received', receivedBucket(days));
    else pick('order_to_service', 'How long after order is product received', [...RECEIVED_BUCKETS], recv);
  }
  // R8: "Additional comments" go into that question's notes.
  note('order_to_service', 'Product received — comments', answer(a, 'product_received_comments'));

  const svc = ticked(a, 'service_model').filter((s) => ['one_time', 'recurring', 'extended', 'subscriptions', 'memberships'].includes(s));
  if (svc.length) field('service_model', 'Service model', svc, svc.map((s) => labels('service_model', s)).join(', '));

  const ar = answer(a, 'ach_refunds');
  if (ar === 'Yes' || ar === 'No') choice('ach_refunds', 'ACH refunds', ar === 'Yes' ? 'yes' : 'no');

  // R5
  const achTx = cleanNumber(answer(a, 'ach_monthly_transactions'));
  if (achTx) field('ach_monthly_transactions', 'Monthly ACH transactions', achTx, achTx);
  const achRet = cleanNumber(answer(a, 'ach_monthly_returns'));
  if (achRet) field('ach_monthly_returns', 'ACH monthly returns', achRet, achRet);
  // R1: "Do you issue refunds via ACH?" is never written into ACH Return (a fee).

  return out;
}

// ── classification against the CRM ──────────────────────────────────────────

export function currentValue(t: Target, crm: CrmValues): unknown {
  if (t.kind === 'field') return crm[t.field];
  if (t.kind === 'note') return null;
  const arr = Array.isArray(crm[t.field]) ? (crm[t.field] as unknown[]) : [];
  const inst = arr[t.index];
  return inst && typeof inst === 'object' ? (inst as Record<string, unknown>)[t.member] : undefined;
}

/** Equal for the purpose of "Same as CRM — nothing to do". */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = list(a).slice().sort();
    const y = list(b).slice().sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== 'country'));
    return [...keys].every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  const sa = str(a);
  const sb = str(b);
  const na = cleanNumber(sa);
  const nb = cleanNumber(sb);
  if (na && nb) return Number(na) === Number(nb);
  const digits = (s: string) => s.replace(/\D/g, '');
  if (digits(sa).length >= 10 && digits(sa) === digits(sb) && /^[\d\s()+.-]+$/.test(sa) && /^[\d\s()+.-]+$/.test(sb)) return true;
  return sa.toLowerCase() === sb.toLowerCase();
}

export type Classified = Proposal & {
  status: 'applied' | 'pending' | 'same';
  crmValue: unknown;
};

/**
 * The spec's table: empty CRM → written automatically; same → nothing;
 * different → held for review; blank answer → no proposal at all. A pick
 * between candidates is always a review, unless the CRM already holds one
 * of them. Notes add, never replace, so they always apply.
 */
export function classify(p: Proposal, crm: CrmValues): Classified {
  const cur = currentValue(p.target, crm);
  if (p.target.kind === 'note') return { ...p, status: 'applied', crmValue: null };
  if (p.candidates) {
    const hit = p.candidates.find((c) => sameValue(c.value, cur));
    return { ...p, status: hit ? 'same' : 'pending', crmValue: cur };
  }
  if (sameValue(p.value, cur)) return { ...p, status: 'same', crmValue: cur };
  if (isBlank(cur)) return { ...p, status: 'applied', crmValue: cur };
  return { ...p, status: 'pending', crmValue: cur };
}

// ── turning accepted proposals into one write ───────────────────────────────

export type Write = { values: Record<string, unknown>; notes: { field_key: string; body: string }[] };

/**
 * Field values (repeat groups as whole arrays, members merged into the
 * current instances) and notes, for `application_write_values`.
 */
export function buildWrite(items: { target: Target; value: unknown; question: string }[], crm: CrmValues): Write {
  const values: Record<string, unknown> = {};
  const notes: Write['notes'] = [];
  const arrays = new Map<string, Record<string, unknown>[]>();
  for (const it of items) {
    const t = it.target;
    if (t.kind === 'field') values[t.field] = it.value;
    else if (t.kind === 'note') notes.push({ field_key: t.field, body: `${it.question}: ${String(it.value)}` });
    else {
      if (!arrays.has(t.field)) {
        const cur = Array.isArray(crm[t.field]) ? (crm[t.field] as unknown[]) : [];
        arrays.set(t.field, cur.map((x) => (x && typeof x === 'object' ? { ...(x as Record<string, unknown>) } : {})));
      }
      const arr = arrays.get(t.field)!;
      while (arr.length <= t.index) arr.push({});
      arr[t.index]![t.member] = it.value;
    }
  }
  // The two owner groups are one list shown on two sub-tabs, paired by
  // position: adding Owner 3's name must add Owner 3's (empty) SSN slot too.
  for (const pair of PAIRED_GROUPS) {
    if (!pair.some((g) => arrays.has(g))) continue;
    const lists = pair.map((g) => arrays.get(g) ?? (Array.isArray(crm[g]) ? (crm[g] as Record<string, unknown>[]).map((x) => ({ ...(x ?? {}) })) : []));
    const len = Math.max(...lists.map((l) => l.length));
    pair.forEach((g, i) => {
      const l = lists[i]!;
      while (l.length < len) l.push({});
      arrays.set(g, l);
    });
  }
  for (const [k, arr] of arrays) values[k] = arr;
  return { values, notes };
}
