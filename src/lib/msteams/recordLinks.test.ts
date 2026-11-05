/**
 * Who gets what of a chat linked to a record. These are the rules the browser cannot be
 * trusted with: being able to open a record must never be a way into a conversation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const state = {
  cap: 'edit' as 'edit' | 'view' | 'hidden',
  visible: true,
  opens: true,
  configured: true,
  impersonating: false,
  emailAccess: true,
  seesAll: false,
  wholeOrg: true,
  flagged: true,
  hiddenOwner: false,
  mine: [] as Record<string, unknown>[],
  // identity id -> the conversations Microsoft says it is in
  memberOf: {} as Record<string, string[]>,
  down: false,
  links: [] as Record<string, unknown>[],
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  rpcResult: 'link-1' as string | null,
};

class FakeEmailAccessError extends Error {}

vi.mock('@/lib/auth/impersonation', () => ({ currentImpersonation: async () => (state.impersonating ? { userId: 'x' } : null) }));
vi.mock('@/lib/integrations/resolve', () => ({ mailReady: async () => state.configured }));
vi.mock('@/lib/mail/access', () => ({
  EmailAccessError: FakeEmailAccessError,
  requireEmailAccess: async () => {
    if (!state.emailAccess) throw new FakeEmailAccessError('no');
  },
}));
vi.mock('@/lib/mail/scopes', () => ({ teamsGranted: (s: string[]) => s.includes('chat') }));
vi.mock('@/lib/records/config', () => ({
  loadConfig: async () => ({
    subtabs: state.flagged ? [{ id: 'sub', tabId: 'tab', key: 'chats-here', showsRecordChats: true }] : [{ id: 'sub', tabId: 'tab', key: 'chats-here', showsRecordChats: false }],
    tabs: [{ id: 'tab', key: 'comms' }],
  }),
}));
vi.mock('@/lib/records/notifications', () => ({ moduleForRecords: async (_: unknown, ids: string[]) => new Map(ids.map((id) => [id, { slug: 'somewhere', label: 'Somewhere' }])) }));
vi.mock('@/lib/records/permissions', () => ({
  seesAll: async (_: unknown, what: string) => (what === 'communication' ? state.wholeOrg : state.seesAll),
  permissionsFor: async () => ({ settings: {} }),
}));
vi.mock('@/lib/records/tabAccess', () => ({ subtabCapsFor: async (_: unknown, ids: string[]) => new Map(ids.map((id) => [id, state.cap])) }));

function table(name: string) {
  const f: Record<string, unknown> = {};
  const rows = () => {
    if (name === 'record_teams_links') {
      return state.links.filter((l) => (f.record_id ? l.record_id === f.record_id : true) && (f.ref_key ? l.ref_key === f.ref_key : true) && (f.id ? l.id === f.id : true));
    }
    if (name === 'profiles') return [{ id: 'linker', full_name: 'Lee Linker', email: 'lee@x.test' }];
    if (name === 'mail_identities') return state.mine.filter((i) => (f.user_id ? i.user_id === f.user_id : true) && (f.id ? i.id === f.id : true));
    if (name === 'mail_user_settings') return [{ hide_my_chat: state.hiddenOwner, hide_my_calendar: false }];
    return [];
  };
  const api: Record<string, unknown> = {
    select: () => api,
    eq: (c: string, v: unknown) => {
      f[c] = v;
      return api;
    },
    is: () => api,
    in: () => api,
    order: () => api,
    neq: () => api,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null }),
  };
  return api;
}
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: table,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpc.push({ fn, args });
      return { data: state.rpcResult, error: null };
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    rpc: async () => ({ data: state.opens, error: null }),
    from: () => {
      const api: Record<string, unknown> = {
        select: () => api,
        in: () => api,
        is: () => api,
        ilike: () => api,
        order: () => api,
        limit: () => api,
        then: (resolve: (v: unknown) => void) => resolve({ data: state.visible ? [{ id: 'rec', deal_name: 'Acme' }] : [], error: null }),
      };
      return api;
    },
  }),
}));

class FakeGraphError extends Error {
  constructor(public status: number) {
    super('graph');
  }
}
const graphCalls: string[] = [];
vi.mock('@/lib/mail/graph/transport', () => ({ GraphError: FakeGraphError, batchItemError: () => null }));
vi.mock('@/lib/mail/tokens', () => ({
  graphForIdentity: (identityId: string) => ({
    baseUrl: 'https://graph.test',
    request: async ({ path }: { path: string }) => {
      graphCalls.push(`${identityId} ${path}`);
      if (state.down) throw new FakeGraphError(503);
      const inIt = (state.memberOf[identityId] ?? []).some((id) => decodeURIComponent(path).includes(id));
      if (!inIt) throw new FakeGraphError(404);
      if (path.includes('/channels/') && path.endsWith('/messages')) return { value: [] };
      if (path.includes('/channels/')) return { id: 'c1', displayName: 'General' };
      if (path.startsWith('/teams/')) return { id: 't1', displayName: 'Sales' };
      return { id: 'c-1', topic: 'Acme setup', chatType: 'group', members: [{ userId: 'u1', displayName: 'Viv Viewer' }, { userId: 'u2', displayName: 'Lee Linker' }] };
    },
  }),
}));
vi.mock('isomorphic-dompurify', () => ({ default: { sanitize: (s: string) => s } }));

const { recordChats, linkConversation, unlinkConversation, chatRecords, findRecordsToLink } = await import('./recordLinks');
const { TeamsError } = await import('./access');

const ctx = { userId: 'viewer', isAdmin: false } as never;
const identity = (id: string, user_id: string, extra: Record<string, unknown> = {}) => ({
  id, user_id, microsoft_user_id: `ms-${id}`, tenant_id: 't', primary_email: `${id}@x.test`, display_name: `Name ${id}`, status: 'ok', scopes: ['chat'], ...extra,
});
const link = (extra: Record<string, unknown> = {}) => ({
  id: 'l1', record_id: 'rec', conversation_kind: 'chat', chat_id: 'c-1', team_id: null, channel_id: null, ref_key: 'chat|c-1', chat_kind: 'group',
  title: 'Acme setup', team_name: null, linked_by: 'linker', linked_identity_id: 'theirs', linked_at: '2026-11-01T00:00:00Z', ...extra,
});

beforeEach(() => {
  Object.assign(state, {
    cap: 'edit', visible: true, opens: true, configured: true, impersonating: false, emailAccess: true, seesAll: false, wholeOrg: true, flagged: true, hiddenOwner: false,
    mine: [identity('mine', 'viewer'), identity('theirs', 'linker')],
    memberOf: { theirs: ['c-1'] },
    down: false,
    links: [link()],
    rpc: [],
    rpcResult: 'link-1',
  });
  graphCalls.length = 0;
});

describe('recordChats', () => {
  it('reads with the viewer\'s own account when Microsoft says they are in it', async () => {
    state.memberOf.mine = ['c-1'];
    const { links } = await recordChats(ctx, 'rec');
    expect(links[0].access).toBe('member');
    expect(links[0].chat?.identityId).toBe('mine');
    expect(graphCalls.every((c) => c.startsWith('mine '))).toBe(true);
  });

  it('gives someone not in it the card, never the chat, and never touches the linker\'s token', async () => {
    const { links } = await recordChats(ctx, 'rec');
    expect(links[0]).toMatchObject({ access: 'none', chat: null, lookingThrough: null, title: 'Acme setup', linkedByName: 'Lee Linker' });
    expect(graphCalls.some((c) => c.startsWith('theirs '))).toBe(false);
  });

  it('lets All users look through the linking account', async () => {
    state.seesAll = true;
    const { links } = await recordChats(ctx, 'rec');
    expect(links[0]).toMatchObject({ access: 'look', lookingThrough: 'Name theirs' });
    expect(links[0].chat?.identityId).toBe('theirs');
  });

  it('respects someone hiding theirs, even from All users', async () => {
    state.seesAll = true;
    state.hiddenOwner = true;
    const { links } = await recordChats(ctx, 'rec');
    expect(links[0].access).toBe('none');
    expect(graphCalls.some((c) => c.startsWith('theirs '))).toBe(false);
  });

  it('needs an account of their own before All users looks at anyone\'s', async () => {
    state.seesAll = true;
    state.mine = [identity('theirs', 'linker')];
    const { links } = await recordChats(ctx, 'rec');
    expect(links[0].access).toBe('none');
    expect(graphCalls).toEqual([]);
  });

  it('says Microsoft did not answer rather than "not in this chat"', async () => {
    state.down = true;
    const { links } = await recordChats(ctx, 'rec');
    expect(links[0]).toMatchObject({ access: 'unavailable', chat: null });
  });

  it('reads nothing while impersonating, without an Email grant, or with Microsoft off', async () => {
    state.memberOf.mine = ['c-1'];
    for (const change of [{ impersonating: true }, { emailAccess: false }, { configured: false }]) {
      Object.assign(state, { impersonating: false, emailAccess: true, configured: true }, change);
      const out = await recordChats(ctx, 'rec');
      expect(out.links[0].access).toBe('none');
      expect(out.accounts).toEqual([]);
    }
    expect(graphCalls).toEqual([]);
  });

  it('refuses when the sub-tab is hidden, the record is not visible, or the flag is off', async () => {
    for (const change of [{ cap: 'hidden' }, { visible: false }, { flagged: false }]) {
      Object.assign(state, { cap: 'edit', visible: true, flagged: true }, change);
      await expect(recordChats(ctx, 'rec')).rejects.toBeInstanceOf(TeamsError);
    }
    expect(graphCalls).toEqual([]);
  });

  it('refuses a record in their list that they may not open yet, as the drawer does', async () => {
    state.opens = false;
    state.memberOf.mine = ['c-1'];
    await expect(recordChats(ctx, 'rec')).rejects.toBeInstanceOf(TeamsError);
    await expect(linkConversation(ctx, { recordId: 'rec', key: 'chat|mine|c-1' })).rejects.toBeInstanceOf(TeamsError);
    await expect(unlinkConversation(ctx, 'l1')).rejects.toBeInstanceOf(TeamsError);
    expect((await chatRecords(ctx, 'chat|mine|c-1')).records).toEqual([]);
    expect(await findRecordsToLink(ctx, 'acme')).toEqual([]);
    expect(state.rpc).toEqual([]);
    expect(graphCalls).toEqual([]);
  });

  it('reports Edit only when the chain ends in Edit', async () => {
    expect((await recordChats(ctx, 'rec')).canEdit).toBe(true);
    state.cap = 'view';
    expect((await recordChats(ctx, 'rec')).canEdit).toBe(false);
  });
});

describe('recordChats, Communication set to Own only', () => {
  beforeEach(() => {
    state.wholeOrg = false;
  });

  it('does not show the card of a chat they are not in: its name lists who is in it', async () => {
    const out = await recordChats(ctx, 'rec');
    expect(out.links).toEqual([]);
    expect(out.someUnavailable).toBe(false);
  });

  it('shows what they can read', async () => {
    state.memberOf.mine = ['c-1'];
    expect((await recordChats(ctx, 'rec')).links[0].access).toBe('member');
    state.memberOf.mine = [];
    state.seesAll = true;
    expect((await recordChats(ctx, 'rec')).links[0].access).toBe('look');
  });

  it('keeps the card of a chat they linked, even once they have left it', async () => {
    state.links = [link({ linked_by: 'viewer' })];
    const { links } = await recordChats(ctx, 'rec');
    expect(links[0]).toMatchObject({ access: 'none', chat: null, title: 'Acme setup' });
    expect(links[0]).not.toHaveProperty('mine');
  });

  it('holds a card back when Microsoft is down, and says the list may be short', async () => {
    state.down = true;
    const out = await recordChats(ctx, 'rec');
    expect(out.links).toEqual([]);
    expect(out.someUnavailable).toBe(true);
  });

  it('cannot unlink a chat it cannot see, but can its own', async () => {
    state.links = [link()];
    await expect(unlinkConversation(ctx, 'l1')).rejects.toThrow('You do not have permission');
    expect(state.rpc).toEqual([]);
    state.memberOf.mine = ['c-1'];
    await unlinkConversation(ctx, 'l1');
    expect(state.rpc).toHaveLength(1);
    state.rpc = [];
    state.memberOf.mine = [];
    state.links = [link({ linked_by: 'viewer' })];
    await unlinkConversation(ctx, 'l1');
    expect(state.rpc).toHaveLength(1);
  });

  it('does not guess during an outage when unlinking', async () => {
    state.down = true;
    await expect(unlinkConversation(ctx, 'l1')).rejects.toThrow('Microsoft did not answer');
    expect(state.rpc).toEqual([]);
  });
});

describe('linkConversation', () => {
  const key = 'chat|mine|c-1';

  it('stores what Microsoft says, naming everyone, and no account in the reference', async () => {
    state.memberOf.mine = ['c-1'];
    expect(await linkConversation(ctx, { recordId: 'rec', key })).toBe(true);
    expect(state.rpc[0]).toMatchObject({ fn: 'record_teams_link', args: { p_record: 'rec', p_actor: 'viewer', p_identity: 'mine', p_kind: 'chat', p_chat: 'c-1', p_ref: 'chat|c-1', p_title: 'Acme setup', p_chat_kind: 'group' } });
  });

  it('refuses a chat Microsoft says they are not in', async () => {
    await expect(linkConversation(ctx, { recordId: 'rec', key })).rejects.toThrow('You can only link a chat you are in.');
    expect(state.rpc).toEqual([]);
  });

  it('refuses someone else\'s account, even for a chat that account is in', async () => {
    await expect(linkConversation(ctx, { recordId: 'rec', key: 'chat|theirs|c-1' })).rejects.toBeInstanceOf(TeamsError);
    expect(state.rpc).toEqual([]);
    expect(graphCalls).toEqual([]);
  });

  it('needs Edit: View is not enough', async () => {
    state.cap = 'view';
    state.memberOf.mine = ['c-1'];
    await expect(linkConversation(ctx, { recordId: 'rec', key })).rejects.toBeInstanceOf(TeamsError);
    expect(state.rpc).toEqual([]);
  });

  it('refuses while impersonating, and without an approved account', async () => {
    state.memberOf.mine = ['c-1'];
    state.impersonating = true;
    await expect(linkConversation(ctx, { recordId: 'rec', key })).rejects.toBeInstanceOf(TeamsError);
    state.impersonating = false;
    state.mine = [identity('mine', 'viewer', { scopes: [] })];
    await expect(linkConversation(ctx, { recordId: 'rec', key })).rejects.toThrow('approved');
    expect(state.rpc).toEqual([]);
  });

  it('says false when it is already on the record', async () => {
    state.memberOf.mine = ['c-1'];
    state.rpcResult = null;
    expect(await linkConversation(ctx, { recordId: 'rec', key })).toBe(false);
  });

  it('rejects a key it cannot read', async () => {
    await expect(linkConversation(ctx, { recordId: 'rec', key: 'nonsense' })).rejects.toBeInstanceOf(TeamsError);
  });

  it('links a channel only when its messages can be read', async () => {
    const channel = 'channel|mine|t1|c1';
    await expect(linkConversation(ctx, { recordId: 'rec', key: channel })).rejects.toThrow('You can only link a chat you are in.');
    state.memberOf.mine = ['t1'];
    expect(await linkConversation(ctx, { recordId: 'rec', key: channel })).toBe(true);
    expect(state.rpc[0].args).toMatchObject({ p_kind: 'channel', p_team: 't1', p_channel: 'c1', p_ref: 'channel|t1|c1', p_title: 'General', p_team_name: 'Sales', p_chat: null });
  });
});

describe('unlinkConversation', () => {
  it('unlinks with Edit', async () => {
    await unlinkConversation(ctx, 'l1');
    expect(state.rpc[0]).toMatchObject({ fn: 'record_teams_unlink', args: { p_link: 'l1', p_actor: 'viewer' } });
  });

  it('gives one answer for no permission and no such link', async () => {
    state.cap = 'view';
    await expect(unlinkConversation(ctx, 'l1')).rejects.toThrow('You do not have permission');
    state.cap = 'edit';
    await expect(unlinkConversation(ctx, 'missing')).rejects.toThrow('You do not have permission');
    expect(state.rpc).toEqual([]);
  });
});

describe('chatRecords', () => {
  it('lists records the viewer can open, with a link to the flagged sub-tab', async () => {
    const out = await chatRecords(ctx, 'chat|mine|c-1');
    expect(out.records).toEqual([{ recordId: 'rec', name: 'Acme', href: '/somewhere?record=rec&tab=comms&subtab=chats-here' }]);
    expect(out.canLink).toBe(true);
  });

  it('hides a record whose sub-tab is hidden, not even a count', async () => {
    state.cap = 'hidden';
    expect((await chatRecords(ctx, 'chat|mine|c-1')).records).toEqual([]);
  });

  it('refuses someone else\'s account without All users, and never offers to link through it', async () => {
    await expect(chatRecords(ctx, 'chat|theirs|c-1')).rejects.toBeInstanceOf(TeamsError);
    state.seesAll = true;
    expect((await chatRecords(ctx, 'chat|theirs|c-1')).canLink).toBe(false);
  });
});

describe('findRecordsToLink', () => {
  it('offers only records the viewer can edit', async () => {
    expect(await findRecordsToLink(ctx, 'acme')).toEqual([{ id: 'rec', name: 'Acme' }]);
    state.cap = 'view';
    expect(await findRecordsToLink(ctx, 'acme')).toEqual([]);
  });

  it('does not search on one letter, or while impersonating', async () => {
    expect(await findRecordsToLink(ctx, 'a')).toEqual([]);
    state.impersonating = true;
    await expect(findRecordsToLink(ctx, 'acme')).rejects.toBeInstanceOf(TeamsError);
  });
});
