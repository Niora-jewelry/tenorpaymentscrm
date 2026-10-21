import { describe, it, expect } from 'vitest';
import { sanitizeEmail, sanitizeOutgoing } from './sanitize';

const clean = (html: string) => sanitizeEmail(html, 'html');

describe('sanitizeEmail — nothing active survives', () => {
  const attacks: Array<[string, string, RegExp]> = [
    ['script tag', '<p>hi</p><script>alert(1)</script>', /<script|alert/i],
    ['onerror', '<img src=x onerror="alert(1)">', /onerror|alert/i],
    ['javascript: link', '<a href="javascript:alert(1)">x</a>', /javascript:/i],
    ['data: html link', '<a href="data:text/html,<script>alert(1)</script>">x</a>', /href="data:/i],
    ['iframe', '<iframe src="https://evil.example"></iframe>', /<iframe/i],
    ['form', '<form action="https://evil.example"><input name=p><button>go</button></form>', /<form|<input|<button|action=/i],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">', /<meta|refresh/i],
    ['svg onload', '<svg onload="alert(1)"><circle/></svg>', /<svg|onload/i],
    ['object/embed', '<object data="x.swf"></object><embed src="x.swf">', /<object|<embed/i],
    ['base href', '<base href="https://evil.example/">', /<base/i],
    ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/x.css">', /<link/i],
    ['css import', '<style>@import url(https://evil.example/x.css); p{color:red}</style>', /@import|evil\.example/i],
    ['css expression', '<div style="width: expression(alert(1))">x</div>', /expression|alert/i],
    ['css remote url (tracking)', '<div style="background:url(https://track.example/p.gif)">x</div>', /track\.example/i],
    // Whatever text survives stays INSIDE the style element: no script element.
    ['style breakout splice', '<style>p{}</sty@import x;le><script>alert(1)</script></style>', /<script|<\/style>[^]*alert/i],
    ['srcset', '<img srcset="https://track.example/a.gif 1x">', /srcset|track\.example/i],
    ['td background', '<table><tr><td background="https://track.example/b.gif">x</td></tr></table>', /background=|track\.example/i],
    ['mXSS noscript', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', /onerror|alert/i],
    ['video poster', '<video poster="https://track.example/v.gif"></video>', /<video|track\.example/i],
  ];
  for (const [name, input, bad] of attacks) {
    it(name, () => {
      expect(clean(input).html).not.toMatch(bad);
    });
  }
});

describe('sanitizeEmail — mail still looks like mail', () => {
  it('blocks remote images until asked, remembering where they were', () => {
    const r = clean('<p>Hi</p><img src="https://cdn.example/logo.png" alt="Logo"><img src="http://t.example/pixel.gif">');
    expect(r.html).not.toContain('cdn.example');
    expect(r.html).toContain('data-mail-img="0"');
    expect(r.html).toContain('data-mail-img="1"');
    expect(r.html).toContain('alt="Logo"');
    expect(r.externalImages).toEqual(['https://cdn.example/logo.png', 'http://t.example/pixel.gif']);
  });

  it('keeps inline cid: images and small data images', () => {
    const r = clean('<img src="cid:image001.png@01DA"><img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(r.html).toContain('src="cid:image001.png@01DA"');
    expect(r.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(r.externalImages).toEqual([]);
  });

  it('keeps head <style> layout, neutralising remote url()', () => {
    const r = clean('<html><head><style>.a{color:red;background:url("https://x.example/bg.png")}</style></head><body><p class="a">x</p></body></html>');
    expect(r.html).toMatch(/<style>\.a\{color:red;background:none\}<\/style>/);
    expect(r.html).toContain('<p class="a">x</p>');
  });

  it('opens links in a new tab without leaking the opener', () => {
    const r = clean('<a href="https://tapdash.co/x">site</a> <a href="mailto:a@b.com">mail</a> <a href="#top">top</a>');
    expect(r.html).toContain('href="https://tapdash.co/x" target="_blank" rel="noopener noreferrer nofollow"');
    expect(r.html).toContain('href="mailto:a@b.com"');
    expect(r.html).toContain('<a href="#top">top</a>');
  });

  it('keeps ordinary inline styles and tables', () => {
    const r = clean('<table width="600"><tr><td style="color:#333;padding:8px">Cell</td></tr></table>');
    expect(r.html).toContain('style="color:#333;padding:8px"');
    expect(r.html).toContain('width="600"');
  });

  it('derives searchable text without image alt noise or URLs', () => {
    const r = clean('<p>Invoice <b>#42</b> is due</p><a href="https://pay.example/very/long">Pay now</a><img src="https://x/y.png" alt="logo">');
    expect(r.text).toContain('Invoice #42 is due');
    expect(r.text).toContain('Pay now');
    expect(r.text).not.toContain('pay.example');
  });

  it('escapes plain-text bodies instead of parsing them', () => {
    const r = sanitizeEmail('Hello <script>alert(1)</script>\nBye', 'text');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).not.toContain('<script>');
    expect(r.text).toBe('Hello <script>alert(1)</script>\nBye');
  });

  it('copes with empty and null bodies', () => {
    expect(clean('').html).toBe('');
    expect(sanitizeEmail(null).text).toBe('');
  });

  it('is stable across calls (no state leaks between messages)', () => {
    clean('<img src="https://a.example/1.png">');
    const r = clean('<img src="https://b.example/2.png">');
    expect(r.externalImages).toEqual(['https://b.example/2.png']);
    expect(r.html).toContain('data-mail-img="0"');
  });
});

describe('sanitizeOutgoing', () => {
  it('keeps the person’s formatting, https images and links; strips anything active', () => {
    const out = sanitizeOutgoing('<p><b>Hi</b> <a href="https://tapdash.co">site</a></p><img src="https://cdn.tapdash.co/logo.png"><img src="http://x/y.gif"><script>x()</script><img src=x onerror=alert(1)><iframe></iframe>');
    expect(out).toContain('<b>Hi</b>');
    expect(out).toContain('src="https://cdn.tapdash.co/logo.png"');
    expect(out).not.toContain('http://x/y.gif');
    expect(out).not.toMatch(/<script|onerror|<iframe/i);
    expect(out).not.toContain('data-mail-img');
  });

  it('does not leak outbound mode into the next inbound sanitise', () => {
    sanitizeOutgoing('<img src="https://a.example/1.png">');
    expect(sanitizeEmail('<img src="https://a.example/1.png">').externalImages).toEqual(['https://a.example/1.png']);
  });
});
