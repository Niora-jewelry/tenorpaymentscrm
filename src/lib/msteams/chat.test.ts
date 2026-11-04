import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/mail/tokens', () => ({ graphForIdentity: () => ({}) }));
vi.mock('@/lib/auth/impersonation', () => ({ currentImpersonation: async () => null }));
vi.mock('@/lib/records/permissions', () => ({ permissionsFor: async () => ({}), seesAll: async () => false }));

const { applyMentions, cursorIsValid, parseKey, sanitizeChatHtml, toMessage } = await import('./chat');

const GRAPH = 'https://graph.microsoft.com/v1.0';

describe('conversation keys', () => {
  it('reads chat and channel keys and refuses anything else', () => {
    expect(parseKey('chat|id1|19:abc@thread.v2')).toEqual({ identityId: 'id1', kind: 'chat', chatId: '19:abc@thread.v2' });
    expect(parseKey('channel|id1|team|19:ch@thread.tacv2')).toEqual({ identityId: 'id1', kind: 'channel', teamId: 'team', channelId: '19:ch@thread.tacv2' });
    expect(parseKey('chat|id1')).toBeNull();
    expect(parseKey('mail|id1|x')).toBeNull();
    expect(parseKey('channel|id1||x')).toBeNull();
  });
});

describe('paging cursor', () => {
  const chat = parseKey('chat|id1|19:abc@thread.v2')!;
  const channel = parseKey('channel|id1|team1|19:ch@thread.tacv2')!;

  it('accepts only a timestamp for a chat', () => {
    expect(cursorIsValid(chat, '2026-11-01T10:00:00.123Z', GRAPH)).toBe(true);
    expect(cursorIsValid(chat, `${GRAPH}/me/messages`, GRAPH)).toBe(false);
    expect(cursorIsValid(chat, "2026-11-01T10:00:00Z or 1 eq 1", GRAPH)).toBe(false);
  });

  it('accepts only Graph’s next link for this very channel, never another path on the owner’s account', () => {
    const own = `${GRAPH}/teams/team1/channels/${encodeURIComponent('19:ch@thread.tacv2')}/messages?$skiptoken=abc`;
    expect(cursorIsValid(channel, own, GRAPH)).toBe(true);
    expect(cursorIsValid(channel, `${GRAPH}/me/messages?$top=50`, GRAPH)).toBe(false);
    expect(cursorIsValid(channel, `${GRAPH}/teams/other/channels/x/messages`, GRAPH)).toBe(false);
    expect(cursorIsValid(channel, `https://evil.test/v1.0/teams/team1/channels/${encodeURIComponent('19:ch@thread.tacv2')}/messages`, GRAPH)).toBe(false);
    expect(cursorIsValid(channel, 'not a url', GRAPH)).toBe(false);
  });
});

describe('sanitizeChatHtml', () => {
  it('keeps formatting, drops anything that could run or reach out', () => {
    const out = sanitizeChatHtml('<p><b>Hi</b> <i>there</i></p><script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(1)"><a href="javascript:alert(1)">x</a><div style="position:fixed">y</div><iframe src="https://x.test"></iframe>');
    expect(out).toContain('<b>Hi</b>');
    expect(out).toContain('<i>there</i>');
    expect(out).not.toMatch(/script|onerror|javascript:|style=|iframe|<img/i);
    expect(out).toContain('[Image: open it in Teams]');
  });

  it('shows an @mention as the name, and drops attachment placeholders', () => {
    const out = sanitizeChatHtml('<p><at id="0">Ana Ruiz</at> see <attachment id="abc"></attachment></p>');
    expect(out).toContain('<strong>@Ana Ruiz</strong>');
    expect(out).not.toContain('attachment');
  });
});

describe('applyMentions', () => {
  it('turns @Name into what Teams notifies from, and skips anyone no longer in the text', () => {
    const r = applyMentions('<p>Hi @Ana Ruiz and @Bo</p>', [
      { id: 'u1', name: 'Ana Ruiz' },
      { id: 'u2', name: 'Gone Person' },
      { id: 'u3', name: 'Bo' },
    ]);
    expect(r.html).toBe('<p>Hi <at id="0">Ana Ruiz</at> and <at id="1">Bo</at></p>');
    expect(r.mentions).toEqual([
      { id: 0, mentionText: 'Ana Ruiz', mentioned: { user: { id: 'u1', displayName: 'Ana Ruiz', userIdentityType: 'aadUser' } } },
      { id: 1, mentionText: 'Bo', mentioned: { user: { id: 'u3', displayName: 'Bo', userIdentityType: 'aadUser' } } },
    ]);
  });

  it('escapes a name rather than letting it become markup', () => {
    const r = applyMentions('<p>@&lt;b&gt;x</p>', [{ id: 'u1', name: '<b>x' }]);
    expect(r.html).toBe('<p><at id="0">&lt;b&gt;x</at></p>');
  });
});

describe('toMessage', () => {
  it('shows a deleted message as deleted, with nothing of what it said', () => {
    const m = toMessage({ id: 'm1', deletedDateTime: '2026-11-04T10:00:00Z', body: { content: '<p>secret</p>', contentType: 'html' }, from: { user: { id: 'a', displayName: 'A' } } }, 'me');
    expect(m.deleted).toBe(true);
    expect(m.html).toBe('');
    expect(m.text).toBe('');
  });

  it('marks edits, mine, files with their size, the quote and thumbs', () => {
    const m = toMessage(
      {
        id: 'm2',
        messageType: 'message',
        createdDateTime: '2026-11-04T10:00:00Z',
        lastEditedDateTime: '2026-11-04T10:05:00Z',
        from: { user: { id: 'me', displayName: 'Me' } },
        body: { contentType: 'text', content: 'a <b> & c' },
        reactions: [{ reactionType: 'like', user: { user: { id: 'x' } } }],
        attachments: [
          { id: 'f1', contentType: 'reference', contentUrl: 'https://t.sharepoint.com/a.pdf', name: 'a.pdf' },
          { id: 'q1', contentType: 'messageReference', content: JSON.stringify({ messageId: 'q1', messagePreview: 'earlier', messageSender: { user: { displayName: 'Bo' } } }) },
        ],
      },
      'me',
      new Map([['https://t.sharepoint.com/a.pdf', 2048]]),
    );
    expect(m.mine).toBe(true);
    expect(m.edited).toBe(true);
    expect(m.html).toBe('a &lt;b&gt; &amp; c');
    expect(m.files).toEqual([{ id: 'f1', name: 'a.pdf', size: 2048, url: 'https://t.sharepoint.com/a.pdf' }]);
    expect(m.quote).toEqual({ id: 'q1', author: 'Bo', preview: 'earlier' });
    expect(m.thumbs).toBe(1);
    expect(m.thumbedByMe).toBe(false);
  });

  it('treats system events as system lines', () => {
    expect(toMessage({ id: 's', messageType: 'systemEventMessage' }, 'me').system).toBe(true);
  });
});
