/**
 * All users is look only, enforced on the server: these are the rules a hidden button
 * cannot stand in for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const state = {
  impersonating: false,
  seesAll: false,
  identities: [] as Record<string, unknown>[],
  hidden: {} as Record<string, boolean>,
};

vi.mock('@/lib/auth/impersonation', () => ({ currentImpersonation: async () => (state.impersonating ? { userId: 'x' } : null) }));
vi.mock('@/lib/records/permissions', () => ({ seesAll: async () => state.seesAll, permissionsFor: async () => ({ userType: 'member', settings: {} }) }));

/** Just enough of the query builder for the reads access.ts makes. */
function query(table: string) {
  const filters: Record<string, unknown> = {};
  const api = {
    select: () => api,
    eq: (col: string, v: unknown) => {
      filters[col] = v;
      return api;
    },
    is: () => api,
    order: () => api,
    neq: () => api,
    in: () => api,
    maybeSingle: async () => {
      if (table === 'mail_identities') return { data: state.identities.find((i) => i.id === filters.id) ?? null };
      if (table === 'mail_user_settings') {
        const uid = filters.user_id as string;
        return { data: { hide_my_calendar: Boolean(state.hidden[`${uid}:calendar`]), hide_my_chat: Boolean(state.hidden[`${uid}:chat`]) } };
      }
      return { data: null };
    },
    then: (resolve: (v: unknown) => void) => resolve({ data: table === 'mail_identities' ? state.identities.filter((i) => i.user_id === filters.user_id) : [], error: null }),
  };
  return api;
}
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ from: (t: string) => query(t) }) }));

const { dataOwner, ownIdentity, readableIdentity, TeamsError } = await import('./access');

const ctx = { userId: 'viewer', isAdmin: false } as never;
const row = (id: string, user_id: string, status = 'ok') => ({ id, user_id, microsoft_user_id: `ms-${id}`, tenant_id: 't', primary_email: `${id}@x.test`, display_name: id, status, scopes: [] });

beforeEach(() => {
  state.impersonating = false;
  state.seesAll = false;
  state.identities = [row('mine', 'viewer'), row('theirs', 'other')];
  state.hidden = {};
});

describe('dataOwner', () => {
  it('gives everyone their own', async () => {
    expect(await dataOwner(ctx, 'chat')).toEqual({ ownerId: 'viewer', own: true });
  });

  it('refuses someone else to Own only', async () => {
    await expect(dataOwner(ctx, 'chat', 'other')).rejects.toBeInstanceOf(TeamsError);
  });

  it('lets All users look, as not-own', async () => {
    state.seesAll = true;
    expect(await dataOwner(ctx, 'calendar', 'other')).toEqual({ ownerId: 'other', own: false });
  });

  it('refuses a person who hid theirs, even to All users', async () => {
    state.seesAll = true;
    state.hidden['other:chat'] = true;
    await expect(dataOwner(ctx, 'chat', 'other')).rejects.toThrow('hidden');
    // The other module is unaffected by the chat switch.
    expect((await dataOwner(ctx, 'calendar', 'other')).own).toBe(false);
  });

  it('shows only the Connect screen to a viewer with no account, even with All users', async () => {
    state.seesAll = true;
    state.identities = [row('theirs', 'other')];
    await expect(dataOwner(ctx, 'chat', 'other')).rejects.toThrow('Connect');
  });

  it('shows nothing under "sign in as"', async () => {
    state.impersonating = true;
    await expect(dataOwner(ctx, 'chat')).rejects.toBeInstanceOf(TeamsError);
  });
});

describe('ownIdentity: the only way to act', () => {
  it('acts with the caller’s own working account', async () => {
    expect((await ownIdentity(ctx, 'mine')).id).toBe('mine');
  });

  it('refuses another person’s account even to All users: look only', async () => {
    state.seesAll = true;
    await expect(ownIdentity(ctx, 'theirs')).rejects.toThrow('your own account');
  });

  it('refuses a broken connection', async () => {
    state.identities = [row('mine', 'viewer', 'broken')];
    await expect(ownIdentity(ctx, 'mine')).rejects.toThrow('reconnecting');
  });

  it('refuses under "sign in as", even the impersonated person’s own account', async () => {
    state.impersonating = true;
    await expect(ownIdentity(ctx, 'mine')).rejects.toBeInstanceOf(TeamsError);
  });
});

describe('readableIdentity', () => {
  it('reads another person’s account only with All users', async () => {
    await expect(readableIdentity(ctx, 'chat', 'theirs')).rejects.toBeInstanceOf(TeamsError);
    state.seesAll = true;
    expect(await readableIdentity(ctx, 'chat', 'theirs')).toMatchObject({ own: false });
  });
});
