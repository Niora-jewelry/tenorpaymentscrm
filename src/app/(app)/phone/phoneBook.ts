/**
 * Small pure helpers the Phone page's lists share: who a number belongs to,
 * how a name becomes an avatar, and what a search box matches.
 *
 * Client-safe on purpose (no server imports): the lists run in the browser.
 */
import type { Contact } from '@/lib/phone/contacts';

export type BookEntry = { contactId: string; name: string; company: string | null };

/** Every saved number, E.164, to the contact it belongs to. */
export function nameBook(contacts: Contact[]): Map<string, BookEntry> {
  const out = new Map<string, BookEntry>();
  for (const c of contacts) {
    for (const n of c.numbers) {
      if (!out.has(n.e164)) out.set(n.e164, { contactId: c.id, name: c.displayName, company: c.company });
    }
  }
  return out;
}

/** "Dana Whitfield" → "DW"; one word gives its first two letters. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Does a search match any of these? Words match anywhere, ignoring case; digits
 * match a number however it was punctuated, so "7323" finds (732) 351-…
 */
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  return fields.some(
    (f) => !!f && (f.toLowerCase().includes(q) || (digits.length >= 2 && f.replace(/\D/g, '').includes(digits))),
  );
}

/** "4:07", the way a phone shows it. */
export function callDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** A call that rang in and was never picked up (same rule as `isMissedCall`). */
export function isMissed(call: { direction: 'in' | 'out'; status: string }): boolean {
  return call.direction === 'in' && ['no-answer', 'busy', 'failed'].includes(call.status);
}
