import { describe, it, expect } from 'vitest';
import { planFolderTree, tierFor, type WellKnown } from './folderTree';

const ROOT = 'root';

describe('planFolderTree', () => {
  const folders = [
    { id: 'in', displayName: 'Posteingang', parentFolderId: ROOT, totalItemCount: 10, unreadItemCount: 2, childFolderCount: 1 },
    { id: 'c1', displayName: 'Clients', parentFolderId: 'in', totalItemCount: 3 },
    { id: 'c2', displayName: 'Acme', parentFolderId: 'c1', totalItemCount: -4, unreadItemCount: null },
    { id: 'sent', displayName: 'Sent Items', parentFolderId: ROOT },
    { id: 'gone', displayName: 'Old', parentFolderId: ROOT, '@removed': { reason: 'deleted' } },
  ];
  const wk = new Map<string, WellKnown>([
    ['in', 'inbox'],
    ['sent', 'sentitems'],
  ]);

  it('derives depth and parent, marks well-known by id (not by localised name)', () => {
    const rows = planFolderTree(folders, wk);
    const by = Object.fromEntries(rows.map((r) => [r.graph_id, r]));
    expect(Object.keys(by).sort()).toEqual(['c1', 'c2', 'in', 'sent']);
    expect(by.in).toMatchObject({ well_known: 'inbox', depth: 0, parent_graph_id: null, tier: 'hot', unread_count: 2 });
    expect(by.c1).toMatchObject({ depth: 1, parent_graph_id: 'in', well_known: null, tier: 'cold' });
    expect(by.c2).toMatchObject({ depth: 2, parent_graph_id: 'c1', total_count: 0, unread_count: 0 });
    expect(by.sent.tier).toBe('hot');
  });

  it('survives a parent cycle and duplicate pages (later wins)', () => {
    const rows = planFolderTree(
      [
        { id: 'a', displayName: 'A', parentFolderId: 'b' },
        { id: 'b', displayName: 'B', parentFolderId: 'a' },
        { id: 'a', displayName: 'A renamed', parentFolderId: 'b' },
      ],
      new Map(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.graph_id === 'a')?.display_name).toBe('A renamed');
    for (const r of rows) expect(r.depth).toBeLessThanOrEqual(32);
  });

  it('caps display names at 255 characters', () => {
    const [r] = planFolderTree([{ id: 'x', displayName: 'n'.repeat(400) }], new Map());
    expect(r.display_name).toHaveLength(255);
  });
});

describe('tierFor', () => {
  it('hot for the folders people live in, warm for the bins, cold otherwise', () => {
    expect(tierFor('drafts')).toBe('hot');
    expect(tierFor('junkemail')).toBe('warm');
    expect(tierFor('archive')).toBe('warm');
    expect(tierFor('outbox')).toBe('cold');
    expect(tierFor(null)).toBe('cold');
  });
});
