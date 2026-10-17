/**
 * Source-level rules for the Email module that no type checker enforces.
 *
 *   1. No `console.*` outside `log.ts`. Every log line goes through
 *      `mailLog`, which redacts secrets and drops mail content. A stray
 *      `console.error(err)` on a Graph failure would print a bearer token or
 *      a subject line into Vercel's logs.
 *   2. No `dangerouslySetInnerHTML` anywhere in the module. Email HTML is
 *      rendered ONLY in the sandboxed srcdoc iframe; nothing else may inject
 *      markup into the CRM's own document.
 *   3. Any `srcdoc` iframe is sandboxed without `allow-scripts`.
 *
 * Reads files rather than importing them, so it holds for code not yet
 * reached by any other test.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DIRS = ['src/lib/mail', 'src/app/api/mail', 'src/app/(app)/email'].map((d) => path.join(ROOT, d));

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const all = DIRS.flatMap(files);
const rel = (f: string) => path.relative(ROOT, f).replaceAll('\\', '/');

describe('Email module source guards', () => {
  it('finds the module (so the checks below are not vacuous)', () => {
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it('logs only through mailLog', () => {
    const offenders = all
      .filter((f) => !f.endsWith(path.join('mail', 'log.ts')))
      .filter((f) => /\bconsole\.(log|info|warn|error|debug)\s*\(/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('never uses dangerouslySetInnerHTML', () => {
    const offenders = all.filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML')).map(rel);
    expect(offenders).toEqual([]);
  });

  it('sandboxes every srcdoc iframe, never with allow-scripts', () => {
    for (const f of all) {
      const src = readFileSync(f, 'utf8');
      if (!/\bsrcDoc\b|\bsrcdoc\b/.test(src)) continue;
      expect(src, `${rel(f)} renders srcdoc without a sandbox`).toMatch(/sandbox=/);
      expect(src, `${rel(f)} allows scripts in the email frame`).not.toMatch(/allow-scripts/);
    }
  });
});
