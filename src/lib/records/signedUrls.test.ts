/**
 * A download link is minted for a FILE ID, never for a path the caller chose.
 *
 * ── THE HOLE THIS PINS ───────────────────────────────────────────────────
 * `signedUrlFor` and `signedStatementUrlFor` each took a `storagePath`
 * straight from the browser and signed it. Both marked their context `_ctx`,
 * because neither read it — the only check left anywhere in the path was the
 * bucket's RLS policy, and that policy asked `can_see_record()` and nothing
 * else.
 *
 * So the Files, Cases and Statements tab grants governed the list and not the
 * bytes: a viewer holding Statements = Hidden on a record they could otherwise
 * see still got a working 60-second link to every statement on it. Confirmed
 * against the live database before the fix — one seeded non-admin resolved to
 * `storage_tab_access(...,'statements') = 'hidden'` while six statement objects
 * sat inside `can_see_record()`.
 *
 * Two things had to change together, and this file pins the application half:
 * the argument is an id, and the tab grant is consulted before anything is
 * signed. Migration 67 is the other half, in the bucket's own policies.
 *
 * Structural assertions on the source, for the same reason
 * `readOnlyFields.test.ts` uses them: reaching these functions at runtime needs
 * a database, a signed-in viewer and a real storage object, while what must
 * stay true is simply that the guard is there and runs BEFORE the URL is made.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function bodyOf(file: string, name: string): string {
  const source = readFileSync(path.join(__dirname, file), 'utf8');
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found in ${file} — did it get renamed?`).toBeGreaterThan(-1);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('signed download URLs', () => {
  it('files: takes an id, not a caller-supplied storage path', () => {
    const body = bodyOf('files.ts', 'signedUrlFor');
    expect(body).toContain('fileId: string');
    expect(body).not.toContain('storagePath: string');
  });

  it('statements: takes an id, not a caller-supplied storage path', () => {
    const body = bodyOf('statements.ts', 'signedStatementUrlFor');
    expect(body).toContain('statementFileId: string');
    expect(body).not.toContain('storagePath: string');
  });

  it('files: checks the tab grant BEFORE signing anything', () => {
    const body = bodyOf('files.ts', 'signedUrlFor');
    const guard = body.indexOf('requireTabView(');
    const sign = body.indexOf('createSignedUrl(');
    expect(guard).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sign);
  });

  it('statements: checks the tab grant BEFORE signing anything', () => {
    const body = bodyOf('statements.ts', 'signedStatementUrlFor');
    const guard = body.indexOf('requireTabView(');
    const sign = body.indexOf('createSignedUrl(');
    expect(guard).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sign);
  });

  it('files: a case attachment is governed by Cases, not Files', () => {
    // An attachment is an ordinary `files` row, so the row's own kind has to
    // pick the tab — the same split `uploadFile` makes. Getting this wrong
    // would let the Files grant decide who reads case attachments, which is a
    // different question with a different answer.
    const body = bodyOf('files.ts', 'signedUrlFor');
    expect(body).toContain("'cases'");
    expect(body).toContain("startsWith('case')");
  });

  it('neither function still ignores its context', () => {
    // `_ctx` was the visible symptom for as long as the hole existed: a
    // permission argument accepted and never read.
    expect(bodyOf('files.ts', 'signedUrlFor')).not.toContain('_ctx');
    expect(bodyOf('statements.ts', 'signedStatementUrlFor')).not.toContain('_ctx');
  });
});
