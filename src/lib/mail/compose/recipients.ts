/**
 * Who a message goes to, decided the way Outlook decides it. Pure, tested.
 */
import type { Addr } from '../viewTypes';

export type ComposeKind = 'new' | 'reply' | 'replyAll' | 'forward';

/** Deliberately practical, not RFC 5322: what Exchange will actually accept. */
const EMAIL = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[A-Za-z]{2,}$/;

export function isEmail(s: string): boolean {
  return s.length <= 254 && EMAIL.test(s);
}

/**
 * Turns pasted text — "Ann <ann@x.com>, bob@y.com; Carol Lee <c@z.io>" —
 * into recipients. Anything that is not an address comes back in `invalid`
 * so the composer can show it rather than silently dropping it.
 */
export function parseRecipients(text: string): { valid: Addr[]; invalid: string[] } {
  const valid: Addr[] = [];
  const invalid: string[] = [];
  for (const raw of splitList(text)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(part);
    const name = (m?.[1] ?? '').trim();
    const address = (m?.[2] ?? part).trim().toLowerCase();
    if (isEmail(address)) valid.push({ name, address });
    else invalid.push(part);
  }
  return { valid: dedupe(valid), invalid };
}

/** Splits on , ; and newlines — but not inside "quoted names" or <angle brackets>. */
function splitList(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of text) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if (!quoted && !angle && (ch === ',' || ch === ';' || ch === '\n')) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function dedupe(list: Addr[]): Addr[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = a.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Reply goes to the sender (or Reply-To); Reply all adds everyone else on To
 * and Cc — never the mailbox itself. Replying to a message this mailbox SENT
 * goes back to its original recipients, as Outlook does.
 */
export function replyRecipients(
  source: { from: Addr | null; replyTo: Addr[]; to: Addr[]; cc: Addr[]; outbound: boolean },
  ownAddress: string,
  kind: ComposeKind,
): { to: Addr[]; cc: Addr[] } {
  if (kind === 'new' || kind === 'forward') return { to: [], cc: [] };
  const me = ownAddress.toLowerCase();
  const notMe = (a: Addr) => a.address.toLowerCase() !== me;
  const primary = source.outbound
    ? source.to
    : source.replyTo.length
      ? source.replyTo
      : source.from
        ? [source.from]
        : [];
  if (kind === 'reply') return { to: dedupe(primary.filter(notMe)), cc: [] };
  const to = dedupe([...primary, ...(source.outbound ? [] : source.to)].filter(notMe));
  const inTo = new Set(to.map((a) => a.address.toLowerCase()));
  const cc = dedupe(source.cc.filter((a) => notMe(a) && !inTo.has(a.address.toLowerCase())));
  return { to, cc };
}

/** "RE: Invoice" — without stacking prefixes ("RE: RE: FW: …"). */
export function subjectFor(kind: ComposeKind, subject: string): string {
  const base = subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
  if (kind === 'reply' || kind === 'replyAll') return `RE: ${base}`;
  if (kind === 'forward') return `FW: ${base}`;
  return subject;
}

export function toGraphRecipients(list: Addr[]) {
  return list.map((a) => ({ emailAddress: { address: a.address, ...(a.name ? { name: a.name } : {}) } }));
}

/**
 * Microsoft's large-attachment upload URL is pre-authorised and lives on an
 * Outlook host, not Graph. Our bearer token never goes there; the bytes go
 * only to a host that really is Microsoft's (or the local mock).
 */
export function isUploadHost(raw: string, mockBase?: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (mockBase && raw.startsWith(`${mockBase.replace(/\/+$/, '')}/`)) return true;
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const h = u.hostname.toLowerCase();
  return ['outlook.office.com', 'outlook.office365.com', 'graph.microsoft.com'].some((d) => h === d || h.endsWith(`.${d}`));
}

/** Escapes a search term for a LIKE pattern (the RPC uses `escape '\'`). */
export function likeEscape(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}
