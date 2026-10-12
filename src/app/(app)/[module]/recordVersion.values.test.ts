/**
 * The shared value store — the thing that keeps a field showing the same
 * value in both places it appears.
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────
 * Pricing Model, Current Status, MID, MCC code and others are configured
 * into BOTH the drawer's header strip and the field grid below it. Each
 * surface used to keep its own React state, so editing one left the other
 * showing the old value — reported by the client as "pricing model not
 * syncing with header field" — and nothing corrected it, because
 * `setValueAction` skips revalidation deliberately.
 *
 * These are plain unit tests on the store rather than a rendering test,
 * because the store is the whole mechanism: both components do nothing more
 * than publish into it and subscribe to it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  publishValue,
  publishedValue,
  clearPublishedValues,
  subscribeToValues,
  valuesSnapshot,
  __resetRecordVersionsForTest,
} from './recordVersion';

const REC = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  __resetRecordVersionsForTest();
});

describe('the shared value store', () => {
  it('hands back what was published', () => {
    publishValue(REC, 'pricing_model', 'fr');
    expect(publishedValue(REC, 'pricing_model')).toEqual({ has: true, value: 'fr' });
  });

  it('reports a field nobody has written as absent, not as empty', () => {
    /*
     * The distinction is the whole reason `publishedValue` returns a wrapper.
     * "Never edited on this page" must fall through to the server's value;
     * "edited to empty" must WIN over it, or clearing a field would appear to
     * do nothing until a reload.
     */
    expect(publishedValue(REC, 'pricing_model')).toEqual({ has: false, value: undefined });

    publishValue(REC, 'pricing_model', '');
    expect(publishedValue(REC, 'pricing_model')).toEqual({ has: true, value: '' });

    publishValue(REC, 'mid', null);
    expect(publishedValue(REC, 'mid')).toEqual({ has: true, value: null });
  });

  it('keeps records apart', () => {
    publishValue(REC, 'mid', '111');
    publishValue(OTHER, 'mid', '222');
    expect(publishedValue(REC, 'mid').value).toBe('111');
    expect(publishedValue(OTHER, 'mid').value).toBe('222');
  });

  it('notifies subscribers of that record only', () => {
    let mine = 0;
    let theirs = 0;
    subscribeToValues(REC, () => { mine += 1; });
    subscribeToValues(OTHER, () => { theirs += 1; });

    publishValue(REC, 'mcc_code', '2953');
    expect(mine).toBe(1);
    expect(theirs).toBe(0);
  });

  it('changes its snapshot on every write, so useSyncExternalStore re-reads', () => {
    /*
     * The Map is mutated in place, so it can never compare unequal — the
     * snapshot has to be a separate, changing value or React would never
     * notice an edit. This test is here because returning the Map itself is
     * the obvious wrong implementation.
     */
    const before = valuesSnapshot(REC);
    publishValue(REC, 'mid', '111');
    const after = valuesSnapshot(REC);
    expect(after).not.toBe(before);

    publishValue(REC, 'mid', '222');
    expect(valuesSnapshot(REC)).not.toBe(after);
  });

  it('stops notifying once unsubscribed', () => {
    let calls = 0;
    const off = subscribeToValues(REC, () => { calls += 1; });
    publishValue(REC, 'mid', '111');
    off();
    publishValue(REC, 'mid', '222');
    expect(calls).toBe(1);
  });

  it('clears a record and tells its subscribers', () => {
    let calls = 0;
    subscribeToValues(REC, () => { calls += 1; });
    publishValue(REC, 'mid', '111');
    clearPublishedValues(REC);

    expect(publishedValue(REC, 'mid')).toEqual({ has: false, value: undefined });
    expect(calls).toBe(2);
  });

  it('does not notify when clearing a record that had nothing', () => {
    let calls = 0;
    subscribeToValues(REC, () => { calls += 1; });
    clearPublishedValues(REC);
    expect(calls).toBe(0);
  });

  it('survives the reset the other suites rely on', () => {
    publishValue(REC, 'mid', '111');
    __resetRecordVersionsForTest();
    expect(publishedValue(REC, 'mid').has).toBe(false);
  });
});
