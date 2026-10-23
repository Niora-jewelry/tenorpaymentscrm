/**
 * The list search's pure pieces, shared by the server page, the server-only
 * query module and the client search box. A `'use client'` module cannot
 * export a plain value to a server component (it arrives as a client
 * reference), which is why the limit lives here and not in SearchBox.
 */
/** The longest search the box accepts and the page honours. */
export const SEARCH_MAX = 120;


/** Escapes the three LIKE metacharacters so a search is a literal substring. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
