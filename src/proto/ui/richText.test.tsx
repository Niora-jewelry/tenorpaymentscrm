/**
 * Rich text in Updates — Modules §3.2.
 *
 * The tests that matter here are the SAFETY ones. An update body is written by
 * one user and read by every colleague, so a link scheme that slips through is
 * a stored cross-site-scripting path from any account to all of them. The
 * renderer builds React elements and never HTML, which is what makes that
 * structurally impossible; these assertions pin the one place a user string
 * still reaches an attribute.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RichText } from './richText';

const html = (body: string) => renderToStaticMarkup(<RichText body={body} />);

describe('RichText — link safety', () => {
  it('renders an http link', () => {
    const out = html('see https://example.com/x for more');
    expect(out).toContain('href="https://example.com/x"');
  });

  it('rescues a bare www address', () => {
    expect(html('www.example.com')).toContain('href="https://www.example.com"');
  });

  it('opens links in a new tab without leaking the referrer', () => {
    const out = html('https://example.com');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('refuses a javascript: URL in markdown link syntax', () => {
    const out = html('[click me](javascript:alert(1))');
    expect(out).not.toContain('href');
    expect(out).toContain('javascript:alert(1)'); // shown as text, not swallowed
  });

  it('refuses a data: URL', () => {
    const out = html('[x](data:text/html,<script>alert(1)</script>)');
    expect(out).not.toContain('href');
  });

  it('never emits raw HTML from the body', () => {
    const out = html('<img src=x onerror="alert(1)"> and <b>bold</b>');
    // Every angle bracket and quote is escaped, so the payload survives as
    // TEXT and creates no element and no attribute. The word "onerror" is still
    // in the output and must be — it is what the user typed, and hiding it
    // would be silently editing someone's message.
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(out).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('escapes an attribute break-out attempt inside a link label', () => {
    const out = html('["><script>alert(1)</script>](https://example.com)');
    expect(out).not.toContain('<script>');
  });
});

describe('RichText — formatting', () => {
  it('renders bold, italic, code and strikethrough', () => {
    const out = html('**b** *i* `c` ~~s~~');
    expect(out).toContain('<strong');
    expect(out).toContain('<em>');
    expect(out).toContain('<code');
    expect(out).toContain('<s ');
  });

  it('does not format inside a code span', () => {
    // The single-pass matcher is what guarantees this: a second pass over
    // produced nodes would format the markers it had just protected.
    const out = html('`**not bold**`');
    expect(out).not.toContain('<strong');
    expect(out).toContain('**not bold**');
  });

  it('renders a bulleted list', () => {
    const out = html('- one\n- two');
    expect(out).toContain('<ul');
    expect((out.match(/<li>/g) ?? []).length).toBe(2);
  });

  it('renders a numbered list', () => {
    const out = html('1. one\n2. two');
    expect(out).toContain('<ol');
    expect((out.match(/<li>/g) ?? []).length).toBe(2);
  });

  it('closes a quote when a list starts', () => {
    const out = html('> quoted\n- item');
    expect(out).toContain('<blockquote');
    expect(out).toContain('<ul');
  });

  it('splits paragraphs on a blank line', () => {
    const out = html('one\n\ntwo');
    expect((out.match(/<p /g) ?? []).length).toBe(2);
  });

  it('keeps a single newline inside one paragraph', () => {
    const out = html('one\ntwo');
    expect((out.match(/<p /g) ?? []).length).toBe(1);
  });

  describe('mentions — the name is bold, nothing else', () => {
    const strongOf = (out: string) => Array.from(out.matchAll(/<strong[^>]*>(.*?)<\/strong>/g)).map((m) => m[1]);
    const withNames = (body: string, names: string[]) => renderToStaticMarkup(<RichText body={body} names={names} />);

    it('bolds exactly the known name and keeps the stored text intact', () => {
      const out = withNames('thanks @Jane Doe', ['Jane Doe']);
      expect(strongOf(out)).toEqual(['@Jane Doe']);
      expect(out).toContain('thanks ');
    });

    it('does not swallow the word after a one-word name', () => {
      const out = withNames('@Alex Please call them', ['Alex']);
      expect(strongOf(out)).toEqual(['@Alex']);
      expect(out).toContain('</strong> Please call them');
    });

    it('leaves an email address alone', () => {
      expect(strongOf(withNames('write to jane@Acme.com today', ['Acme', 'Acme.com']))).toEqual([]);
    });

    it('handles a three-word name', () => {
      expect(strongOf(withNames('cc @Mary Ann Lee on this', ['Mary Ann Lee']))).toEqual(['@Mary Ann Lee']);
    });

    it('prefers the longest name', () => {
      expect(strongOf(withNames('@Alex Chen and @Alex', ['Alex', 'Alex Chen']))).toEqual(['@Alex Chen', '@Alex']);
    });

    it('leaves an unknown @word as plain text', () => {
      const out = withNames('ping @nobody and @Jane', ['Jane Doe']);
      expect(strongOf(out)).toEqual([]);
      expect(out).toContain('@nobody');
    });

    it('with no names, nothing is a mention', () => {
      expect(strongOf(html('thanks @Jane Doe'))).toEqual([]);
    });
  });

  it('renders an empty body without throwing', () => {
    expect(html('')).toBe('<div class="space-y-1.5 "></div>');
  });
});
