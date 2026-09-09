/**
 * Phase 6b — proves the grant matrix's resolution against the real
 * `effective_grant()`, over every real scope in the live database.
 *
 * WHY THIS EXISTS. The matrix cannot call `effective_grant()` per cell: the
 * function takes one scope and the tree has ~148 of them, so one page load
 * would be 148 RPCs. It resolves in TypeScript instead, with `coalesceGrant()`
 * — *"user override, else template, else edit"*. That is an assumption about
 * what the database does, and `remaining-plan.md` § 6b asks for it to be
 * checked against the function rather than against the screen's own model.
 *
 * So this script asserts the property the TypeScript relies on, in SQL, against
 * the live function: for every module, tab and field, `effective_grant()`
 * equals `coalesce(user_grants.grant_level, template_grants.grant_level,
 * 'edit')` read straight from the tables. It does not re-implement the app's
 * logic — that would only prove the copy agrees with itself.
 *
 * It also exercises the case a screen full of blanks depends on: a scope with
 * NO row anywhere must come back `edit`, not `hidden`. One planning document
 * still says default-deny (`MODULE-2-PLAN.md:324`); the database does not.
 *
 * Everything is written inside BEGIN/ROLLBACK. The temporary template, grants
 * and overrides are visible to `effective_grant()` within the transaction
 * (same connection, uncommitted), and nothing survives the script.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-grant-matrix.mjs
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) { console.error('Set SUPABASE_DB_URL first.'); process.exit(1); }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
let pass = 0, fail = 0;

function ok(label, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  - ${label}`); }
  else { fail++; console.log(`  FAIL - ${label} ${extra}`); }
}

/** Every scope the matrix renders, in the same three kinds the enum allows. */
const ALL_SCOPES = `
  select 'module'::grant_scope as kind, id from modules
  union all
  select 'tab'::grant_scope, id from tabs
  union all
  select 'field'::grant_scope, id from fields where archived_at is null
`;

async function main() {
  await client.connect();
  await client.query('BEGIN');
  try {
    const { rows: [user] } = await client.query(
      `select id, email from profiles where deleted_at is null order by created_at limit 1`,
    );
    ok('found a profile to resolve grants for', Boolean(user));
    const userId = user.id;

    const { rows: [counts] } = await client.query(`select count(*)::int n from (${ALL_SCOPES}) s`);
    ok(`the scope tree is non-trivial (${counts.n} scopes)`, counts.n > 100, `got ${counts.n}`);

    /* ---------------------------------------------------------------------
     * 1. The empty case — nothing configured anywhere.
     * ------------------------------------------------------------------- */
    await client.query(`delete from user_grants where user_id = $1`, [userId]);
    await client.query(`delete from user_templates where user_id = $1`, [userId]);

    const { rows: [empty] } = await client.query(
      `select count(*) filter (where effective_grant($1, s.kind, s.id) <> 'edit')::int bad,
              count(*)::int total
         from (${ALL_SCOPES}) s`,
      [userId],
    );
    ok(
      `with no template and no overrides, all ${empty.total} scopes resolve to edit (NOT hidden)`,
      empty.bad === 0,
      `${empty.bad} scope(s) resolved to something else`,
    );

    /* ---------------------------------------------------------------------
     * 2. A template with a grant on roughly half the scopes, plus a handful
     *    of per-user overrides that contradict it. This is the shape the
     *    matrix's two state columns describe.
     * ------------------------------------------------------------------- */
    const { rows: [tpl] } = await client.query(
      `insert into permission_templates (label) values ('__verify_grant_matrix__') returning id`,
    );
    await client.query(`insert into user_templates (user_id, template_id) values ($1, $2)
                        on conflict (user_id) do update set template_id = excluded.template_id`,
      [userId, tpl.id]);

    // Deterministic spread across all three levels and all three scope kinds.
    const { rowCount: granted } = await client.query(
      `insert into template_grants (template_id, scope_kind, scope_id, grant_level)
       select $1, s.kind, s.id,
              (array['hidden','view','edit'])[1 + (('x' || substr(md5(s.id::text), 1, 8))::bit(32)::int & 2147483647 & 3) % 3]::permission_level
         from (${ALL_SCOPES}) s
        where (('x' || substr(md5(s.id::text), 1, 8))::bit(32)::int & 2147483647 & 1) = 0`,
      [tpl.id],
    );
    ok(`seeded ${granted} template grants across all three scope kinds`, granted > 20);

    const { rowCount: overridden } = await client.query(
      `insert into user_grants (user_id, scope_kind, scope_id, grant_level)
       select $1, s.kind, s.id, 'view'::permission_level
         from (${ALL_SCOPES}) s
        where ((('x' || substr(md5(s.id::text), 1, 8))::bit(32)::int & 2147483647) % 7) = 0`,
      [userId],
    );
    ok(`seeded ${overridden} per-user overrides on top`, overridden > 5);

    /* ---------------------------------------------------------------------
     * 3. The assertion that matters: the function agrees with the coalesce
     *    the matrix computes in TypeScript, on every single scope.
     * ------------------------------------------------------------------- */
    const { rows: mismatches } = await client.query(
      `select s.kind, s.id,
              effective_grant($1, s.kind, s.id) as fn,
              coalesce(ug.grant_level, tg.grant_level, 'edit') as coalesced
         from (${ALL_SCOPES}) s
         left join user_grants ug
                on ug.user_id = $1 and ug.scope_kind = s.kind and ug.scope_id = s.id
         left join template_grants tg
                on tg.template_id = $2 and tg.scope_kind = s.kind and tg.scope_id = s.id
        where effective_grant($1, s.kind, s.id)
              is distinct from coalesce(ug.grant_level, tg.grant_level, 'edit')`,
      [userId, tpl.id],
    );
    ok(
      'effective_grant() equals "override, else template, else edit" for every scope',
      mismatches.length === 0,
      mismatches.length ? `${mismatches.length} mismatch(es), first: ${JSON.stringify(mismatches[0])}` : '',
    );

    /* ---------------------------------------------------------------------
     * 4. The three precedence cases spelled out, so a failure above says
     *    which half broke.
     * ------------------------------------------------------------------- */
    const { rows: [breakdown] } = await client.query(
      `select
         count(*) filter (where ug.grant_level is not null
                            and effective_grant($1, s.kind, s.id) = ug.grant_level)::int from_override,
         count(*) filter (where ug.grant_level is null and tg.grant_level is not null
                            and effective_grant($1, s.kind, s.id) = tg.grant_level)::int from_template,
         count(*) filter (where ug.grant_level is null and tg.grant_level is null
                            and effective_grant($1, s.kind, s.id) = 'edit')::int from_default,
         count(*) filter (where ug.grant_level is not null and tg.grant_level is not null
                            and ug.grant_level <> tg.grant_level)::int contested
         from (${ALL_SCOPES}) s
         left join user_grants ug
                on ug.user_id = $1 and ug.scope_kind = s.kind and ug.scope_id = s.id
         left join template_grants tg
                on tg.template_id = $2 and tg.scope_kind = s.kind and tg.scope_id = s.id`,
      [userId, tpl.id],
    );
    ok(`the override wins wherever one exists (${breakdown.from_override} scopes)`, breakdown.from_override > 0);
    ok(`the template is used where there is no override (${breakdown.from_template} scopes)`, breakdown.from_template > 0);
    ok(`the default (edit) applies where neither exists (${breakdown.from_default} scopes)`, breakdown.from_default > 0);
    ok(
      `at least one scope has an override that CONTRADICTS its template (${breakdown.contested}) — otherwise precedence was never tested`,
      breakdown.contested > 0,
    );

    /* ---------------------------------------------------------------------
     * 5. Subtabs are not a grant scope. The matrix renders them as structure
     *    only; if the enum ever grows a fourth value that stops being true.
     * ------------------------------------------------------------------- */
    const { rows: enumVals } = await client.query(
      `select unnest(enum_range(null::grant_scope))::text as v order by 1`,
    );
    ok(
      'grant_scope is exactly (field, module, tab) — no subtab scope to render',
      enumVals.map((r) => r.v).join(',') === 'module,tab,field' ||
      enumVals.map((r) => r.v).sort().join(',') === 'field,module,tab',
      JSON.stringify(enumVals.map((r) => r.v)),
    );
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
