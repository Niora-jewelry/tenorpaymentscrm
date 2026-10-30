/**
 * Who signs the agreement — picked by the CRM from the Ownership sub-tab,
 * never by the user (Agreement spec §4, with the client's 30 Oct ruling that
 * 25% exactly counts):
 *
 *   1. sort the owners by ownership, highest first; ties keep CRM order;
 *   2. everyone at 25% or more is in;
 *   3. while the total is under 51%, add the next largest;
 *   4. the agreement has four principal slots — more than four needed, or
 *      under 51% listed in total, blocks the send;
 *   5. each signer needs a first and last name and their own valid email —
 *      "each one signs their own personal guarantee, so each needs their own
 *      inbox".
 *
 * Pure: owners in, signers or problems out. The problems carry the owner's
 * index so the pre-send check can link to the right Ownership row.
 */

export type OwnerInput = {
  /** Position in the Ownership group, 0-based — the CRM's own order. */
  index: number;
  first: string;
  last: string;
  email: string;
  title: string;
  /** Percentage as entered; non-numeric reads as 0. */
  percentage: unknown;
};

export type Signer = {
  /** Principal slot on the agreement, 1–4. */
  slot: 1 | 2 | 3 | 4;
  index: number;
  name: string;
  first: string;
  last: string;
  email: string;
  title: string;
  percentage: number;
};

export type SignerProblem =
  | { kind: 'no_owners' }
  | { kind: 'under_51'; total: number }
  | { kind: 'too_many'; needed: number }
  | { kind: 'owner_name'; index: number }
  | { kind: 'owner_email'; index: number }
  | { kind: 'owner_email_shared'; index: number; withIndex: number };

export const MAX_SIGNERS = 4;
export const MANDATORY_PCT = 25;
export const TARGET_PCT = 51;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function pct(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[%\s,]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function selectSigners(owners: OwnerInput[]): { signers: Signer[]; problems: SignerProblem[] } {
  const problems: SignerProblem[] = [];
  const ranked = owners
    .map((o) => ({ ...o, percentage: pct(o.percentage) }))
    .filter((o) => o.percentage > 0 || o.first.trim() || o.last.trim() || o.email.trim())
    .sort((a, b) => b.percentage - a.percentage || a.index - b.index);

  if (ranked.length === 0) return { signers: [], problems: [{ kind: 'no_owners' }] };

  const chosen: typeof ranked = [];
  let total = 0;
  for (const o of ranked) {
    if (o.percentage >= MANDATORY_PCT) {
      chosen.push(o);
      total += o.percentage;
    }
  }
  for (const o of ranked) {
    if (total >= TARGET_PCT) break;
    if (chosen.includes(o)) continue;
    chosen.push(o);
    total += o.percentage;
  }
  // Slots are filled in rank order, whatever order the rules added them in.
  chosen.sort((a, b) => b.percentage - a.percentage || a.index - b.index);

  if (total < TARGET_PCT) problems.push({ kind: 'under_51', total: Math.round(total * 100) / 100 });
  if (chosen.length > MAX_SIGNERS) problems.push({ kind: 'too_many', needed: chosen.length });

  const seen = new Map<string, number>();
  for (const o of chosen) {
    if (!o.first.trim() || !o.last.trim()) problems.push({ kind: 'owner_name', index: o.index });
    const email = o.email.trim();
    if (!EMAIL.test(email)) problems.push({ kind: 'owner_email', index: o.index });
    else {
      const key = email.toLowerCase();
      const other = seen.get(key);
      if (other !== undefined) problems.push({ kind: 'owner_email_shared', index: o.index, withIndex: other });
      else seen.set(key, o.index);
    }
  }

  if (problems.length) return { signers: [], problems };
  return {
    signers: chosen.map((o, i) => ({
      slot: (i + 1) as Signer['slot'],
      index: o.index,
      name: `${o.first.trim()} ${o.last.trim()}`,
      first: o.first.trim(),
      last: o.last.trim(),
      email: o.email.trim(),
      title: o.title.trim(),
      percentage: o.percentage,
    })),
    problems: [],
  };
}

/** The sentence the pre-send check shows for a signer problem. */
export function describeSignerProblem(p: SignerProblem, ownerLabel: (index: number) => string): string {
  switch (p.kind) {
    case 'no_owners':
      return 'No owners are listed. Add every principal on the Ownership sub-tab.';
    case 'under_51':
      return `Ownership on file adds up to ${p.total}%. At least 51% must be listed before sending.`;
    case 'too_many':
      return `This merchant needs ${p.needed} principals to reach 51% ownership. The agreement only has room for ${MAX_SIGNERS}.`;
    case 'owner_name':
      return `${ownerLabel(p.index)} needs a first and last name.`;
    case 'owner_email':
      return `${ownerLabel(p.index)} needs a valid email address — the agreement goes to each signer's own inbox.`;
    case 'owner_email_shared':
      return `${ownerLabel(p.index)} and ${ownerLabel(p.withIndex)} share one email. Each signer needs their own.`;
  }
}
