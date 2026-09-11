/**
 * A read-only field may never be written through a value path.
 *
 * ── WHY THIS NEEDED A TEST THE DAY THE TABLE BECAME EDITABLE ─────────────
 * `readOnly` was on `setValue`'s field argument from the start and nothing ever
 * read it. That survived only because the drawer was the single way in and it
 * rendered those fields with a View control — which is UI-level hiding, and the
 * client's own spec says in as many words that UI-level hiding is never the
 * security boundary.
 *
 * Inline editing in the dashboard widens the surface, so the check moved into
 * the data layer where every caller passes through it. These assertions pin the
 * source of that guard rather than its behaviour at runtime: `setValue` needs a
 * database and an authorised context, and what actually has to stay true is
 * structural — the guard exists, and it runs BEFORE the permission chain, so a
 * read-only field is refused whether or not the caller is an admin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const source = readFileSync(path.join(__dirname, 'records.ts'), 'utf8');

/** One exported function's body, cut at the next `export` at column 0. */
function bodyOf(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found — did it get renamed?`).toBeGreaterThan(-1);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('read-only fields', () => {
  it('has a single guard, and it throws', () => {
    expect(source).toContain('function assertWritable(');
    const guard = source.slice(source.indexOf('function assertWritable('));
    expect(guard.slice(0, 260)).toContain('field.readOnly');
    expect(guard.slice(0, 260)).toContain('throw new Error');
  });

  it('setValue refuses a read-only field', () => {
    expect(bodyOf('setValue')).toContain('assertWritable(field)');
  });

  it('setValues refuses a read-only field', () => {
    expect(bodyOf('setValues')).toContain('assertWritable(field)');
  });

  it('checks writability BEFORE the permission chain', () => {
    // An admin passes every grant check, so a guard placed after them would be
    // skipped for exactly the person most able to do damage with it.
    const body = bodyOf('setValue');
    const guardAt = body.indexOf('assertWritable(field)');
    const grantAt = body.indexOf('capGrant(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(grantAt);
  });

  it('setValues checks the whole batch before writing any of it', () => {
    // A batch touching one read-only field must be refused entirely, not
    // applied up to the offending entry — a half-applied batch is the silent
    // partial write CLAUDE.md rule 2 exists to prevent.
    const body = bodyOf('setValues');
    const guardAt = body.indexOf('assertWritable(field)');
    const writeAt = body.indexOf('set_record_values');
    expect(guardAt).toBeLessThan(writeAt);
  });
});
