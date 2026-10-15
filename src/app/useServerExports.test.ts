/**
 * A `'use server'` file may export async functions and types — nothing else.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * `[module]/actions.ts` once exported a plain `Set` alongside its actions.
 * TypeScript was happy, ESLint was happy, every unit test passed, and the
 * build succeeded. Then every Server Action on the page returned 500 in the
 * browser, because Next refuses a non-function export from a server module at
 * RUNTIME, not at compile time. It was found by clicking, not by any check.
 *
 * Next does catch a non-async `export function` at build. What it does not
 * catch is a value — `export const X = new Set(...)`, `export const N = 5`,
 * `export { thing }` — which is exactly the shape that broke. So that is what
 * this looks for.
 *
 * Source-level and crude on purpose: it cannot be fooled by a mock, it runs in
 * milliseconds, and it fails for one reason.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/**
 * True when the file's first statement is the directive, as Next requires.
 *
 * A linear scan, not one regex. `^(?:\s|//…|/\*…\*\/)*'use server'` looks
 * equivalent and backtracks catastrophically on any file that opens with a
 * long comment and is NOT a server module — this codebase's normal case — and
 * hung the test run for ten minutes before it was replaced.
 */
function isServerModule(source: string): boolean {
  let i = 0;
  for (;;) {
    while (i < source.length && /\s/.test(source[i]!)) i += 1;
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      if (end === -1) return false;
      i = end + 1;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 2;
    } else {
      return source.startsWith("'use server'", i) || source.startsWith('"use server"', i);
    }
  }
}

const serverFiles = sourceFiles(SRC).filter((f) => isServerModule(readFileSync(f, 'utf8')));

describe("'use server' modules", () => {
  it('finds the server modules — a rename must not make this vacuously green', () => {
    expect(serverFiles.length).toBeGreaterThanOrEqual(10);
  });

  it('export nothing but async functions and types', () => {
    const offenders: string[] = [];
    for (const file of serverFiles) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const t = line.trim();
        if (!t.startsWith('export ')) return;
        const allowed =
          /^export\s+async\s+function\b/.test(t) ||
          /^export\s+(type|interface)\b/.test(t) ||
          /^export\s+(const|let)\s+\w+\s*(:[^=]+)?=\s*async\b/.test(t);
        if (!allowed) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${t.slice(0, 80)}`);
      });
    }
    expect(
      offenders,
      `These exports would 500 every Server Action in the file at runtime — move them to a plain module:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
