/**
 * Structural guards for the Admin → Presets area.
 *
 * These assert things about SOURCE TEXT rather than behaviour, which is
 * unusual enough to justify. The two rules they enforce — parse every action's
 * input, invalidate the config cache after every config write — both fail
 * *silently* when broken:
 *
 *   - A missed `revalidateConfig()` writes the row, returns success, leaves
 *     the database correct, and the change simply never appears in any
 *     module's dashboard or drawer. No error, nothing to notice in review.
 *   - A missing Zod parse is invisible until someone posts a hand-made
 *     request to what is, after all, a public HTTP endpoint.
 *
 * There is no runtime test that catches either without a live database and a
 * real browser. Presets is about to grow from 4 actions to roughly 20 across
 * sub-steps 2-5, so this checks every current AND future one automatically:
 * add `adminFields.ts` and a `FieldsSection` action tomorrow and these tests
 * start covering them with no edit here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const RECORDS_DIR = path.join(ROOT, 'src/lib/records');
const ADMIN_DIR = path.join(ROOT, 'src/app/(app)/admin');

/** The data modules that write `loadConfig()`-backed tables. Sub-steps 2-5
 * land here; a name that doesn't exist yet is skipped, not an error. */
const CONFIG_DATA_MODULES = [
  'adminPresets.ts',
  'adminFields.ts',
  'adminColumns.ts',
  'adminChoices.ts',
  'adminPipelines.ts',
];

/** A read is `list*`/`get*` by this codebase's own convention; everything else
 * exported from a config data module writes something. */
function isMutationName(name: string): boolean {
  return !/^(list|get)/.test(name);
}

function exportedFunctionNames(source: string): string[] {
  return [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]!);
}

/** Splits a module into its exported functions, body included, by cutting at
 * each `export` at column 0. Relies on this codebase's flat, one-level file
 * style — which is exactly what it is policing, so a file odd enough to break
 * it should be looked at by a human anyway. */
function exportedFunctionBodies(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /^export\s+(?:async\s+)?function\s+(\w+)/gm;
  const starts = [...source.matchAll(re)].map((m) => ({ name: m[1]!, index: m.index! }));
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1]!.index : source.length;
    out.push({ name: starts[i]!.name, body: source.slice(starts[i]!.index, end) });
  }
  return out;
}

/** Source with comments removed. Needed wherever an assertion would otherwise
 * match prose: `adminConfigCache.ts` documents the wrong call it used to make,
 * and that explanation has to stay readable without tripping the guard that
 * the call itself is gone. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function configMutationNames(): string[] {
  const names: string[] = [];
  for (const file of CONFIG_DATA_MODULES) {
    const full = path.join(RECORDS_DIR, file);
    if (!existsSync(full)) continue;
    names.push(...exportedFunctionNames(readFileSync(full, 'utf8')).filter(isMutationName));
  }
  return names;
}

/**
 * Every `actions.ts` under the real Admin Panel routes, with comments removed.
 *
 * Stripped for the same reason `adminConfigCache.ts` is: these assertions police
 * CODE, and the rules they police are ones this codebase explains at length in
 * prose right next to the call site. `templates/actions.ts` documents, in a
 * comment, that it must never call `revalidateConfig()` — which read as a call
 * to `revalidateConfig()` and failed the very test the comment exists to
 * explain. A guard that a correct explanation can break teaches people to stop
 * writing the explanation.
 *
 * Only top-level route directories are scanned (`admin/<route>/actions.ts`), so
 * an action tucked under a dynamic segment escapes every check here. That is why
 * Phase 6c's grant actions live in `templates/actions.ts` and `users/actions.ts`
 * and are passed down to the matrix as props, rather than sitting beside the
 * pages that use them.
 */
function adminActionFiles(): { route: string; source: string }[] {
  return readdirSync(ADMIN_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ route: e.name, file: path.join(ADMIN_DIR, e.name, 'actions.ts') }))
    .filter((e) => existsSync(e.file))
    .map((e) => ({ route: e.route, source: stripComments(readFileSync(e.file, 'utf8')) }));
}

describe('admin config cache invalidation', () => {
  const mutations = configMutationNames();

  it('finds the config mutations it is supposed to be guarding', () => {
    // A rename that silently empties this list would make every test below
    // vacuously pass — the failure mode of source-text tests.
    expect(mutations).toContain('createTab');
    expect(mutations).toContain('createSubtab');
    expect(mutations.length).toBeGreaterThanOrEqual(4);
  });

  it('every action that writes config calls revalidateConfig()', () => {
    const offenders: string[] = [];

    for (const { route, source } of adminActionFiles()) {
      for (const { name, body } of exportedFunctionBodies(source)) {
        const writesConfig = mutations.some((m) => new RegExp(`\\b${m}\\s*\\(`).test(body));
        if (!writesConfig) continue;
        if (!/\brevalidateConfig\s*\(/.test(body)) offenders.push(`${route}/actions.ts → ${name}`);
      }
    }

    expect(offenders, 'config write with no cache invalidation — the change will never appear in any module').toEqual([]);
  });

  it('no admin action hand-rolls revalidateTag for the config cache', () => {
    // Going through the helper is what keeps the tag string and the 'max'
    // profile in one place; a local copy is how those drift.
    const offenders = adminActionFiles()
      .filter(({ source }) => /revalidateTag\s*\(\s*['"]config['"]/.test(source))
      .map(({ route }) => `${route}/actions.ts`);

    expect(offenders, 'call revalidateConfig() instead of revalidateTag(\'config\', …)').toEqual([]);
  });

  it('the invalidator and the cache share one tag constant', () => {
    const cache = readFileSync(path.join(RECORDS_DIR, 'adminConfigCache.ts'), 'utf8');
    const config = readFileSync(path.join(RECORDS_DIR, 'config.ts'), 'utf8');

    expect(cache).toMatch(/updateTag\s*\(\s*CONFIG_CACHE_TAG\s*\)/);
    expect(config).toMatch(/tags:\s*\[\s*CONFIG_CACHE_TAG\s*\]/);
  });

  it('the invalidator expires the config tag immediately, not on a cacheLife profile', () => {
    // The bug this pins down shipped once already. `revalidateTag(tag,
    // profile)` expires on that profile's schedule — `'max'` is the LONGEST
    // one — so the write landed, the Presets screen showed it (that screen
    // queries `fields` directly and never touches this cache), and no module
    // drawer ever changed. Next's own JSDoc: "For immediate expiration in
    // Server Actions, use `updateTag` instead."
    const cache = stripComments(readFileSync(path.join(RECORDS_DIR, 'adminConfigCache.ts'), 'utf8'));
    const profiled = /revalidateTag\s*\(\s*CONFIG_CACHE_TAG\s*,/.test(cache);

    expect(profiled, 'revalidateTag with a cacheLife profile does not expire the config cache promptly — use updateTag()').toBe(false);
  });
});

/**
 * Phase 6a. The permission tables are NOT config: `permission_templates`,
 * `template_grants` and `user_grants` are absent from `loadConfig()`, and must
 * stay absent from any cache.
 *
 * So these two tests are deliberately mirror images of the ones above. The
 * parsing rule is the same rule — a public endpoint parses its input. The cache
 * rule is inverted: editing a template has to change every attached user's
 * effective grant on their NEXT request, with no push step
 * (`CLIENT-SPEC-BY-MODULE.md` §8, `effective_grant()` reading `template_grants`
 * at call time). The reflex in this codebase is now to call `revalidateConfig()`
 * after every admin write; copying it here would cache a permission decision,
 * and a stale permission looks exactly like a correct one.
 *
 * `adminUsers.ts` joined the list in Phase 6c, which is what caught its actions
 * still reading `FormData` with raw `String(...)` casts — the §6 gap Phase 0
 * closed for Presets and nobody had closed here, on endpoints that pause an
 * account and reassign a permission template.
 */
const TEMPLATE_DATA_MODULES = ['adminTemplates.ts', 'adminGrants.ts', 'adminUsers.ts', 'adminVisibility.ts'];

function templateMutationNames(): string[] {
  const names: string[] = [];
  for (const file of TEMPLATE_DATA_MODULES) {
    const full = path.join(RECORDS_DIR, file);
    if (!existsSync(full)) continue;
    names.push(...exportedFunctionNames(readFileSync(full, 'utf8')).filter(isMutationName));
  }
  return names;
}

describe('permission templates are never cached', () => {
  const mutations = templateMutationNames();

  it('finds the template mutations it is supposed to be guarding', () => {
    expect(mutations).toContain('createTemplate');
    expect(mutations).toContain('renameTemplate');
    // Phase 6c's four writers, and the one that destroys what they write.
    expect(mutations).toContain('setTemplateGrant');
    expect(mutations).toContain('clearTemplateGrant');
    expect(mutations).toContain('setUserGrant');
    expect(mutations).toContain('clearUserGrant');
    expect(mutations).toContain('assignTemplate');
    // `record_visibility_grants` — a DIFFERENT permission from the four above
    // (row visibility, enforced inside `can_see_record()`'s RLS predicate,
    // rather than Hidden/View/Edit resolved in the app layer), and covered by
    // the same two rules: parse the input, never cache the answer.
    expect(mutations).toContain('grantRecordVisibility');
    expect(mutations).toContain('revokeRecordVisibility');
  });

  it('no action that writes a permission template calls revalidateConfig()', () => {
    const offenders: string[] = [];

    for (const { route, source } of adminActionFiles()) {
      for (const { name, body } of exportedFunctionBodies(source)) {
        const writesTemplates = mutations.some((m) => new RegExp(`\\b${m}\\s*\\(`).test(body));
        if (!writesTemplates) continue;
        if (/\brevalidateConfig\s*\(/.test(body)) offenders.push(`${route}/actions.ts → ${name}`);
      }
    }

    expect(
      offenders,
      'permissions must resolve live — caching them breaks the client\'s no-push-step requirement, silently',
    ).toEqual([]);
  });

  it('every action that writes a permission template parses its input with Zod', () => {
    const offenders: string[] = [];

    for (const { route, source } of adminActionFiles()) {
      for (const { name, body } of exportedFunctionBodies(source)) {
        const writesTemplates = mutations.some((m) => new RegExp(`\\b${m}\\s*\\(`).test(body));
        if (!writesTemplates) continue;
        if (!/\.(safeParse|parse)\s*\(/.test(body)) offenders.push(`${route}/actions.ts → ${name}`);
      }
    }

    expect(offenders, 'server action with unvalidated input — CLAUDE.md §6').toEqual([]);
  });

  it('the template data modules are not listed as config modules', () => {
    // The two lists must stay disjoint: a name in both would be asserted to
    // call revalidateConfig() and to never call it, and the second test to run
    // would simply fail with no explanation of why.
    for (const file of TEMPLATE_DATA_MODULES) expect(CONFIG_DATA_MODULES).not.toContain(file);
  });
});

describe('admin config action input parsing', () => {
  const mutations = configMutationNames();

  it('every action that writes config parses its input with Zod', () => {
    const offenders: string[] = [];

    for (const { route, source } of adminActionFiles()) {
      for (const { name, body } of exportedFunctionBodies(source)) {
        const writesConfig = mutations.some((m) => new RegExp(`\\b${m}\\s*\\(`).test(body));
        if (!writesConfig) continue;
        if (!/\.(safeParse|parse)\s*\(/.test(body)) offenders.push(`${route}/actions.ts → ${name}`);
      }
    }

    expect(offenders, 'server action with unvalidated input — CLAUDE.md §6').toEqual([]);
  });
});
