/**
 * Every design-token colour class used in the app must actually be defined.
 *
 * ── THE FAILURE THIS CATCHES IS INVISIBLE ────────────────────────────────
 * Tailwind emits nothing at all for a colour class whose token does not exist.
 * There is no build error and no console warning: the class lands in the
 * markup, matches no rule, and the element quietly inherits its parent's
 * colour.
 *
 * On a white page that is a shade off and nobody ever notices. Inside the
 * navigation rail, whose root sets `text-white`, it is fatal — `text-ink-600`
 * (a token that was never defined, used in four places) rendered white text on
 * the white notification panel, so the list showed timestamps under blank rows
 * and looked broken. `brand-200`, `brand-400` and `ink-800` were in the same
 * state and had simply not been noticed yet.
 *
 * A token ramp with gaps invites this every time somebody reaches for the
 * shade between two that exist. This test is the guard rail: add the class,
 * add the token, or the build fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const CSS = path.join(SRC, 'app/globals.css');

/** Token families that carry a numeric ramp and are therefore easy to outrun. */
const RAMPED = ['ink', 'brand'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const css = readFileSync(CSS, 'utf8');
const defined = new Set(
  [...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
);

describe('design tokens', () => {
  it('defines every ramped shade the source refers to', () => {
    const missing = new Map<string, string[]>();

    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const family of RAMPED) {
        // `text-ink-600`, `hover:border-brand-400`, `bg-brand-50/60` — the
        // utility prefix and any alpha suffix are both ignored; the token name
        // is what has to exist.
        const re = new RegExp(`-(${family}-\\d{2,3})\\b`, 'g');
        for (const m of source.matchAll(re)) {
          const token = m[1]!;
          if (defined.has(token)) continue;
          const list = missing.get(token) ?? [];
          const rel = path.relative(ROOT, file);
          if (!list.includes(rel)) list.push(rel);
          missing.set(token, list);
        }
      }
    }

    expect(
      Object.fromEntries(missing),
      'colour classes with no --color-* token: Tailwind emits nothing for these '
        + 'and the element silently inherits its parent colour',
    ).toEqual({});
  });

  it('knows what a defined token looks like, so the test above cannot pass vacuously', () => {
    // If the parser ever stops finding tokens, every lookup would "succeed"
    // against an empty set and this suite would guard nothing.
    expect(defined.has('ink-900')).toBe(true);
    expect(defined.has('brand-600')).toBe(true);
    expect(defined.size).toBeGreaterThan(15);
  });

  it('has no gaps in the ink and brand ramps', () => {
    // A gap is what invites the bug: somebody reaches for the shade between two
    // that exist, gets no rule, and sees no error.
    for (const family of RAMPED) {
      const shades = [...defined]
        .filter((t) => t.startsWith(`${family}-`))
        .map((t) => Number(t.slice(family.length + 1)))
        .filter((n) => Number.isFinite(n) && n >= 100)
        .sort((a, b) => a - b);

      for (let i = 1; i < shades.length; i++) {
        const gap = shades[i]! - shades[i - 1]!;
        expect(
          gap,
          `${family}: ${shades[i - 1]} jumps to ${shades[i]}. Fill the gap or the next `
            + 'person reaching for the middle shade gets a class that renders nothing.',
        ).toBeLessThanOrEqual(100);
      }
    }
  });
});
