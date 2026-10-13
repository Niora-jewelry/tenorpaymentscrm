/**
 * Every Server Action under Admin → Residuals must refuse a non-admin.
 *
 * ── WHY A SOURCE-LEVEL TEST, AND NOT A CALLING ONE ───────────────────────
 * These actions are `'use server'` modules that reach for cookies, a Supabase
 * client and `loadConfig()` the moment they are imported, so calling one from
 * a unit test means standing up most of the request pipeline. What actually
 * needs guarding is simpler and more easily lost: that a NEW action added to
 * one of these files does not forget the check its twenty siblings all make.
 *
 * So this reads the files. It is crude on purpose — it cannot be fooled by a
 * mock, it costs nothing, and it fails for exactly one reason.
 *
 * ── THIS IS NOT THE SECURITY BOUNDARY, AND SAYS SO ───────────────────────
 * The boundary is the database: RLS on all 27 `residual_*` tables plus the
 * SECURITY DEFINER functions, which is what `residuals.rls.integration.test.ts`
 * asserts. This file guards the LAYER ABOVE — the one that turns a refusal
 * into a sentence on screen instead of a 500. Both matter, and neither is a
 * substitute for the other: without the database check a missed guard is a
 * breach, and without this one it is an error page.
 *
 * Residuals is the money path. "Admin only" is the whole access rule for it —
 * there is no per-module grant that opens it to anyone else.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src', 'app', '(app)', 'admin', 'residuals');

/** Every `*.ts` under the residuals admin route, including `[periodId]/`. */
function actionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...actionFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/**
 * The exported async functions in one file, each with the body that follows
 * it up to the next export. Good enough to ask "does this function mention
 * the check", which is the only question here.
 */
function exportedActions(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export async function (\w+)\s*\(/g;
  const starts: { name: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => {
    out.push({ name: s.name, body: source.slice(s.at, starts[i + 1]?.at ?? source.length) });
  });
  return out;
}

const files = actionFiles(ROOT).filter((f) => /action/i.test(f));

describe('Admin → Residuals server actions', () => {
  it('has action files to check', () => {
    // A rename that moved them all would otherwise make this suite vacuously
    // green — the failure mode a test like this is most prone to.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it('every exported action refuses a non-admin', () => {
    const missing: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const { name, body } of exportedActions(source)) {
        if (!name.endsWith('Action')) continue;
        const guards = /ctx\.isAdmin|assertAdmin|requireSuperAdmin/.test(body);
        if (!guards) missing.push(`${file.slice(file.indexOf('residuals'))} → ${name}`);
      }
    }
    expect(
      missing,
      `These residuals actions do not check that the caller is an admin:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every exported action is authorised before it acts', () => {
    /*
     * `authorize()` is what produces the `ctx` the check above reads. An
     * action that tested `ctx.isAdmin` against a context it never built would
     * not compile, but one that calls a service function BEFORE authorising
     * would — so the call has to come first in the body.
     */
    const wrong: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const { name, body } of exportedActions(source)) {
        if (!name.endsWith('Action')) continue;
        const authorisedAt = body.search(/await authorize\(/);
        const checkedAt = body.search(/ctx\.isAdmin|assertAdmin/);
        if (authorisedAt === -1 || checkedAt === -1) continue; // reported above
        if (checkedAt < authorisedAt) wrong.push(`${name} checks isAdmin before authorize()`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
