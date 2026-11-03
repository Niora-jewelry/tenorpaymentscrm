/**
 * The words in a Send email step. The admin writes `{Contact name}` and `{MID}`;
 * a field is stored by key, `{field:mid}`, so renaming a field can't quietly
 * break an email. Labels are for reading, keys are for keeping.
 */

export const CONTACT_NAME = 'Contact name';
export const MERCHANT_NAME = 'Merchant name';
/** Ticket flows only (Ticket Automation Flow Builder spec). */
export const TICKET_TITLE = 'Ticket title';
export const TICKET_NUMBER = 'Ticket number';
/** Ticket flows started by Email received only. */
export const EMAIL_SUBJECT = 'Email subject';
export const EMAIL_BODY = 'Email body';
const FIXED = [CONTACT_NAME, MERCHANT_NAME, TICKET_TITLE, TICKET_NUMBER, EMAIL_SUBJECT, EMAIL_BODY];

export type VariableField = { key: string; label: string };

const norm = (s: string) => s.trim().toLowerCase();

/** Stored → what the admin reads. A field that has gone reads as its key, and fails the check below. */
export function toLabels(text: string, fields: VariableField[]): string {
  const byKey = new Map(fields.map((f) => [f.key, f.label]));
  return text.replace(/\{field:([^{}]+)\}/g, (_, key: string) => `{${byKey.get(key) ?? key}}`);
}

/** What the admin wrote → stored. `unknown` names any variable that means nothing. */
export function toTokens(text: string, fields: VariableField[]): { text: string; unknown: string[] } {
  const byLabel = new Map(fields.map((f) => [norm(f.label), f.key]));
  const unknown: string[] = [];
  const out = text.replace(/\{([^{}]+)\}/g, (whole, name: string) => {
    const n = norm(name);
    const fixed = FIXED.find((f) => norm(f) === n);
    if (fixed) return `{${fixed}}`;
    const key = byLabel.get(n);
    if (key) return `{field:${key}}`;
    unknown.push(name.trim());
    return whole;
  });
  return { text: out, unknown: [...new Set(unknown)] };
}

export type Values = {
  contact: string;
  merchant: string;
  field: (key: string) => string;
  ticketTitle?: string;
  ticketNumber?: string;
  emailSubject?: string;
  emailBody?: string;
};

export function fill(text: string, v: Values): string {
  return text
    .replace(/\{Contact name\}/g, () => v.contact)
    .replace(/\{Merchant name\}/g, () => v.merchant)
    .replace(/\{Ticket title\}/g, () => v.ticketTitle ?? '')
    .replace(/\{Ticket number\}/g, () => v.ticketNumber ?? '')
    .replace(/\{Email subject\}/g, () => v.emailSubject ?? '')
    .replace(/\{Email body\}/g, () => v.emailBody ?? '')
    .replace(/\{field:([^{}]+)\}/g, (_, key: string) => v.field(key));
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The body as written, with values filled in. Everything is escaped: a merchant's name is data, not markup. */
export function bodyHtml(text: string, v: Values): string {
  const opt = (s: string | undefined) => (s === undefined ? undefined : escape(s));
  const safe: Values = {
    contact: escape(v.contact),
    merchant: escape(v.merchant),
    field: (k) => escape(v.field(k)),
    ticketTitle: opt(v.ticketTitle),
    ticketNumber: opt(v.ticketNumber),
    emailSubject: opt(v.emailSubject),
    emailBody: opt(v.emailBody),
  };
  return fill(escape(text), safe)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}
