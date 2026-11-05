import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/mail/tokens', () => ({ graphForIdentity: () => ({}) }));
vi.mock('@/lib/auth/impersonation', () => ({ currentImpersonation: async () => null }));
vi.mock('@/lib/records/permissions', () => ({ permissionsFor: async () => ({}), seesAll: async () => false }));

const { hostedContentsFor, keptPictures, sanitizeChatHtml, imageCount, toMessage } = await import('./chat');
const { chatImageUrl, hostedImageRef, imageTypeOf, teamsCallUrl, CHAT_IMAGES_MAX_BYTES } = await import('./format');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64');
const KEY = 'chat|acc-1|19:abc@thread.v2';
const imageFor = (src: string) => {
  const ref = hostedImageRef(src);
  return ref ? chatImageUrl(KEY, ref) : null;
};

describe('hostedImageRef', () => {
  it('reads the ids of a chat picture, a channel post picture and a channel reply picture', () => {
    expect(hostedImageRef(`${GRAPH}/chats/19:abc@thread.v2/messages/1700000000000/hostedContents/aWQ9eF8w/$value`)).toEqual({ messageId: '1700000000000', replyId: null, hostedId: 'aWQ9eF8w' });
    expect(hostedImageRef(`${GRAPH}/teams/t1/channels/19:c@thread.tacv2/messages/111/hostedContents/aWQ9/$value`)).toEqual({ messageId: '111', replyId: null, hostedId: 'aWQ9' });
    expect(hostedImageRef(`${GRAPH}/teams/t1/channels/c1/messages/111/replies/222/hostedContents/aWQ9/$value`)).toEqual({ messageId: '111', replyId: '222', hostedId: 'aWQ9' });
  });

  it('refuses anything that is not a message picture', () => {
    expect(hostedImageRef('https://evil.test/a.png')).toBeNull();
    expect(hostedImageRef(`${GRAPH}/me/messages/1/attachments/2/$value`)).toBeNull();
    expect(hostedImageRef('javascript:alert(1)')).toBeNull();
    expect(hostedImageRef(`${GRAPH}/chats/x/messages/1%22onerror%3D/hostedContents/a/$value`)).toBeNull();
  });
});

describe('sanitizeChatHtml with pictures', () => {
  it('shows a Teams picture through this server, with only the attributes it writes', () => {
    const out = sanitizeChatHtml(`<p>Look</p><p><img src="${GRAPH}/chats/19:abc@thread.v2/messages/1700/hostedContents/aWQ9eF8w/$value" alt="image" onerror="alert(1)" style="width:9999px"></p>`, imageFor);
    expect(out).toContain('<img class="chat-img" src="/api/msteams/image?key=chat%7Cacc-1%7C19%3Aabc%40thread.v2&amp;m=1700&amp;h=aWQ9eF8w"');
    expect(out).not.toMatch(/onerror|style=|graph\.microsoft\.com/);
    expect(imageCount(out)).toBe(1);
  });

  it('still says to open Teams for any other picture, and without a conversation', () => {
    expect(sanitizeChatHtml('<img src="https://giphy.test/a.gif">', imageFor)).toContain('[Image: open it in Teams]');
    expect(sanitizeChatHtml(`<img src="${GRAPH}/chats/x/messages/1/hostedContents/a/$value">`)).toContain('[Image: open it in Teams]');
  });

  it('cannot be tricked by marker characters typed into the message', () => {
    const out = sanitizeChatHtml('<p>0<img src="https://x.test/a.png"></p>', imageFor);
    expect(out).not.toContain('<img');
  });

  it('counts pictures on a message', () => {
    const m = toMessage({ id: '1700', body: { contentType: 'html', content: `<p><img src="${GRAPH}/chats/19:abc@thread.v2/messages/1700/hostedContents/aWQ9/$value"></p>` } }, 'me', new Map(), KEY);
    expect(m.images).toBe(1);
    expect(m.html).toContain('/api/msteams/image?');
  });
});

describe('hostedContentsFor', () => {
  it('builds the body and hosted contents Microsoft expects, scaled to Teams width', () => {
    const out = hostedContentsFor([{ contentType: 'image/png', data: PNG, width: 1920, height: 1080 }, { contentType: 'image/jpeg', data: JPEG, width: 300, height: 200 }]);
    expect(out.hosted).toEqual([
      { '@microsoft.graph.temporaryId': '1', contentBytes: PNG, contentType: 'image/png' },
      { '@microsoft.graph.temporaryId': '2', contentBytes: JPEG, contentType: 'image/jpeg' },
    ]);
    expect(out.html).toContain('src="../hostedContents/1/$value" width="480" height="270"');
    expect(out.html).toContain('src="../hostedContents/2/$value" width="300" height="200"');
  });

  it('refuses bytes that are not the type they claim, too many, or too big together', () => {
    expect(() => hostedContentsFor([{ contentType: 'image/png', data: JPEG, width: 1, height: 1 }])).toThrow(/could not be read/);
    expect(() => hostedContentsFor(Array.from({ length: 7 }, () => ({ contentType: 'image/png' as const, data: PNG, width: 1, height: 1 })))).toThrow(/at most 6/);
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(CHAT_IMAGES_MAX_BYTES)]).toString('base64');
    expect(() => hostedContentsFor([{ contentType: 'image/png', data: big, width: 1, height: 1 }])).toThrow(/too big/);
    expect(hostedContentsFor(undefined)).toEqual({ html: '', hosted: [] });
  });
});

describe('keptPictures', () => {
  it('keeps the message’s own pictures for an edit, and nothing else', () => {
    const own = `<img src="${GRAPH}/chats/19:abc@thread.v2/messages/1/hostedContents/aWQ9/$value" width="40">`;
    expect(keptPictures(`<p>old words</p><p>${own}<img src="https://x.test/a.png"></p>`)).toBe(`<p>${own}</p>`);
    expect(keptPictures('<p>no pictures</p>')).toBe('');
  });
});

describe('imageTypeOf', () => {
  it('knows PNG, JPEG and GIF by their first bytes', () => {
    expect(imageTypeOf(Buffer.from(PNG, 'base64'))).toBe('image/png');
    expect(imageTypeOf(Buffer.from(JPEG, 'base64'))).toBe('image/jpeg');
    expect(imageTypeOf(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(imageTypeOf(Buffer.from('<svg'))).toBeNull();
  });
});

describe('teamsCallUrl', () => {
  it('calls by address, by Microsoft id when there is no address, on the chat’s own account', () => {
    expect(teamsCallUrl([{ email: 'ana@x.com', id: 'a1' }, { email: '', id: 'b2' }], 'tenant-1')).toBe('https://teams.microsoft.com/l/call/0/0?users=ana%40x.com,8%3Aorgid%3Ab2&tenantId=tenant-1');
  });

  it('has nobody to call without an address or an id', () => {
    expect(teamsCallUrl([{ email: '', id: '' }], null)).toBeNull();
    expect(teamsCallUrl([], 't')).toBeNull();
  });
});
