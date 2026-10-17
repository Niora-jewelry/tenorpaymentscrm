/**
 * Turns Graph's flat folder list into the rows `mail_apply_folder_tree`
 * writes: depth, parent, which well-known folder each is, and its sync tier.
 *
 * Ported from the old CRM's `lib/inbox/folder-tree.ts` enumeration, minus its
 * ordering hazard: there, a second pass could insert a well-known folder with
 * no marker. Here the well-known ids are resolved FIRST and applied in the
 * same write, so a folder is never stored without knowing what it is.
 *
 * Pure, unit-tested.
 */

export const WELL_KNOWN = ['inbox', 'drafts', 'sentitems', 'deleteditems', 'junkemail', 'archive', 'outbox'] as const;
export type WellKnown = (typeof WELL_KNOWN)[number];

export type Tier = 'hot' | 'warm' | 'cold';

/** What `mailFolders/delta` returns per folder (only the fields we select). */
export type GraphFolder = {
  id: string;
  displayName?: string | null;
  parentFolderId?: string | null;
  totalItemCount?: number | null;
  unreadItemCount?: number | null;
  childFolderCount?: number | null;
  '@removed'?: unknown;
};

export type FolderRow = {
  graph_id: string;
  parent_graph_id: string | null;
  display_name: string;
  well_known: WellKnown | null;
  depth: number;
  total_count: number;
  unread_count: number;
  child_count: number;
  tier: Tier;
};

/** How often each tier is reconciled is the engine's business; this only assigns. */
export function tierFor(wellKnown: WellKnown | null): Tier {
  if (wellKnown === 'inbox' || wellKnown === 'sentitems' || wellKnown === 'drafts') return 'hot';
  if (wellKnown === 'deleteditems' || wellKnown === 'junkemail' || wellKnown === 'archive') return 'warm';
  return 'cold';
}

const MAX_DEPTH = 32;

/**
 * @param folders     every live folder from the enumeration (removed ones are skipped)
 * @param wellKnownIds graph id → well-known name, from the `$batch` lookup
 */
export function planFolderTree(folders: readonly GraphFolder[], wellKnownIds: ReadonlyMap<string, WellKnown>): FolderRow[] {
  const byId = new Map<string, GraphFolder>();
  for (const f of folders) {
    if (!f?.id || f['@removed']) continue;
    byId.set(f.id, f); // a later page wins, as Graph's delta intends
  }

  const depthMemo = new Map<string, number>();
  function depthOf(id: string): number {
    const known = depthMemo.get(id);
    if (known !== undefined) return known;
    // Walk up; the root ("Top of Information Store") is not in the list.
    const seen = new Set<string>();
    let d = 0;
    let cur = byId.get(id)?.parentFolderId ?? null;
    while (cur && byId.has(cur) && !seen.has(cur) && d < MAX_DEPTH) {
      seen.add(cur);
      d += 1;
      cur = byId.get(cur)?.parentFolderId ?? null;
    }
    depthMemo.set(id, d);
    return d;
  }

  const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

  return [...byId.values()].map((f) => {
    const wk = wellKnownIds.get(f.id) ?? null;
    const parent = f.parentFolderId && byId.has(f.parentFolderId) ? f.parentFolderId : null;
    return {
      graph_id: f.id,
      parent_graph_id: parent,
      display_name: (f.displayName ?? '').slice(0, 255),
      well_known: wk,
      depth: depthOf(f.id),
      total_count: n(f.totalItemCount),
      unread_count: n(f.unreadItemCount),
      child_count: n(f.childFolderCount),
      tier: tierFor(wk),
    };
  });
}
