import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { previewFromHtml } = await import('./linkPreview');

describe('previewFromHtml', () => {
  it('reads Open Graph tags in either attribute order, decoding entities', () => {
    const html = `<html><head><meta property="og:title" content="Tenor &amp; Co"><meta content="Payments made simple" name="og:description"><meta property="og:site_name" content="Tenor"></head>`;
    expect(previewFromHtml(html, 'https://tenor.test/a')).toEqual({ url: 'https://tenor.test/a', title: 'Tenor & Co', description: 'Payments made simple', site: 'Tenor' });
  });

  it('falls back to the title tag and the host name', () => {
    expect(previewFromHtml('<title>Hello</title>', 'https://www.site.test/x')).toEqual({ url: 'https://www.site.test/x', title: 'Hello', description: '', site: 'site.test' });
  });

  it('shows no card for a page with no title', () => {
    expect(previewFromHtml('<p>nothing</p>', 'https://a.test')).toBeNull();
  });
});
