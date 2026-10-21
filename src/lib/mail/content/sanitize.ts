/**
 * Email HTML → HTML that is safe to store and to show.
 *
 * Mail is hostile input: anyone on the internet can put markup in front of
 * a TapDash employee. This runs ONCE, at ingest, so nothing unsanitised is
 * ever stored; the reading pane then renders the result inside a sandboxed
 * `srcdoc` iframe with no script permission and its own CSP — two layers,
 * either of which alone would stop script.
 *
 * What it does beyond DOMPurify's defaults:
 *   * Drops anything active or navigating: script, iframe/frame, object,
 *     embed, form controls, meta (refresh), base, link, svg/math.
 *   * Remote images are NOT loaded: each `<img src="http…">` becomes
 *     `data-mail-img="n"` and its URL goes into `externalImages[n]`. The
 *     reader fetches them through our proxy only when the person clicks
 *     "Load images" — no tracking pixel fires on open.
 *   * CSS `url(…)` pointing anywhere but `cid:`/`data:image` is neutralised
 *     in style attributes and `<style>` blocks; `@import` is removed.
 *   * Links open in a new tab with `rel="noopener noreferrer nofollow"`;
 *     only http(s), mailto and tel survive.
 *   * `cid:` image sources are kept as-is — the reader maps them to the
 *     attachment route when it builds the frame.
 *
 * Pure (no env, no network), so it is unit-tested against a corpus of
 * attacks.
 */
import DOMPurify from 'isomorphic-dompurify';
import { convert } from 'html-to-text';

export type Sanitized = {
  html: string;
  text: string;
  externalImages: string[];
};

/** Bodies above this are not stored; the reader fetches them live. */
export const MAX_STORED_HTML = 2_000_000;
const MAX_TEXT = 200_000;
const MAX_EXTERNAL_IMAGES = 200;

const FORBID_TAGS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button',
  'select', 'option', 'textarea', 'meta', 'base', 'link', 'svg', 'math', 'noscript', 'template',
  'portal', 'audio', 'video', 'source', 'track', 'dialog',
];
const FORBID_ATTR = ['srcset', 'background', 'formaction', 'action', 'ping', 'poster', 'lowsrc', 'dynsrc', 'xmlns'];

const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const URL_IN_CSS = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
/** The whole declaration goes, not just the keyword, so no fragment of it lingers. */
const DANGEROUS_CSS = /(expression\s*\(|behavior\s*:|-moz-binding|javascript:)[^;}]*/gi;

function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(URL_IN_CSS, (_m, _q, url: string) => {
      const u = url.trim();
      return /^cid:/i.test(u) || SAFE_DATA_IMAGE.test(u) ? `url("${u.replace(/"/g, '')}")` : 'none';
    })
    .replace(DANGEROUS_CSS, '')
    // Removing text above can splice a `</style>` together out of pieces
    // (`</sty@import x;le>`). CSS never needs `<`, so none survives.
    .replace(/</g, '');
}

// DOMPurify hooks are per instance and global to it; sanitising is fully
// synchronous, so a module-level collector is safe across concurrent requests.
let collector: string[] | null = null;
/** Outbound HTML keeps its remote images: it is the person's own message, not hostile mail. */
let outbound = false;
let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.tagName) return;
    const tag = el.tagName.toLowerCase();

    if (el.hasAttribute('style')) {
      const cleaned = cleanCss(el.getAttribute('style') ?? '');
      if (cleaned.trim()) el.setAttribute('style', cleaned);
      else el.removeAttribute('style');
    }

    if (tag === 'img' && outbound) {
      const src = (el.getAttribute('src') ?? '').trim();
      if (!/^(https:|cid:)/i.test(src) && !SAFE_DATA_IMAGE.test(src)) el.removeAttribute('src');
    } else if (tag === 'img') {
      const src = (el.getAttribute('src') ?? '').trim();
      if (/^https?:\/\//i.test(src) && collector && collector.length < MAX_EXTERNAL_IMAGES) {
        el.setAttribute('data-mail-img', String(collector.length));
        collector.push(src);
        el.removeAttribute('src');
      } else if (/^cid:/i.test(src) || SAFE_DATA_IMAGE.test(src)) {
        // kept: inline attachment or embedded data image
      } else {
        el.removeAttribute('src');
      }
    }

    if (tag === 'a' || tag === 'area') {
      const href = (el.getAttribute('href') ?? '').trim();
      if (href && !/^(https?:|mailto:|tel:|#)/i.test(href)) el.removeAttribute('href');
      if (href && !href.startsWith('#')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    }
  });

  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) node.textContent = cleanCss(node.textContent);
  });
}

/** Plain text for search and previews, from already-sanitised HTML. */
export function htmlToText(html: string): string {
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'style', format: 'skip' },
    ],
  });
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * @param raw          Graph's `body.content`
 * @param contentType  Graph's `body.contentType` ('html' | 'text')
 */
export function sanitizeEmail(raw: string | null | undefined, contentType: string | null | undefined = 'html'): Sanitized {
  const source = raw ?? '';
  if ((contentType ?? '').toLowerCase() === 'text') {
    const text = source.length > MAX_TEXT ? source.slice(0, MAX_TEXT) : source;
    return {
      html: `<div style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</div>`,
      text,
      externalImages: [],
    };
  }

  installHooks();
  collector = [];
  try {
    const dom = DOMPurify.sanitize(source, {
      WHOLE_DOCUMENT: true,
      RETURN_DOM: true,
      FORBID_TAGS,
      FORBID_ATTR,
      ADD_TAGS: ['style'],
      ADD_ATTR: ['target'],
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    }) as unknown as HTMLElement;
    // Keep the head's <style> blocks (most newsletters put their layout there),
    // then the body. Everything else in <head> is gone.
    const doc = dom.ownerDocument;
    const styles = Array.from(doc.querySelectorAll('head style'))
      .map((s) => `<style>${s.textContent ?? ''}</style>`)
      .join('');
    const body = doc.body?.innerHTML ?? '';
    const html = styles + body;
    return { html, text: htmlToText(html), externalImages: collector };
  } finally {
    collector = null;
  }
}

/**
 * The person's own message on its way out (compose, signatures, templates).
 * Same active-content rules as inbound mail — nothing scripted, framed or
 * form-like reaches Outlook — but https images and links are kept as written.
 */
export function sanitizeOutgoing(raw: string | null | undefined): string {
  installHooks();
  outbound = true;
  try {
    return DOMPurify.sanitize(raw ?? '', {
      FORBID_TAGS,
      FORBID_ATTR,
      ADD_ATTR: ['target'],
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
    }) as unknown as string;
  } finally {
    outbound = false;
  }
}
