/**
 * What went out: at send time every value the agreement read is kept,
 * sealed, on the agreement row. While the agreement is open, the record is
 * compared against it on every drawer load — a changed value shows a banner
 * with the old and new value and a Void & resend button (spec §8, "When CRM
 * data changes after sending"). Sensitive values are compared but shown
 * masked.
 */
import type { Used } from './kinds/types';
import { str } from './format';

export type SnapshotEntry = { key: string; member?: string; index?: number; kind: Used['kind']; value: unknown };
export type Snapshot = { version: 1; kindVersion: string; takenAt: string; entries: SnapshotEntry[] };

export type SourceLike = { values: Record<string, unknown>; addresses: Record<string, unknown>; notes: Record<string, string> };

const read = (src: SourceLike, u: Used): unknown => {
  if (u.kind === 'address') return src.addresses[u.fieldKey] ?? null;
  if (u.kind === 'note') return src.notes[u.fieldKey] ?? '';
  const v = src.values[u.fieldKey];
  if (u.member !== undefined && u.index !== undefined) {
    const row = Array.isArray(v) ? (v[u.index] as Record<string, unknown> | undefined) : undefined;
    return row?.[u.member] ?? null;
  }
  return v ?? null;
};

export function buildSnapshot(src: SourceLike, used: Used[], kindVersion: string, takenAt: Date): Snapshot {
  return {
    version: 1,
    kindVersion,
    takenAt: takenAt.toISOString(),
    entries: used.map((u) => ({ key: u.fieldKey, member: u.member, index: u.index, kind: u.kind, value: read(src, u) })),
  };
}

const norm = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return JSON.stringify(v.map(norm));
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])])));
  }
  return String(v);
};

export type Change = { key: string; member?: string; index?: number; kind: Used['kind']; before: unknown; after: unknown };

/** Entries whose value differs now from the snapshot. */
export function diffSnapshot(snap: Snapshot, src: SourceLike): Change[] {
  const out: Change[] = [];
  for (const e of snap.entries) {
    const now = read(src, { fieldKey: e.key, member: e.member, index: e.index, kind: e.kind });
    if (norm(now) !== norm(e.value)) out.push({ key: e.key, member: e.member, index: e.index, kind: e.kind, before: e.value, after: now });
  }
  return out;
}

/** A value as the banner shows it: short, or masked. */
export function showValue(v: unknown, masked: boolean): string {
  if (masked) return v == null || v === '' ? '' : '••••';
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => str(x) || JSON.stringify(x)).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const parts = ['street', 'street2', 'city', 'state', 'zip'].map((k) => str(o[k])).filter(Boolean);
    if (parts.length) return parts.join(', ');
    return Object.entries(o).map(([k, x]) => `${k}: ${str(x)}`).join(' · ');
  }
  return str(v);
}
