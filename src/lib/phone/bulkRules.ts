/**
 * The rules for texting many people, with no server code in them, so the screen
 * and the service apply the same limits and a test can reach them directly.
 */
import { normalizePhone } from './normalize';

export const MAX_BROADCAST_RECIPIENTS = 500;

/** Twilio allows ten people in a group text. The CRM line is one of them. */
export const MAX_GROUP_MEMBERS = 9;
export const MIN_GROUP_MEMBERS = 2;

export const STOP_LINE = 'Reply STOP to opt out.';

const TOLL_FREE_AREA_CODES = new Set(['800', '833', '844', '855', '866', '877', '888']);

/**
 * Twilio group texting works on +1 ten-digit long codes only. Toll-free numbers
 * and short codes cannot take part, on either end.
 */
export function isUsLongCode(e164: string): boolean {
  const match = /^\+1([2-9]\d{2})[2-9]\d{6}$/.exec(e164);
  return Boolean(match) && !TOLL_FREE_AREA_CODES.has(match![1]!);
}

/** Numbers pasted from a sheet arrive one per line or comma separated. Spaces can be inside a number. */
export function splitNumbers(raw: string): string[] {
  return raw
    .split(/[\r\n,;\t]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export type ParsedRecipients = {
  /** Valid and de-duplicated, in the order given. */
  numbers: string[];
  /** What could not be read as a phone number, as typed. */
  invalid: string[];
  duplicates: number;
};

export function parseRecipients(values: string[]): ParsedRecipients {
  const seen = new Set<string>();
  const numbers: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;
  for (const value of values) {
    const parsed = normalizePhone(value);
    if (!parsed.ok) {
      invalid.push(value);
    } else if (seen.has(parsed.e164)) {
      duplicates += 1;
    } else {
      seen.add(parsed.e164);
      numbers.push(parsed.e164);
    }
  }
  return { numbers, invalid, duplicates };
}

/** Whether a reply is a person writing in, not the CRM's own message coming back. */
export function isPersonAuthor(author: string | undefined, source: string | undefined): boolean {
  if (!author || !author.startsWith('+')) return false;
  const from = (source ?? '').toUpperCase();
  return from !== 'API' && from !== 'SDK';
}

/** The identity the CRM line uses inside one Twilio conversation. */
export function groupIdentity(groupId: string): string {
  return `crm-${groupId}`;
}
