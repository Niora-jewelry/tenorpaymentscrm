/**
 * The document a sanitised email body is shown in — the `srcdoc` of the
 * reading pane's sandboxed iframe.
 *
 * Second layer of defence after the ingest sanitiser: the frame is sandboxed
 * WITHOUT allow-scripts, and the document carries its own CSP — nothing
 * loads but our own origin (attachment and image-proxy routes) and data:
 * images. A remote URL that somehow survived sanitising still could not load.
 *
 *   cid:…           → /api/mail/inline/<message>?cid=…   (inline attachments)
 *   data-mail-img=n → /api/mail/image?m=<message>&n=n    (only after "Load images")
 *
 * Pure, unit-tested. Never put anything here that runs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const decodeAttr = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export function rewriteForFrame(html: string, messageId: string, loadImages: boolean): string {
  if (!UUID.test(messageId)) throw new Error('messageId must be a uuid');
  let out = html.replace(/src="cid:([^"]*)"/gi, (_m, cid: string) => `src="/api/mail/inline/${messageId}?cid=${encodeURIComponent(decodeAttr(cid))}"`);
  if (loadImages) {
    out = out.replace(/data-mail-img="(\d{1,3})"/g, (_m, n: string) => `data-mail-img="${n}" src="/api/mail/image?m=${messageId}&amp;n=${n}"`);
  }
  return out;
}

const FRAME_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:";

/** House typography for mail that brings none of its own; mail that does keeps it. */
const BASE_CSS = [
  'html,body{margin:0;padding:0;background:#fff}',
  "body{font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#08202f;overflow-wrap:anywhere;word-break:break-word}",
  'img{max-width:100%;height:auto}',
  // A blocked image keeps the size the sender declared, as a quiet tile;
  // a blocked 1×1 tracking pixel is not worth a tile at all.
  'img[data-mail-img]:not([src]){background:#eef3f7;border-radius:3px}',
  'img[data-mail-img]:not([src])[width="1"],img[data-mail-img]:not([src])[height="1"],img[data-mail-img]:not([src])[width="0"],img[data-mail-img]:not([src])[height="0"]{display:none}',
  'table{max-width:100%}',
  'pre{white-space:pre-wrap}',
  'a{color:#1d4ed8}',
  'blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #d9e3ec;color:#4a6a80}',
  'p{margin:0 0 .75em}',
].join('');

export function frameDocument(bodyHtml: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<base target="_blank">' +
    `<style>${BASE_CSS}</style>` +
    `</head><body>${bodyHtml}</body></html>`
  );
}
