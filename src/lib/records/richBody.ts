/**
 * An Update's body between the editor and the database.
 *
 * What people see while writing is real formatting (client, 6 Nov 2026: bold and
 * italic "do not work properly", a bullet "should not say the word item"). What is
 * stored stays the plain text with markers that `richText.tsx` renders, for the
 * reasons given there: mentions, excerpts and the audit trail all read that text.
 * So the editor's document is turned into that text on the way out, and back on
 * the way in. Pure, so both directions are tested without a browser.
 */

export type RichMark = { type: string; attrs?: { href?: string | null } };
export type RichNode = { type: string; text?: string; marks?: RichMark[]; content?: RichNode[]; attrs?: Record<string, unknown> };

/** Outermost first. A link keeps emphasis inside its label out: `**[a](b)**`. */
const ORDER = ['bold', 'italic', 'link', 'code'];
const MARKER: Record<string, string> = { bold: '**', italic: '*', code: '`' };

const known = (marks: RichMark[] | undefined): RichMark[] =>
  (marks ?? []).filter((m) => ORDER.includes(m.type)).sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));

const sameMark = (a: RichMark, b: RichMark) => a.type === b.type && (a.attrs?.href ?? null) === (b.attrs?.href ?? null);

const closing = (m: RichMark) => (m.type === 'link' ? `](${m.attrs?.href ?? ''})` : MARKER[m.type]!);
const opening = (m: RichMark) => (m.type === 'link' ? '[' : MARKER[m.type]!);

/** Marks stay open across neighbouring pieces, or bold next to bold-italic would
 *  come out as `**a****b**`. */
function inlineText(nodes: RichNode[] = []): string {
  let out = '';
  let open: RichMark[] = [];
  const closeDownTo = (keep: number) => {
    while (open.length > keep) out += closing(open.pop()!);
  };
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      closeDownTo(0);
      out += '\n';
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const want = known(n.marks);
    // A link whose label is its address is a bare link.
    const bare = want.length === 1 && want[0]!.type === 'link' && want[0]!.attrs?.href === n.text;
    const marks = bare ? [] : want;
    let keep = 0;
    while (keep < open.length && keep < marks.length && sameMark(open[keep]!, marks[keep]!)) keep++;
    closeDownTo(keep);
    for (const m of marks.slice(keep)) {
      out += opening(m);
      open.push(m);
    }
    out += n.text;
  }
  closeDownTo(0);
  open = [];
  return out;
}

const prefixed = (text: string, first: string, rest: string) =>
  text
    .split('\n')
    .map((l, i) => `${i === 0 ? first : rest}${l}`)
    .join('\n');

function block(n: RichNode): string {
  switch (n.type) {
    case 'paragraph':
      return inlineText(n.content);
    case 'bulletList':
      return (n.content ?? []).map((li) => prefixed(blocks(li.content), '- ', '  ')).join('\n');
    case 'orderedList':
      return (n.content ?? []).map((li, i) => prefixed(blocks(li.content), `${i + 1}. `, '   ')).join('\n');
    case 'blockquote':
      return prefixed(blocks(n.content), '> ', '> ');
    default:
      return inlineText(n.content);
  }
}

const blocks = (nodes: RichNode[] = []): string => nodes.map(block).join('\n');

/** The editor's document as the stored text. */
export function docToBody(doc: RichNode): string {
  return blocks(doc.content).replace(/\s+$/, '');
}

const INLINE = /\*\*\*([^*\n]+)\*\*\*|\*\*((?:[^*\n]|\*[^*\n]+\*)+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inlineNodes(text: string, marks: RichMark[] = []): RichNode[] {
  const out: RichNode[] = [];
  const push = (t: string) => {
    if (t) out.push(marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
  };
  let last = 0;
  for (const m of text.matchAll(new RegExp(INLINE))) {
    const at = m.index ?? 0;
    push(text.slice(last, at));
    const [, both, bold, italic, code, label, href] = m;
    if (both) out.push(...inlineNodes(both, [...marks, { type: 'bold' }, { type: 'italic' }]));
    else if (bold) out.push(...inlineNodes(bold, [...marks, { type: 'bold' }]));
    else if (italic) out.push(...inlineNodes(italic, [...marks, { type: 'italic' }]));
    else if (code) out.push({ type: 'text', text: code, marks: [{ type: 'code' }] });
    else if (label) out.push(...inlineNodes(label, [...marks, { type: 'link', attrs: { href } }]));
    last = at + m[0].length;
  }
  push(text.slice(last));
  return out;
}

const paragraph = (text: string): RichNode => {
  const content = inlineNodes(text);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBER = /^\s*\d{1,3}[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** The stored text as the editor's document, for editing a post. */
export function bodyToDoc(body: string): RichNode {
  const content: RichNode[] = [];
  const lastIs = (type: string) => content[content.length - 1]?.type === type;
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const b = BULLET.exec(line);
    const n = b ? null : NUMBER.exec(line);
    const q = b || n ? null : QUOTE.exec(line);
    if (b || n) {
      const type = b ? 'bulletList' : 'orderedList';
      if (!lastIs(type)) content.push({ type, content: [] });
      content[content.length - 1]!.content!.push({ type: 'listItem', content: [paragraph((b ?? n)![1] ?? '')] });
    } else if (q) {
      if (!lastIs('blockquote')) content.push({ type: 'blockquote', content: [] });
      content[content.length - 1]!.content!.push(paragraph(q[1] ?? ''));
    } else {
      content.push(paragraph(line));
    }
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** What a person typed as a link, as an address. */
export function linkAddress(typed: string): string {
  const v = typed.trim();
  return /^(https?:|mailto:)/i.test(v) ? v : `https://${v}`;
}
