/**
 * What the drawer's "Find a field" searches, and how a query ranks it. No React
 * here, so the page can build the list on the server and a test can read it.
 *
 * Built from the tabs this viewer got, so a hidden field or tab is not in it.
 */
import type { FileRow } from '@/lib/records/files';
import type { TabPayload } from './DrawerTabs';

export type FieldHit = {
  /** Unique in the list. */
  id: string;
  /** The landing target: a field or group key, `group.member`, or a file row id. */
  key: string;
  label: string;
  /** Where it lives, as the viewer reads it: "Contact › Contacts". */
  where: string;
  /** Searched as well, so "phone" finds a phone field named something else. */
  type: string;
  tabId: string;
  subtabId: string | null;
};

/** A repeat group's member, addressed like a field. */
export const memberKey = (groupKey: string, member: string) => `${groupKey}.${member}`;

export function fieldHits(tabs: TabPayload[], fileRows: FileRow[] = []): FieldHit[] {
  const out: FieldHit[] = [];
  for (const t of tabs) {
    if (t.kind === 'files') {
      for (const r of fileRows) out.push({ id: `row/${r.id}`, key: r.id, label: r.name, where: t.label, type: 'file', tabId: t.id, subtabId: null });
      continue;
    }
    if (t.kind !== 'custom') continue;
    const slots = t.subtabs.length ? t.subtabs.map((s) => ({ id: s.id as string | null, label: s.label as string | null })) : [{ id: null, label: null }];
    for (const s of slots) {
      const where = s.label ? `${t.label} › ${s.label}` : t.label;
      const place = { tabId: t.id, subtabId: s.id };
      for (const f of t.fieldsBySubtab[s.id ?? '_'] ?? []) out.push({ id: `${t.id}/${s.id ?? '_'}/${f.id}`, key: f.id, label: f.label, where, type: f.type, ...place });
      for (const g of t.repeatGroupsBySubtab[s.id ?? '_'] ?? []) {
        out.push({ id: `${t.id}/${s.id ?? '_'}/${g.key}`, key: g.key, label: g.label, where, type: 'group', ...place });
        for (const m of g.schema) {
          const key = memberKey(g.key, m.key);
          out.push({ id: `${t.id}/${s.id ?? '_'}/${key}`, key, label: m.label, where: `${where} › ${g.label}`, type: m.type, ...place });
        }
      }
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Edit distance where two swapped letters count once, the commonest slip. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, before[j - 2]! + 1);
    }
    before = prev;
    prev = row;
  }
  return prev[b.length]! <= max;
}

/** A slip of the fingers: "phne", "emial". Compares against the word's start, so "phn" still meets "phone". */
function closeTo(word: string, q: string): boolean {
  if (q.length < 4) return false;
  const max = q.length < 6 ? 1 : 2;
  return within(word, q, max) || within(word.slice(0, q.length), q, max);
}

function rank(h: FieldHit, q: string, words: string[]): number {
  const label = norm(h.label);
  const labelWords = label.split(' ');
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (words.every((w) => labelWords.some((l) => l.startsWith(w)))) return 2;
  if (words.every((w) => label.includes(w))) return 3;
  const place = `${label} ${norm(h.where)}`;
  if (words.every((w) => place.split(' ').some((l) => l.startsWith(w)))) return 4;
  if (q.length >= 3 && norm(h.type).startsWith(q)) return 5;
  if (words.every((w) => labelWords.some((l) => closeTo(l, w)))) return NEAR_MISS;
  return -1;
}

const NEAR_MISS = 6;

/** The fields a query means, best first: its name, then where it lives, then its kind. A near miss shows only when nothing better did, so a typo is forgiven without burying a real match. */
export function searchFields(all: FieldHit[], query: string): FieldHit[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ');
  const ranked = all
    .map((h) => ({ h, score: rank(h, q, words) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.h.label.localeCompare(b.h.label) || a.h.where.localeCompare(b.h.where));
  const exact = ranked.filter((x) => x.score < NEAR_MISS);
  return (exact.length ? exact : ranked).map((x) => x.h);
}

/** The label cut around the first word the query starts or sits in, to draw it stronger. */
export function matchedPart(label: string, query: string): [string, string, string] {
  const word = norm(query).split(' ')[0] ?? '';
  const at = word ? label.toLowerCase().indexOf(word) : -1;
  if (at < 0) return [label, '', ''];
  return [label.slice(0, at), label.slice(at, at + word.length), label.slice(at + word.length)];
}
