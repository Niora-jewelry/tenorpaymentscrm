/**
 * Builds one non-admin account you can sign in as and FEEL the permissions.
 *
 * WHY THIS EXISTS
 * An admin can never see a permission bite. `auth_is_admin()` short-circuits
 * every resolver to 'edit', so a template with half its rows set to Hidden
 * still renders every tab and every field when a Super Admin opens a drawer.
 * That is correct, and it is also why "are the templates actually wired?"
 * cannot be answered from an admin session. It needs a member.
 *
 * The template below is not a realistic role — it is a DEMONSTRATION. Each row
 * exists to make one of the four levels visible on screen, and the per-module
 * row exists to show the level that was added last and is hardest to believe:
 *
 *   module   Residuals            hidden  the nav item disappears
 *   module   Tickets              view    opens, but nothing can be edited
 *   tab      Logins               hidden  tab absent in every module
 *   tab      Statements           view    tab present, read-only
 *   tab      Pricing, IN LEADS    hidden  absent in Leads, present in Deals
 *   subtab   Application/Private  hidden  subtab absent, siblings remain
 *   field    MID                  hidden  field absent from the payload
 *   field    MCC code             view    shown, not editable
 *
 * RE-RUNNABLE. The grant list below is the whole definition of the template:
 * the rows are replaced, not merged, so running it twice leaves eight grants
 * rather than sixteen, and deleting a line here deletes it from the database.
 *
 * It does NOT create the login. `create-user.mjs` does that, and keeping the
 * credential in one place means there is one script to point at when asking
 * "what set a password on this database":
 *
 *   node --env-file=.env scripts/create-user.mjs demo.rep@tapdash.test '<pw>' member
 *   node --env-file=.env scripts/seed-demo-member.mjs demo.rep@tapdash.test
 */
import pg from 'pg';

const TEMPLATE_LABEL = 'Demo Rep (permissions tour)';

/**
 * Scopes named the way an admin names them — by slug or key, never by id — so
 * this keeps working against a freshly seeded database.
 *
 * `module` is the per-module override from Admin-Module-Plan §2.2. Null means
 * "all modules", which is what every other row here means.
 */
const GRANTS = [
  { kind: 'module', scope: 'residuals', level: 'hidden', module: null },
  { kind: 'module', scope: 'tickets', level: 'view', module: null },
  { kind: 'tab', scope: 'logins', level: 'hidden', module: null },
  { kind: 'tab', scope: 'statements', level: 'view', module: null },
  { kind: 'tab', scope: 'pricing', level: 'hidden', module: 'leads' },
  { kind: 'subtab', scope: 'private', level: 'hidden', module: null },
  /*
   * ⚠ THE FIELD ROWS DELIBERATELY AVOID THE `private` SUBTAB.
   *
   * EIN, account number and routing number all live in Application -> Private,
   * which the row above hides. Granting one of them View or Hidden therefore
   * changed nothing observable: the subtab had already removed them, so the
   * field level looked broken while it was working perfectly. `mid` and
   * `mcc_code` sit in the header strip, where the result is visible at a
   * glance.
   */
  { kind: 'field', scope: 'mid', level: 'hidden', module: null },
  { kind: 'field', scope: 'mcc_code', level: 'view', module: null },
];

/**
 * Which records the demo account is put on the team of.
 *
 * A member sees a record only through `can_see_record()` — team membership or
 * a cross-visibility grant. Module permissions decide what happens AFTER that,
 * so without these rows every module would be empty and the tour would show
 * nothing at all.
 *
 * ⚠ MEMBERSHIP IS WRITTEN THROUGH `values.team_members_assigned`, NOT BY
 * INSERTING `record_team_members` ROWS.
 *
 * `sync_record_team_members()` is an AFTER INSERT OR UPDATE OF "values" trigger
 * that REBUILDS `record_team_members` from that field — it deletes every row
 * whose user is not in the array. A row inserted directly therefore survives
 * only until somebody edits any field on that record, and then vanishes with
 * no error anywhere.
 *
 * That is not theoretical: the first version of this script inserted the rows
 * directly, and the demo account silently lost access to a record the moment a
 * value on it was changed. The drawer then rendered "record unavailable" with
 * nothing in the log to explain it.
 *
 * Appending to the field is the supported path and the same one the Team
 * member(s) assigned control uses, so the membership is durable.
 *
 * Records are chosen by the exact set of modules they sit in. The last entry
 * is the interesting one: a record in BOTH Leads and Deals shows no Pricing
 * tab when opened from Leads and shows it when opened from Deals, because the
 * drawer resolves grants in the module it was opened from — §2.2's "within
 * that module". The write path is separate and deliberately more permissive:
 * its module arrives from the browser, so it resolves from `record_modules`
 * and takes the best, which can never refuse a save for something the drawer
 * just displayed.
 */
const TEAM_PICKS = [
  { modules: ['leads'], count: 3 },
  { modules: ['deals'], count: 2 },
  { modules: ['contacts'], count: 2 },
  { modules: ['tickets'], count: 2 },
  { modules: ['deals', 'leads'], count: 1 },
];

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error(
    '\nNeeds SUPABASE_DB_URL. Run as: node --env-file=.env scripts/seed-demo-member.mjs <email>\n',
  );
  process.exit(1);
}

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email) {
  console.error('\nUsage: node --env-file=.env scripts/seed-demo-member.mjs <email>\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
const q = async (sql, params) => (await client.query(sql, params)).rows;

async function main() {
  await client.connect();
  await client.query('begin');

  const [profile] = await q(
    `select p.id, p.email, r.slug as role, r.is_admin
       from profiles p join roles r on r.id = p.role_id
      where p.email = $1 and p.deleted_at is null`,
    [email],
  );
  if (!profile) throw new Error(`No active profile for ${email}. Run create-user.mjs first.`);
  if (profile.is_admin) {
    // Not a safety check — a courtesy one. The script would otherwise run fine
    // and change nothing observable, which is the worst outcome to debug.
    throw new Error(
      `${email} holds the ${profile.role} role, which is an admin role. ` +
        'Admins bypass every grant, so this tour would show nothing.',
    );
  }

  // -- Look up every scope by name --------------------------------------
  const byName = {
    module: new Map((await q('select id, slug from modules')).map((m) => [m.slug, m.id])),
    tab: new Map((await q('select id, key from tabs')).map((t) => [t.key, t.id])),
    subtab: new Map((await q('select id, key from subtabs')).map((s) => [s.key, s.id])),
    field: new Map((await q('select id, key from fields')).map((f) => [f.key, f.id])),
  };

  const resolved = GRANTS.map((g) => {
    const scopeId = byName[g.kind].get(g.scope);
    if (!scopeId) throw new Error(`No ${g.kind} named "${g.scope}"`);
    const moduleId = g.module ? byName.module.get(g.module) : null;
    if (g.module && !moduleId) throw new Error(`No module named "${g.module}"`);
    return { ...g, scopeId, moduleId };
  });

  // -- The template ------------------------------------------------------
  let [template] = await q('select id from permission_templates where label = $1', [
    TEMPLATE_LABEL,
  ]);
  if (!template) {
    [template] = await q('insert into permission_templates (label) values ($1) returning id', [
      TEMPLATE_LABEL,
    ]);
  }

  await q('delete from template_grants where template_id = $1', [template.id]);
  for (const g of resolved) {
    await q(
      `insert into template_grants (template_id, scope_kind, scope_id, grant_level, module_id)
       values ($1, $2, $3, $4, $5)`,
      [template.id, g.kind, g.scopeId, g.level, g.moduleId],
    );
  }

  // -- Link the user to it -----------------------------------------------
  await q(
    `insert into user_templates (user_id, template_id) values ($1, $2)
     on conflict (user_id) do update set template_id = excluded.template_id`,
    [profile.id, template.id],
  );

  // -- Team membership, so the modules are not empty ---------------------
  let added = 0;
  const picked = [];
  for (const pick of TEAM_PICKS) {
    const rows = await q(
      `select r.id
         from records r
        where r.deleted_at is null
          and (
            -- ::text is load-bearing — modules.slug is citext, and citext[]
            -- has no equality operator against text[].
            select array_agg(m.slug::text order by m.slug)
              from record_modules rm join modules m on m.id = rm.module_id
             where rm.record_id = r.id
          ) = $1::text[]
        order by r.created_at
        limit $2`,
      [[...pick.modules].sort(), pick.count],
    );
    for (const r of rows) {
      // Appends, never replaces: these are the client's own records and the
      // people already on them must stay. The trigger turns this into the
      // `record_team_members` row.
      const res = await client.query(
        `update records
            set values = jsonb_set(
                  values,
                  '{team_members_assigned}',
                  coalesce(values -> 'team_members_assigned', '[]'::jsonb) || to_jsonb($2::text),
                  true
                )
          where id = $1
            and not (coalesce(values -> 'team_members_assigned', '[]'::jsonb) @> to_jsonb($2::text))`,
        [r.id, profile.id],
      );
      added += res.rowCount;
      picked.push({ id: r.id, modules: pick.modules.join(' + ') });
    }
  }

  await client.query('commit');

  console.log(`\nTemplate "${TEMPLATE_LABEL}" -> ${email}`);
  console.log(`  ${resolved.length} grants, ${picked.length} records on the team (${added} new)\n`);
  for (const g of resolved) {
    const where = g.module ? ` (in ${g.module} only)` : '';
    console.log(`  ${g.kind.padEnd(7)} ${(g.scope + where).padEnd(28)} ${g.level}`);
  }
  console.log('');
  for (const p of picked) console.log(`  ${p.modules.padEnd(16)} ${p.id}`);
  console.log('');
  await client.end();
}

main().catch(async (error) => {
  await client.query('rollback').catch(() => {});
  console.error('\nFailed:', error.message, '\n');
  await client.end().catch(() => {});
  process.exit(1);
});
