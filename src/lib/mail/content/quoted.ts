/**
 * Splits a message body into what is NEW and the quoted history below it, so
 * a reply shows its own words with a "Show quoted text" toggle instead of
 * the whole thread pasted underneath, like Outlook does.
 *
 * Ported from the old CRM's `quoted-history.ts`. The old one had to run on
 * RAW html because its sanitizer stripped ids and styles; ours keeps both, so
 * this runs on the stored, already-safe HTML.
 *
 * Conservative on purpose: only high-confidence structural markers split a
 * body, the "On <date> … wrote:" text pattern is NOT one of them (too many
 * false positives), and when either side would be empty nothing is hidden.
 * Never hide content we are unsure about.
 *
 * Pure, unit-tested.
 */
export type QuotedSplit = { main: string; quoted: string | null };

//  id="appendonsend"   Outlook web/desktop wraps the appended history in it
//  id="divRplyFwdMsg"  Outlook desktop's reply/forward header
//  class="gmail_quote" Gmail's history wrapper
//  border-top:solid    Outlook's reply divider rule
const ID_MARKERS = /id=["'](?:appendonsend|divRplyFwdMsg)["']/i;
const GMAIL = /class=["'][^"']*\bgmail_quote\b/i;
const BORDER_DIVIDER = /border-top:\s*solid/i;

export function hasVisibleText(html: string): boolean {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, '').length > 0;
}

export function splitQuotedHtml(raw: string | null | undefined): QuotedSplit {
  const html = raw ?? '';
  if (!html) return { main: html, quoted: null };
  const lower = html.toLowerCase();
  const candidates: number[] = [];

  for (const re of [ID_MARKERS, GMAIL, BORDER_DIVIDER]) {
    const at = html.search(re);
    if (at === -1) continue;
    const start = lower.lastIndexOf('<div', at);
    if (start !== -1) candidates.push(start);
  }
  const blockquote = lower.indexOf('<blockquote');
  if (blockquote !== -1) candidates.push(blockquote);
  if (candidates.length === 0) return { main: html, quoted: null };

  const boundary = Math.min(...candidates);
  if (boundary <= 0) return { main: html, quoted: null };
  const main = html.slice(0, boundary);
  const quoted = html.slice(boundary);
  if (!hasVisibleText(main) || !hasVisibleText(quoted)) return { main: html, quoted: null };
  return { main, quoted };
}
