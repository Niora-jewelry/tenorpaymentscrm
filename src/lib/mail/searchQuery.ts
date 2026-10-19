/**
 * The person's search words → a Postgres tsquery string for `mail_search`.
 *
 * Every word is a PREFIX match and all words are required, so typing "inv
 * acme" finds "Invoice from Acme" — what people expect from a mail search
 * box, and what `websearch_to_tsquery` cannot do. Words are reduced to
 * letters, digits and the characters addresses use, so nothing typed can
 * become tsquery syntax (`&`, `|`, `!`, `:`, parentheses). The function in
 * the database still falls back to plain matching if a string slips through.
 *
 * Pure, unit-tested.
 */
const MAX_WORDS = 8;
const MAX_WORD = 64;

export function toPrefixTsquery(input: string): string | null {
  const words = input
    .normalize('NFKC')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}@._+-]/gu, '').replace(/^[._+@-]+|[._+@-]+$/g, '').toLowerCase())
    .filter((w) => w.length > 0)
    .slice(0, MAX_WORDS)
    .map((w) => w.slice(0, MAX_WORD));
  if (words.length === 0) return null;
  return [...new Set(words)].map((w) => `${w}:*`).join(' & ');
}
