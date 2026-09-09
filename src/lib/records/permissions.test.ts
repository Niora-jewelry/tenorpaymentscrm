import { describe, it, expect } from 'vitest';
import { requireEdit } from './permissions';
/* The rules themselves moved to `grantRules.ts` in Phase 6c so the browser can
 * import them (`permissions.ts` is `server-only` and re-exports them). Tested
 * against their real home rather than through the re-export, so a broken
 * re-export shows up as the import failure it is instead of as these tests
 * quietly testing nothing. */
import {
  coalesceGrant,
  capGrant,
  maxGrant,
  resolveModuleGrant,
  resolveTabGrant,
  resolveFieldGrant,
  resolveScope,
  grantWriteRefusal,
  lockedGrantLevels,
  GRANT_DEFAULT,
  GRANT_LEVELS,
  FROZEN_COLUMN_FIELD_KEY,
  type ScopeCaps,
} from './grantRules';

describe('requireEdit — the guard every write path calls before touching data', () => {
  it('does nothing when the grant is edit', () => {
    expect(() => requireEdit('edit', 'Deal Name')).not.toThrow();
  });

  it('throws, naming the field, when the grant is view', () => {
    expect(() => requireEdit('view', 'Deal Name')).toThrow('No edit access to Deal Name');
  });

  it('throws, naming the field, when the grant is hidden', () => {
    expect(() => requireEdit('hidden', 'SSN')).toThrow('No edit access to SSN');
  });
});

/**
 * Phase 6b. These are the pure halves of `moduleGrant`/`tabGrant`/`fieldGrant`,
 * extracted so the grant matrix can resolve permissions for a user who is not
 * the viewer without a second copy of the rules.
 *
 * The `GRANT_DEFAULT` case is the one worth having a test for at all: one
 * planning document (`MODULE-2-PLAN.md:324`) says the fallthrough is
 * *hidden / default-deny*, and everything that actually decides — the client's
 * own spec, `SCHEMA-DECISIONS.md`, migration 7's `coalesce` and the live
 * function — says **edit**. A regression to "hidden" would not break anything
 * visibly; it would quietly lock every user out of every unlisted scope, which
 * is why it is pinned here rather than left to the SQL.
 */
describe('coalesceGrant — migration 7\'s resolution order, in TypeScript', () => {
  it('falls through to Edit when neither a user override nor a template grant exists', () => {
    expect(coalesceGrant(null, null)).toBe('edit');
    expect(GRANT_DEFAULT).toBe('edit');
  });

  it('uses the template grant when there is no user override', () => {
    expect(coalesceGrant(null, 'hidden')).toBe('hidden');
    expect(coalesceGrant(null, 'view')).toBe('view');
  });

  it('lets the user override beat the template, in both directions', () => {
    expect(coalesceGrant('edit', 'hidden')).toBe('edit');
    expect(coalesceGrant('hidden', 'edit')).toBe('hidden');
  });
});

describe('resolveModuleGrant', () => {
  it('hides an admin-only module from a non-admin, whatever the grant says', () => {
    expect(resolveModuleGrant('edit', true, false)).toBe('hidden');
  });

  it('gives an admin edit, including on an admin-only module', () => {
    expect(resolveModuleGrant('hidden', true, true)).toBe('edit');
    expect(resolveModuleGrant('hidden', false, true)).toBe('edit');
  });

  it('passes the resolved grant straight through for an ordinary module', () => {
    expect(resolveModuleGrant('view', false, false)).toBe('view');
    expect(resolveModuleGrant('hidden', false, false)).toBe('hidden');
  });
});

describe('capGrant', () => {
  it('makes a View module read-only, whatever the fields inside it say', () => {
    expect(capGrant('view', 'edit')).toBe('view');
    expect(capGrant('view', 'view')).toBe('view');
  });

  it('never lifts a field — Hidden under View stays Hidden', () => {
    expect(capGrant('view', 'hidden')).toBe('hidden');
    expect(capGrant('edit', 'hidden')).toBe('hidden');
    expect(capGrant('edit', 'view')).toBe('view');
  });

  it('changes nothing under an Edit module', () => {
    expect(capGrant('edit', 'edit')).toBe('edit');
  });

  it('hides everything under a Hidden module', () => {
    expect(capGrant('hidden', 'edit')).toBe('hidden');
    expect(capGrant('hidden', 'view')).toBe('hidden');
  });
});

describe('maxGrant — a tab lives in several modules, and meets the best of them', () => {
  it('returns the more permissive of the pair', () => {
    expect(maxGrant('view', 'edit')).toBe('edit');
    expect(maxGrant('hidden', 'view')).toBe('view');
    expect(maxGrant('hidden', 'hidden')).toBe('hidden');
  });

  it('is order-independent', () => {
    expect(maxGrant('edit', 'hidden')).toBe(maxGrant('hidden', 'edit'));
  });
});

describe('the chain, module → tab → field', () => {
  const chain = (m: 'hidden' | 'view' | 'edit', t: 'hidden' | 'view' | 'edit', f: 'hidden' | 'view' | 'edit') =>
    capGrant(m, capGrant(t, f));

  it('caps an unset (Edit) field at View when the module is View', () => {
    expect(chain('view', 'edit', 'edit')).toBe('view');
  });

  it('caps it at View when the TAB is View and the module is not', () => {
    expect(chain('edit', 'view', 'edit')).toBe('view');
  });

  it('hides everything under a Hidden module or tab', () => {
    expect(chain('hidden', 'edit', 'edit')).toBe('hidden');
    expect(chain('edit', 'hidden', 'edit')).toBe('hidden');
  });

  it('never lifts: an Edit module does not open a Hidden field', () => {
    expect(chain('edit', 'edit', 'hidden')).toBe('hidden');
    expect(chain('edit', 'edit', 'view')).toBe('view');
  });

  it('is associative — which cap is applied first cannot change the answer', () => {
    const levels = ['hidden', 'view', 'edit'] as const;
    for (const m of levels) for (const t of levels) for (const f of levels) {
      expect(capGrant(m, capGrant(t, f))).toBe(capGrant(capGrant(m, t), f));
    }
  });
});

describe('resolveTabGrant', () => {
  it('gives an admin edit and passes everything else through', () => {
    expect(resolveTabGrant('hidden', true)).toBe('edit');
    expect(resolveTabGrant('hidden', false)).toBe('hidden');
    expect(resolveTabGrant('view', false)).toBe('view');
  });
});

describe('resolveFieldGrant — the two floors, and which way each one moves', () => {
  const plain = { key: 'mid', readOnly: false };
  const readOnly = { key: 'record_creator', readOnly: true };
  const frozen = { key: FROZEN_COLUMN_FIELD_KEY, readOnly: false };

  it('caps a read-only field at View — for an admin too', () => {
    expect(resolveFieldGrant('edit', readOnly, false)).toBe('view');
    expect(resolveFieldGrant('edit', readOnly, true)).toBe('view');
  });

  it('does not lift a read-only field that is hidden or view', () => {
    expect(resolveFieldGrant('hidden', readOnly, false)).toBe('hidden');
    expect(resolveFieldGrant('view', readOnly, false)).toBe('view');
  });

  it('lifts Deal Name out of Hidden, up to View, and never further', () => {
    expect(resolveFieldGrant('hidden', frozen, false)).toBe('view');
    expect(resolveFieldGrant('view', frozen, false)).toBe('view');
    expect(resolveFieldGrant('edit', frozen, false)).toBe('edit');
  });

  it('gives an admin edit on an ordinary field regardless of the stored grant', () => {
    expect(resolveFieldGrant('hidden', plain, true)).toBe('edit');
  });

  it('passes an ordinary field through untouched for a non-admin', () => {
    expect(resolveFieldGrant('hidden', plain, false)).toBe('hidden');
    expect(resolveFieldGrant('view', plain, false)).toBe('view');
    expect(resolveFieldGrant('edit', plain, false)).toBe('edit');
  });
});

/**
 * Phase 6c. `resolveScope` is the whole resolution for one row — the coalesce,
 * then the floor, then the reason — and it is the function the grant matrix now
 * calls in TWO places: once on the server to render a row, and again in the
 * browser to recompute that row the instant a cell is changed.
 *
 * That is what these tests are really pinning. If the two halves ever answered
 * differently, the screen would show one thing while being edited and another
 * after the refresh landed, and the value the admin *saw themselves choose*
 * would be the wrong one — which is the failure this whole phase is written
 * against. One implementation is the guarantee; these check it behaves.
 */
describe('resolveScope — one row, resolved the way both halves of the matrix resolve it', () => {
  const field = { kind: 'field', readOnly: false, frozenColumn: false } as const;

  it('agrees with the pieces it is composed of, for a plain field', () => {
    const r = resolveScope(field, null, 'view', false);
    expect(r.resolved).toBe('view');
    expect(r.effective).toBe('view');
    expect(r.lock).toBeNull();
  });

  it('lets the override beat the template, and reports no lock for doing it', () => {
    expect(resolveScope(field, 'hidden', 'edit', false).resolved).toBe('hidden');
    expect(resolveScope(field, 'edit', 'hidden', false).resolved).toBe('edit');
  });

  it('resolves an unset scope to Edit — the fourth state, and the most permissive', () => {
    expect(resolveScope(field, null, null, false).resolved).toBe(GRANT_DEFAULT);
    expect(resolveScope(field, null, null, false).effective).toBe('edit');
  });

  it('reports the admin-only module floor separately from the admin shortcut', () => {
    const asNonAdmin = resolveScope({ kind: 'module', adminOnly: true }, null, 'edit', false);
    expect(asNonAdmin.effective).toBe('hidden');
    expect(asNonAdmin.lock).toMatch(/Admin-only module/);

    const asAdmin = resolveScope({ kind: 'module', adminOnly: true }, null, 'hidden', true);
    expect(asAdmin.effective).toBe('edit');
    expect(asAdmin.lock).toMatch(/^Admin —/);
  });

  it('explains a read-only cap even when it is what the admin asked for', () => {
    const r = resolveScope({ kind: 'field', readOnly: true, frozenColumn: false }, null, 'edit', false);
    expect(r.resolved).toBe('edit');
    expect(r.effective).toBe('view');
    expect(r.lock).toMatch(/Read-only field/);
  });

  it('explains the frozen-column floor, the one rule that lifts a grant', () => {
    const r = resolveScope({ kind: 'field', readOnly: false, frozenColumn: true }, 'hidden', null, false);
    expect(r.resolved).toBe('hidden');
    expect(r.effective).toBe('view');
    expect(r.lock).toMatch(/never hidden/);
  });

  it('locks every tab row for an admin subject and none for anyone else', () => {
    expect(resolveScope({ kind: 'tab' }, null, 'hidden', true).lock).toMatch(/^Admin —/);
    expect(resolveScope({ kind: 'tab' }, null, 'hidden', false).lock).toBeNull();
  });
});

/**
 * The write guard. Both caps are already unbypassable on read, so storing a
 * capped grant is harmless — and meaningless, which is the problem: a cell that
 * accepts Hidden, saves it and then displays View has lied about who can see
 * what. 6c refuses the write; 6d makes the control unreachable.
 */
describe('grantWriteRefusal — refusing a grant the floors would cancel', () => {
  it('refuses Edit on a read-only field, and allows the two it can honour', () => {
    const readOnly = { kind: 'field', readOnly: true, frozenColumn: false } as const;
    expect(grantWriteRefusal(readOnly, 'edit')).toMatch(/read-only/i);
    expect(grantWriteRefusal(readOnly, 'view')).toBeNull();
    expect(grantWriteRefusal(readOnly, 'hidden')).toBeNull();
  });

  it('refuses Hidden on the frozen column, and allows the two it can honour', () => {
    const frozen = { kind: 'field', readOnly: false, frozenColumn: true } as const;
    expect(grantWriteRefusal(frozen, 'hidden')).toMatch(/never be hidden/);
    expect(grantWriteRefusal(frozen, 'view')).toBeNull();
    expect(grantWriteRefusal(frozen, 'edit')).toBeNull();
  });

  it('refuses nothing on a module or tab — including an admin-only module', () => {
    // Deliberate: a grant on an admin-only module is a no-op for everyone, but
    // for different reasons depending on who holds the template, and a template
    // is attached to nobody in particular while it is being edited. The matrix
    // marks it with a lock instead.
    for (const level of GRANT_LEVELS) {
      expect(grantWriteRefusal({ kind: 'module', adminOnly: true }, level)).toBeNull();
      expect(grantWriteRefusal({ kind: 'tab' }, level)).toBeNull();
    }
  });

  it('allows every level on an ordinary field', () => {
    const plain = { kind: 'field', readOnly: false, frozenColumn: false } as const;
    for (const level of GRANT_LEVELS) {
      expect(grantWriteRefusal(plain, level)).toBeNull();
    }
  });
});

/**
 * Phase 6d. `lockedGrantLevels` is what the editor greys out, and the single
 * claim worth testing is that it is the SAME set the writer refuses — not a
 * similar one maintained beside it.
 *
 * Both directions of that matter and both are lies of the same kind. A control
 * that offers what the server refuses is 6c's problem restated (the admin clicks
 * and gets an error). A control that forbids what the server accepts is worse
 * and quieter: nobody gets an error, the option is simply not there, and a
 * permission the model does allow becomes unreachable through the only UI that
 * can set it. The first test below is the one that prevents both, forever, by
 * asserting equality rather than listing the caps a second time.
 */
describe('lockedGrantLevels — the greyed-out options, derived from the refusals', () => {
  const everyCaps: ScopeCaps[] = [
    { kind: 'module', adminOnly: false },
    { kind: 'module', adminOnly: true },
    { kind: 'tab' },
    { kind: 'field', readOnly: false, frozenColumn: false },
    { kind: 'field', readOnly: true, frozenColumn: false },
    { kind: 'field', readOnly: false, frozenColumn: true },
    { kind: 'field', readOnly: true, frozenColumn: true },
  ];

  it('locks exactly what the writer refuses, level by level, on every scope shape', () => {
    for (const caps of everyCaps) {
      const locked = new Map(lockedGrantLevels(caps).map((l) => [l.level, l.reason]));
      for (const level of GRANT_LEVELS) {
        expect(locked.get(level) ?? null).toBe(grantWriteRefusal(caps, level));
      }
    }
  });

  it('locks Edit on a read-only field and nothing else', () => {
    const locked = lockedGrantLevels({ kind: 'field', readOnly: true, frozenColumn: false });
    expect(locked.map((l) => l.level)).toEqual(['edit']);
    expect(locked[0].reason).toMatch(/read-only/i);
  });

  it('locks Hidden on the frozen column and nothing else', () => {
    const locked = lockedGrantLevels({ kind: 'field', readOnly: false, frozenColumn: true });
    expect(locked.map((l) => l.level)).toEqual(['hidden']);
    expect(locked[0].reason).toMatch(/never be hidden/);
  });

  it('locks both, with the right reason on each, when a field is read-only AND frozen', () => {
    const locked = lockedGrantLevels({ kind: 'field', readOnly: true, frozenColumn: true });
    expect(locked.map((l) => l.level).sort()).toEqual(['edit', 'hidden']);
    expect(locked.find((l) => l.level === 'edit')?.reason).toMatch(/read-only/i);
    expect(locked.find((l) => l.level === 'hidden')?.reason).toMatch(/never be hidden/);
  });

  /**
   * The deliberate non-locks, and the reason 6d is two locks rather than the
   * three `remaining-plan.md` describes. Both of these DO override a template —
   * `resolveScope` reports each as a `lock` — but each is a no-op only while a
   * role or a module setting stays as it is today, and 6c already declined to
   * refuse them at the writer. Greying them out would make a real person's
   * permissions unconfigurable because of a fact that is true this afternoon.
   */
  it('locks nothing on a module or a tab — including an admin-only module', () => {
    expect(lockedGrantLevels({ kind: 'module', adminOnly: true })).toEqual([]);
    expect(lockedGrantLevels({ kind: 'module', adminOnly: false })).toEqual([]);
    expect(lockedGrantLevels({ kind: 'tab' })).toEqual([]);
  });

  it('locks nothing on an ordinary field', () => {
    expect(lockedGrantLevels({ kind: 'field', readOnly: false, frozenColumn: false })).toEqual([]);
  });
});
