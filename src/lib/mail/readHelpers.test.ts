import { describe, it, expect } from 'vitest';
import { toPrefixTsquery } from './searchQuery';
import { splitQuotedHtml } from './content/quoted';
import { frameDocument, rewriteForFrame } from './content/frame';
import { dateGroup, rowStamp, fileSize } from './dates';

describe('toPrefixTsquery', () => {
  it('prefix-matches every word, all required', () => {
    expect(toPrefixTsquery('Inv  ACME')).toBe('inv:* & acme:*');
    expect(toPrefixTsquery('ann@client.example')).toBe('ann@client.example:*');
  });
  it('strips anything that is tsquery syntax', () => {
    expect(toPrefixTsquery("a & b | !c (d) 'e' f:*")).toBe('a:* & b:* & c:* & d:* & e:* & f:*');
    expect(toPrefixTsquery('<->')).toBeNull();
    expect(toPrefixTsquery('   ')).toBeNull();
  });
  it('caps word count and length', () => {
    expect(toPrefixTsquery(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '))!.split('&')).toHaveLength(8);
    expect(toPrefixTsquery('x'.repeat(500))).toBe(`${'x'.repeat(64)}:*`);
  });
});

describe('splitQuotedHtml', () => {
  it('splits at Outlook’s reply marker', () => {
    const r = splitQuotedHtml('<p>Thanks, sounds good.</p><div id="appendonsend"></div><div id="divRplyFwdMsg"><b>From:</b> Ann</div><p>Old</p>');
    expect(r.main).toBe('<p>Thanks, sounds good.</p>');
    expect(r.quoted).toContain('divRplyFwdMsg');
  });
  it('splits at a Gmail quote', () => {
    expect(splitQuotedHtml('<p>Yes.</p><div class="gmail_quote">On Mon … wrote:<blockquote>x</blockquote></div>').quoted).toContain('gmail_quote');
  });
  it('never hides everything or splits on an "On … wrote:" line', () => {
    expect(splitQuotedHtml('<blockquote>all quoted</blockquote>').quoted).toBeNull();
    expect(splitQuotedHtml('<p>On Mon, Ann wrote:</p><p>hello</p>').quoted).toBeNull();
    expect(splitQuotedHtml('<p>Hi</p><div id="appendonsend"></div>').quoted).toBeNull();
  });
});

describe('frame', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it('maps cid: to the inline route and only loads remote images when asked', () => {
    const html = '<img src="cid:logo@01&amp;x"><img data-mail-img="0" alt="">';
    const off = rewriteForFrame(html, id, false);
    expect(off).toContain(`src="/api/mail/inline/${id}?cid=logo%4001%26x"`);
    expect(off).not.toContain('/api/mail/image');
    const on = rewriteForFrame(html, id, true);
    expect(on).toContain(`data-mail-img="0" src="/api/mail/image?m=${id}&amp;n=0"`);
  });
  it('refuses a non-uuid message id (nothing reaches a URL unchecked)', () => {
    expect(() => rewriteForFrame('', 'x" onerror="', false)).toThrow();
  });
  it('wraps the body in a document that can load nothing remote and runs nothing', () => {
    const doc = frameDocument('<p>x</p>');
    expect(doc).toContain(`content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:"`);
    expect(doc).toContain('<base target="_blank">');
    expect(doc).not.toMatch(/<script/i);
  });
});

describe('dates', () => {
  const now = new Date(2026, 9, 21, 15, 0); // Wed 21 Oct 2026, local
  it('groups like a mail client', () => {
    expect(dateGroup(new Date(2026, 9, 21, 8).toISOString(), now)).toBe('Today');
    expect(dateGroup(new Date(2026, 9, 20, 8).toISOString(), now)).toBe('Yesterday');
    expect(dateGroup(new Date(2026, 9, 19, 8).toISOString(), now)).toBe('Monday');
    expect(dateGroup(new Date(2026, 9, 14, 8).toISOString(), now)).toBe('Last week');
    expect(dateGroup(new Date(2026, 9, 2, 8).toISOString(), now)).toBe('Earlier this month');
    expect(dateGroup(new Date(2026, 6, 2).toISOString(), now)).toBe('July');
    expect(dateGroup(new Date(2025, 6, 2).toISOString(), now)).toBe('July 2025');
  });
  it('stamps rows compactly', () => {
    expect(rowStamp(new Date(2026, 9, 21, 9, 5).toISOString(), now)).toBe('09:05');
    expect(rowStamp(new Date(2026, 9, 19, 17, 30).toISOString(), now)).toBe('Mon 17:30');
    expect(rowStamp(new Date(2026, 8, 3).toISOString(), now)).toBe('3 Sep');
    expect(rowStamp(new Date(2024, 8, 3).toISOString(), now)).toBe('3 Sep 2024');
    expect(fileSize(52_000)).toBe('51 KB');
    expect(fileSize(2_500_000)).toBe('2.4 MB');
  });
});
