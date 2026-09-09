/**
 * Verifies that the auth migration AND Module 2 (Records List) landed
 * correctly, and that the security properties each claims are actually true
 * in the live database.
 *
 * This is not a smoke test. It asserts the things that fail SILENTLY if a
 * migration half-applies: RLS left off a table, a policy that never got
 * created, a definer function without a pinned search_path, an audit table
 * that turns out to be editable after all, a column revoke that never landed.
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/verify-schema.mjs
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const EXPECTED_TABLES = [
  'roles', 'permissions', 'role_permissions', 'profiles',
  'invites', 'otp_challenges', 'auth_audit_log', 'rate_limit_counters',
];

const EXPECTED_FUNCTIONS = [
  'auth_is_admin', 'log_auth_event', 'find_pending_invite', 'email_is_registered',
  'issue_otp_challenge', 'verify_otp_challenge', 'redeem_signup_ticket',
  'complete_signup', 'revoke_other_sessions', 'touch_last_seen', 'mark_login',
  'session_state', 'session_state_for', 'rate_limit_hit', 'expire_stale_invites',
];

/** Reachable from the client only through definer functions — never directly. */
const MUST_HAVE_NO_POLICIES = ['invites', 'otp_challenges', 'rate_limit_counters'];

/* ---------------------------------------------------------------------------
 * Module 2 — Records List and the field engine
 * ------------------------------------------------------------------------- */

const MODULE2_TABLES = [
  'modules', 'tabs', 'subtabs', 'module_tab_order', 'module_subtab_order',
  'fields', 'module_columns', 'module_header_fields', 'field_choices',
  'pipelines', 'pipeline_steps',
  'records', 'record_modules', 'record_pipelines', 'record_custom_entries',
  'notes', 'updates', 'update_mentions', 'notifications',
  'cases', 'case_managers', 'case_replies',
  'file_rows', 'files', 'statement_periods', 'statement_files',
  'logins', 'credential_reveals', 'messages',
  'record_activity', 'record_team_members',
  'permission_templates', 'template_grants', 'user_templates', 'user_grants',
  'record_visibility_grants',
  'user_column_order', 'user_field_order', 'user_filters',
];

const MODULE2_FUNCTIONS = [
  'can_see_record', 'record_visible', 'delete_record', 'restore_record',
  'updates_depth_guard', 'toggle_case_state', 'files_cap_guard', 'log_activity',
  'sync_record_team_members', 'refresh_open_case_managers', 'effective_grant',
  'effective_grants',
  // SECURITY INVOKER by design (the file_rows RLS policy is the gate), so it
  // is deliberately absent from the SECURITY DEFINER assertion further down.
  'ensure_application_file_rows',
  'open_case_managers_for', 'store_login_password', 'reveal_password',
  'fields_placement_guard', 'notify',
  'set_record_value', 'set_record_memberships', 'set_pipeline_step',
  'clear_pipeline', 'edit_update', 'delete_update', 'create_case',
  'add_case_reply', 'admin_edit_case', 'record_file_upload', 'delete_file',
  'bulk_set_values', 'purge_record',
  // Added while building Stage 4 (Files/Logins/Statements UI, the collab
  // surfaces, @mentions) — found missing from this list by the same
  // "verify, don't assume" discipline the rest of this script already uses.
  'statement_file_upload', 'delete_statement_file', 'profile_names',
  'edit_note', 'delete_note', 'set_case_solution',
  'record_team_member_ids', 'add_update_with_mentions',
];

/** Config tables: readable by everyone, writable by admins only — no bypass. */
const MODULE2_ADMIN_WRITE_ONLY_TABLES = [
  'modules', 'tabs', 'subtabs', 'module_tab_order', 'module_subtab_order',
  'fields', 'module_columns', 'module_header_fields', 'field_choices',
  'pipelines', 'pipeline_steps', 'statement_periods',
  'permission_templates', 'template_grants', 'user_templates', 'user_grants',
  'record_visibility_grants',
];

/** Written exclusively by a definer function — no client policy grants a write. */
const MODULE2_NO_WRITE_GRANT_TABLES = [
  'credential_reveals', 'messages', 'record_activity', 'record_team_members',
];

let failures = 0;

function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await client.connect();

  console.log('\nTables');
  // Joined through pg_namespace on BOTH sides, not just by relname — a
  // same-named relation in another schema (Supabase's own `realtime.messages`
  // is exactly this case) would otherwise silently pair with the wrong row.
  const { rows: tables } = await client.query(
    `select c.relname as tablename, c.relrowsecurity as rowsecurity,
            c.relforcerowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')`, // 'p' = partitioned (record_activity)
  );
  const byName = new Map(tables.map((r) => [r.tablename, r]));

  for (const name of EXPECTED_TABLES) {
    const row = byName.get(name);
    check(`${name} exists`, Boolean(row));
    if (row) {
      check(`${name} RLS enabled`, row.rowsecurity === true);
      check(`${name} RLS forced`, row.relforcerowsecurity === true);
    }
  }

  console.log('\nPolicies');
  const { rows: policies } = await client.query(
    `select tablename, policyname from pg_policies where schemaname = 'public'`,
  );
  const policiesByTable = policies.reduce((acc, p) => {
    (acc[p.tablename] ??= []).push(p.policyname);
    return acc;
  }, {});

  check('profiles has a self-read policy', (policiesByTable.profiles ?? []).includes('profiles_select_self'));
  check('profiles has an admin-read policy', (policiesByTable.profiles ?? []).includes('profiles_select_admin'));
  check('auth_audit_log is admin-read only', (policiesByTable.auth_audit_log ?? []).length === 1);

  for (const table of MUST_HAVE_NO_POLICIES) {
    const count = (policiesByTable[table] ?? []).length;
    check(`${table} has NO client policy (definer-only access)`, count === 0, `${count} found`);
  }

  console.log('\nFunctions');
  const { rows: functions } = await client.query(
    `select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'`,
  );
  const funcByName = new Map(functions.map((f) => [f.proname, f]));

  for (const name of EXPECTED_FUNCTIONS) {
    const fn = funcByName.get(name);
    check(`${name} exists`, Boolean(fn));
    if (fn) {
      check(`${name} is SECURITY DEFINER`, fn.prosecdef === true);
      check(
        `${name} pins search_path`,
        (fn.config ?? '').includes('search_path='),
        fn.config || 'not set',
      );
    }
  }

  console.log('\nAppend-only enforcement');
  const { rows: triggers } = await client.query(
    `select tgname from pg_trigger
      where tgrelid = 'public.auth_audit_log'::regclass and not tgisinternal`,
  );
  const names = triggers.map((t) => t.tgname);
  check('audit log blocks UPDATE', names.includes('auth_audit_log_no_update'));
  check('audit log blocks DELETE', names.includes('auth_audit_log_no_delete'));

  // Prove it rather than trusting the trigger exists.
  await client.query(
    `insert into auth_audit_log (event_type, metadata) values ('verify_probe', '{}'::jsonb)`,
  );
  for (const [label, sql] of [
    ['UPDATE is refused', `update auth_audit_log set event_type = 'tampered' where event_type = 'verify_probe'`],
    ['DELETE is refused', `delete from auth_audit_log where event_type = 'verify_probe'`],
  ]) {
    try {
      await client.query(sql);
      check(label, false, 'it succeeded — the log is editable');
    } catch (error) {
      check(label, /append-only/i.test(error.message), error.message.split('\n')[0]);
    }
  }

  console.log('\nConstraints and seeds');
  const { rows: idx } = await client.query(
    `select indexname from pg_indexes
      where schemaname = 'public' and indexname = 'invites_one_pending_per_email'`,
  );
  check('one pending invite per email', idx.length === 1);

  const { rows: roles } = await client.query(`select slug, is_admin from roles order by slug`);
  check('super_admin role seeded', roles.some((r) => r.slug === 'super_admin' && r.is_admin));
  check('placeholder role seeded', roles.some((r) => r.slug === 'member' && !r.is_admin));

  const { rows: users } = await client.query(`select count(*)::int as n from profiles`);
  check('NO user seeded (no default credential exists)', users[0].n === 0, `${users[0].n} profiles`);

  /* ---------------------------------------------------------------------
   * Module 2 — Records List and the field engine
   * --------------------------------------------------------------------- */

  console.log('\nModule 2 — tables');
  for (const name of MODULE2_TABLES) {
    const row = byName.get(name);
    check(`${name} exists`, Boolean(row));
    if (row) {
      check(`${name} RLS enabled`, row.rowsecurity === true);
      check(`${name} RLS forced`, row.relforcerowsecurity === true);
    }
  }

  console.log('\nModule 2 — functions');
  for (const name of MODULE2_FUNCTIONS) {
    const fn = funcByName.get(name);
    check(`${name} exists`, Boolean(fn));
    if (fn) {
      check(
        `${name} pins search_path`,
        (fn.config ?? '').includes('search_path='),
        fn.config || 'not set',
      );
    }
  }
  // Definer-only functions genuinely need SECURITY DEFINER; the trigger
  // functions (updates_depth_guard, files_cap_guard, sync_record_team_members,
  // fields_placement_guard) run as the invoking role by design, so they're
  // excluded from this particular assertion.
  for (const name of [
    'can_see_record', 'record_visible', 'delete_record', 'restore_record',
    'toggle_case_state', 'log_activity', 'refresh_open_case_managers',
    'effective_grant', 'effective_grants', 'open_case_managers_for', 'store_login_password',
    'reveal_password', 'notify',
    'set_record_value', 'set_record_memberships', 'set_pipeline_step',
    'clear_pipeline', 'edit_update', 'delete_update', 'create_case',
    'add_case_reply', 'admin_edit_case', 'record_file_upload', 'delete_file',
    'bulk_set_values', 'purge_record',
    'statement_file_upload', 'delete_statement_file', 'profile_names',
    'edit_note', 'delete_note', 'set_case_solution',
    'record_team_member_ids', 'add_update_with_mentions',
  ]) {
    const fn = funcByName.get(name);
    if (fn) check(`${name} is SECURITY DEFINER`, fn.prosecdef === true);
  }

  console.log('\nModule 2 — RLS policy shape');
  // Queried by actual `cmd` ('SELECT'/'INSERT'/'UPDATE'/'DELETE'/'ALL'), not
  // guessed from the policy's name — a single `for all` admin policy (the
  // shape these tables actually use) covers SELECT without a policy whose
  // name contains the word "select".
  const { rows: module2Policies } = await client.query(
    `select tablename, cmd, qual, with_check from pg_policies where schemaname = 'public'`,
  );
  const policyRowsByTable = module2Policies.reduce((acc, p) => {
    (acc[p.tablename] ??= []).push(p);
    return acc;
  }, {});
  for (const table of MODULE2_ADMIN_WRITE_ONLY_TABLES) {
    const rows = policyRowsByTable[table] ?? [];
    check(`${table} has a select policy`, rows.some((p) => p.cmd === 'SELECT' || p.cmd === 'ALL'));
    check(
      `${table} has an admin-gated write policy`,
      rows.some(
        (p) =>
          ['INSERT', 'UPDATE', 'DELETE', 'ALL'].includes(p.cmd) &&
          /auth_is_admin/.test(`${p.qual ?? ''}${p.with_check ?? ''}`),
      ),
    );
  }
  for (const table of MODULE2_NO_WRITE_GRANT_TABLES) {
    const { rows } = await client.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = $1
          and grantee = 'authenticated'
          and privilege_type in ('INSERT','UPDATE','DELETE')`,
      [table],
    );
    check(`${table} has no client write grant (definer-only)`, rows.length === 0, `${rows.length} found`);
  }

  console.log('\nModule 2 — Logins column-level protection');
  // has_column_privilege(), not information_schema — the view lists whatever
  // ACL entry exists without resolving table-level-vs-column-level the way
  // Postgres's actual permission check does, which is exactly how the first
  // run of this script missed that a column-level REVOKE had no effect
  // against a role that also held table-level SELECT.
  const { rows: loginPriv } = await client.query(
    `select has_column_privilege('authenticated', 'logins', 'password_enc', 'SELECT') as enc,
            has_column_privilege('authenticated', 'logins', 'password_key', 'SELECT') as key,
            has_column_privilege('authenticated', 'logins', 'username', 'SELECT') as username`,
  );
  check('password_enc is NOT selectable by authenticated', loginPriv[0].enc === false);
  check('password_key is NOT selectable by authenticated', loginPriv[0].key === false);
  check('ordinary login metadata (username) IS still selectable', loginPriv[0].username === true);

  console.log('\nModule 2 — append-only activity log');
  const { rows: activityTriggers } = await client.query(
    `select tgname from pg_trigger
      where tgrelid = 'public.record_activity'::regclass and not tgisinternal`,
  );
  check('record_activity has an append-only trigger', activityTriggers.some((t) => t.tgname.includes('append_only')));

  // record_id must NOT be a foreign key — a Recycle Bin purge deletes the
  // parent `records` row, and the trail must survive that (same reasoning,
  // same fix shape, as auth_audit_log.actor_id).
  const { rows: activityFks } = await client.query(
    `select conname from pg_constraint
      where conrelid = 'public.record_activity'::regclass and contype = 'f'`,
  );
  check('record_activity.record_id has NO foreign key (survives a purge)', activityFks.length === 0, `${activityFks.length} found`);
  const { rows: activityGrants } = await client.query(
    `select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'record_activity'
        and grantee in ('authenticated', 'anon')
        and privilege_type in ('UPDATE', 'DELETE')`,
  );
  check('record_activity has no UPDATE/DELETE grant', activityGrants.length === 0, `${activityGrants.length} found`);

  const { rows: partRows } = await client.query(
    `select count(*)::int as n from pg_inherits
      where inhparent = 'public.record_activity'::regclass`,
  );
  check('record_activity is partitioned (has child partitions)', partRows[0].n >= 2, `${partRows[0].n} partitions`);

  console.log('\nModule 2 — derived tables');
  const { rows: matviews } = await client.query(
    `select matviewname from pg_matviews where schemaname = 'public' and matviewname = 'record_open_case_managers'`,
  );
  check('record_open_case_managers materialized view exists', matviews.length === 1);
  const { rows: matviewGrants } = await client.query(
    `select privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'record_open_case_managers'
        and grantee in ('authenticated', 'anon')`,
  );
  check('record_open_case_managers has no direct client grant', matviewGrants.length === 0, `${matviewGrants.length} found`);

  console.log('\nModule 2 — constraints');
  const { rows: dealNameIdx } = await client.query(
    `select indexname from pg_indexes
      where schemaname = 'public' and indexname = 'records_deal_name_unique'`,
  );
  check('Deal Name unique index exists', dealNameIdx.length === 1);

  console.log('\nModule 2 — seed');
  const seedCounts = {
    modules: 6, tabs: 13, subtabs: 19, pipelines: 4, pipeline_steps: 21,
    statement_periods: 102,
  };
  for (const [table, expected] of Object.entries(seedCounts)) {
    const { rows } = await client.query(`select count(*)::int as n from ${table}`);
    check(`${table} seeded with ${expected} rows`, rows[0].n === expected, `${rows[0].n} found`);
  }
  // Fields: 138 prototype entries, 3 repeat groups collapsed into 4 rows
  // (owner splits across Private/Ownership) — see generate-seed-sql.ts.
  const { rows: fieldCount } = await client.query('select count(*)::int as n from fields');
  check('fields seeded with 129 rows', fieldCount[0].n === 129, `${fieldCount[0].n} found`);

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );

  await client.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\nVerification error:', error.message);
  await client.end().catch(() => {});
  process.exit(1);
});
