/**
 * Regression tests for the drawer's compare-and-swap bookkeeping.
 *
 * Both bugs these cover were silent in exactly the same way: the user typed a
 * value, saw it appear, and then saw it revert with "someone else changed
 * this" — with nobody else involved. Neither threw, neither logged, and
 * neither showed up in any test, because the token lived in component state
 * where nothing could reach it.
 *
 * `recordVersion.ts` carries a `'use client'` directive, which is a no-op when
 * imported directly under Vitest's node environment — the module is plain
 * logic with no React or DOM dependency, which is most of why the token was
 * moved there.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  seedRecordVersion,
  currentToken,
  commitToken,
  isOwnToken,
  enqueueWrite,
  __resetRecordVersionsForTest,
} from './recordVersion';

const REC = 'record-1';
const T0 = '2026-09-07T10:00:00.000Z';
const T1 = '2026-09-07T10:00:01.000Z';
const T2 = '2026-09-07T10:00:02.000Z';

beforeEach(() => __resetRecordVersionsForTest());

describe('token bookkeeping', () => {
  it('starts from what the server rendered', () => {
    seedRecordVersion(REC, T0);
    expect(currentToken(REC, T0)).toBe(T0);
  });

  it('a committed write moves the token forward', () => {
    seedRecordVersion(REC, T0);
    commitToken(REC, T1);
    expect(currentToken(REC, T0)).toBe(T1);
  });

  it('SURVIVES a remount — the tab-switch bug', () => {
    // Grid mounts, user edits, the write returns a newer token.
    seedRecordVersion(REC, T0);
    commitToken(REC, T1);

    // User visits the Cases tab and comes back. The grid remounts and re-seeds
    // from the ORIGINAL server render, which is all it has. Previously that
    // reset the token to T0 and the next edit lost the compare-and-swap.
    seedRecordVersion(REC, T0);

    expect(currentToken(REC, T0)).toBe(T1);
  });

  it('adopts a genuinely newer server value, so an outside edit is recoverable', () => {
    seedRecordVersion(REC, T0);
    commitToken(REC, T1);
    // A real navigation re-renders with a row someone else has since changed.
    seedRecordVersion(REC, T2);
    expect(currentToken(REC, T0)).toBe(T2);
  });

  it('an unparseable token never displaces a good one', () => {
    seedRecordVersion(REC, T1);
    seedRecordVersion(REC, 'not-a-timestamp');
    expect(currentToken(REC, T1)).toBe(T1);
  });

  it('tells our own tokens apart from a stranger’s', () => {
    seedRecordVersion(REC, T0);
    commitToken(REC, T1);
    expect(isOwnToken(REC, T1)).toBe(true);
    expect(isOwnToken(REC, '2026-09-07T09:59:00.000Z')).toBe(false);
  });

  it('keeps records independent', () => {
    seedRecordVersion('a', T0);
    seedRecordVersion('b', T0);
    commitToken('a', T2);
    expect(currentToken('a', T0)).toBe(T2);
    expect(currentToken('b', T0)).toBe(T0);
  });
});

describe('write queue', () => {
  it('SERIALIZES writes to one record — the fast-typing bug', async () => {
    seedRecordVersion(REC, T0);

    // A fake server: accepts a write only if the token matches what it holds,
    // exactly as `set_record_value`'s compare-and-swap does.
    let held = T0;
    let issued = 0;
    const save = async (token: string) => {
      // A real round trip; the point is that the second write must not begin
      // until this one has finished and advanced the token.
      await new Promise((r) => setTimeout(r, 5));
      if (token !== held) return { ok: false as const };
      held = `2026-09-07T10:00:${String(++issued).padStart(2, '0')}.000Z`;
      return { ok: true as const, updatedAt: held };
    };

    // Two edits fired back to back, the way filling in a form actually goes.
    const writes = [1, 2, 3].map(() =>
      enqueueWrite(REC, T0, async () => {
        const result = await save(currentToken(REC, T0));
        if (result.ok) commitToken(REC, result.updatedAt);
        return result;
      }),
    );

    const results = await Promise.all(writes);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(currentToken(REC, T0)).toBe(held);
  });

  it('a failed write does not poison the ones behind it', async () => {
    seedRecordVersion(REC, T0);
    const order: string[] = [];

    const failing = enqueueWrite(REC, T0, async () => {
      order.push('first');
      throw new Error('network');
    });
    const following = enqueueWrite(REC, T0, async () => {
      order.push('second');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('network');
    await expect(following).resolves.toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });
});
