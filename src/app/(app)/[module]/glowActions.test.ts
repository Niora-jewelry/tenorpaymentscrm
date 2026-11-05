import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = { userId: 'u1' };
const setHidden = vi.fn(async () => {});
vi.mock('@/lib/records/permissions', () => ({ authorize: vi.fn(async () => ctx) }));
vi.mock('@/lib/records/fieldGlowAccess', () => ({ setFieldGlowHidden: (...a: unknown[]) => setHidden(...(a as [])) }));

import { setFieldGlowHiddenAction } from './glowActions';

describe('setFieldGlowHiddenAction', () => {
  beforeEach(() => setHidden.mockReset());

  it.each([true, false])('saves hidden=%s for the caller', async (hidden) => {
    expect(await setFieldGlowHiddenAction({ hidden })).toEqual({ ok: true });
    expect(setHidden).toHaveBeenCalledWith(ctx, hidden);
  });

  it.each([[null], ['yes'], [{}], [{ hidden: 'true' }], [{ hidden: 1 }]])('refuses %j without saving', async (input) => {
    expect((await setFieldGlowHiddenAction(input)).ok).toBe(false);
    expect(setHidden).not.toHaveBeenCalled();
  });

  it('a failed save is reported, not thrown', async () => {
    setHidden.mockRejectedValueOnce(new Error('db'));
    expect((await setFieldGlowHiddenAction({ hidden: true })).ok).toBe(false);
  });
});
