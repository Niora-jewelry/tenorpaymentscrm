import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env.server', () => ({ serverEnv: {} }));
vi.mock('@/lib/auth/impersonation', () => ({ currentImpersonation: async () => null }));
vi.mock('@/lib/records/permissions', () => ({ permissionsFor: async () => ({}), seesAll: async () => false }));
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      upsert: async () => ({ error: null }),
      delete: () => ({ eq: () => ({ lt: async () => ({ error: null }) }) }),
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }),
    }),
  }),
}));
vi.mock('./access', async (real) => ({
  ...(await real<typeof import('./access')>()),
  readableIdentity: async () => ({ identity: { id: 'id1', microsoftUserId: 'me', tenantId: 't' } }),
}));

type Query = Record<string, string | number | undefined>;
const seen: Query[] = [];
const held = vi.hoisted(() => ({ messages: [] as Array<{ id: string; createdDateTime: string }> }));
const graphError = vi.hoisted(() => ({ make: null as null | (() => Error) }));

vi.mock('@/lib/mail/tokens', () => ({
  graphForIdentity: () => ({
    baseUrl: 'https://graph.microsoft.com/v1.0',
    batch: async () => [],
    // Behaves as Microsoft documents: a chat's created date takes `lt` only.
    request: async ({ query }: { query: Query }) => {
      seen.push(query);
      if (String(query.$filter ?? '').includes('createdDateTime gt')) throw graphError.make!();
      return { value: held.messages };
    },
  }),
}));

const { GraphError } = await import('@/lib/mail/graph/transport');
const { classifyGraphError } = await import('@/lib/mail/errors');
const { messagesPage } = await import('./chat');

graphError.make = () => new GraphError(400, classifyGraphError({ status: 400, code: 'BadRequest', message: null, retryAfter: null }), 'BadRequest');

const KEY = 'chat|id1|19:abc@thread.v2';
const ctx = {} as Parameters<typeof messagesPage>[0];
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('opening a chat', () => {
  beforeEach(() => {
    seen.length = 0;
    held.messages = [];
  });

  it('asks in a way Microsoft accepts, and shows the last two weeks', async () => {
    held.messages = [
      { id: 'new', createdDateTime: daysAgo(1) },
      { id: 'recent', createdDateTime: daysAgo(10) },
      { id: 'old', createdDateTime: daysAgo(40) },
    ];
    const page = await messagesPage(ctx, { key: KEY });
    expect(page.stale).toBeNull();
    expect(page.staleReason).toBeNull();
    expect(page.messages.map((m) => m.id)).toEqual(['recent', 'new']);
    expect(seen[0]!.$filter).toBeUndefined();
    expect(seen[0]!.$orderby).toBe('createdDateTime desc');
    expect(page.olderCursor).toBe(held.messages[1]!.createdDateTime);
  });

  it('still offers older messages when the last two weeks are empty', async () => {
    held.messages = [{ id: 'old', createdDateTime: daysAgo(40) }];
    const page = await messagesPage(ctx, { key: KEY });
    expect(page.messages).toEqual([]);
    expect(page.stale).toBeNull();
    expect(page.olderCursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('asks for older pages with `lt`, and stops at an empty one', async () => {
    const cursor = daysAgo(14);
    const page = await messagesPage(ctx, { key: KEY, cursor });
    expect(seen[0]!.$filter).toBe(`createdDateTime lt ${cursor}`);
    expect(page.olderCursor).toBeNull();
  });
});
