import { describe, expect, it } from 'vitest';
import { bodyToDoc, docToBody, linkAddress, type RichNode } from './richBody';

const t = (text: string, ...marks: string[]): RichNode => ({ type: 'text', text, marks: marks.map((type) => ({ type })) });
const p = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content });
const doc = (...content: RichNode[]): RichNode => ({ type: 'doc', content });
const link = (text: string, href: string): RichNode => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });

describe('docToBody', () => {
  it('writes the markers the renderer reads', () => {
    expect(docToBody(doc(p(t('a '), t('b', 'bold'), t(' '), t('c', 'italic'), t(' '), t('d', 'code'))))).toBe('a **b** *c* `d`');
  });

  it('keeps a mark open across neighbouring pieces', () => {
    // The client's own case: bold running into bold italic.
    expect(docToBody(doc(p(t('one', 'bold'), t('two', 'bold', 'italic'))))).toBe('**one*two***');
  });

  it('writes links, and a bare address as itself', () => {
    expect(docToBody(doc(p(link('test', 'https://google.com'))))).toBe('[test](https://google.com)');
    expect(docToBody(doc(p(link('https://a.co', 'https://a.co'))))).toBe('https://a.co');
  });

  it('writes lists and quotes with no placeholder word', () => {
    const li = (text: string): RichNode => ({ type: 'listItem', content: [p(t(text))] });
    expect(docToBody(doc({ type: 'bulletList', content: [li('a'), li('b')] }))).toBe('- a\n- b');
    expect(docToBody(doc({ type: 'orderedList', content: [li('a'), li('b')] }))).toBe('1. a\n2. b');
    expect(docToBody(doc({ type: 'blockquote', content: [p(t('a')), p(t('b'))] }))).toBe('> a\n> b');
  });

  it('keeps a mention as text, so it still notifies', () => {
    expect(docToBody(doc(p(t('@Izzy Hershko', 'bold'), t(' please call'))))).toBe('**@Izzy Hershko** please call');
  });

  it('gives nothing for an empty editor', () => {
    expect(docToBody(doc({ type: 'paragraph' }))).toBe('');
  });
});

describe('bodyToDoc', () => {
  const round = (s: string) => docToBody(bodyToDoc(s));

  it.each([
    'plain text',
    'a **b** *c* `d`',
    '**one*two***',
    '[test](https://google.com)',
    '- a\n- b',
    '1. a\n2. b',
    '> a\n> b',
    'first line\nsecond line',
    'before\n- a\n- b\nafter',
  ])('survives a round trip: %s', (s) => {
    expect(round(s)).toBe(s);
  });

  it('reads bold italic as both', () => {
    const [node] = bodyToDoc('***x***').content![0]!.content!;
    expect(node!.marks!.map((m) => m.type)).toEqual(['bold', 'italic']);
  });
});

describe('linkAddress', () => {
  it('adds the scheme a person leaves off', () => {
    expect(linkAddress(' google.com ')).toBe('https://google.com');
    expect(linkAddress('http://a.co')).toBe('http://a.co');
    expect(linkAddress('mailto:a@b.co')).toBe('mailto:a@b.co');
  });
});
