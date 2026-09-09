/**
 * Deterministic avatar identity — a colour and a pair of initials, from an id
 * and a display name.
 *
 * Extracted from `(app)/[module]/UserAvatar.tsx`, which had the only copy, the
 * moment a SECOND surface needed it: `kit.tsx`'s `AvatarStack` now renders real
 * people (the team-member field) alongside the prototype's `USERS` fixture, and
 * a fixture user carries a pre-assigned `hue` while a real profile does not.
 *
 * Deliberately not `'use client'` and deliberately dependency-free: it is
 * imported from `src/proto/ui/*` (client) and from `src/app/(app)/*` (client and
 * server), and a directive here would drag either side across a boundary it did
 * not ask to cross.
 */

/** A stable colour per id — the same id always lands on the same hue, so a
 * person looks the same everywhere without a colour ever being stored. */
export function hueForId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
