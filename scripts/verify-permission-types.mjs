/**
 * Permissions spec — the database rules, type by type.
 *
 * Runs entirely inside ONE transaction that is rolled back: probe records, a
 * `.test` member account switched through each user type, and the expected
 * allow / refuse for record access, the company-wide actions, the team rule,
 * and Updates / Cases visibility with per-item grants and hidden replies.
 * Nothing it does survives the run.
 *
 * Usage: node --env-file=.env scripts/verify-permission-types.mjs
 */
import pg from 'pg';

// Any active non-admin @tapdash.test account (the client tidies these away;
// the script does not depend on a particular one).
const OTHER = 'admin@tapdash.test';

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
await c.connect();
const q = (s, p = []) => c.query(s, p).then((r) => r.rows);
const pass = [], fail = [];
const t = (name, ok, d = '') => (ok ? pass : fail).push(`${name}${d ? '  — ' + d : ''}`);

/** Run `fn` as `userId` (RLS and auth.uid() as that user), inside a savepoint. */
async function as(userId, fn) {
  await q('savepoint s');
  await q(`select set_config('request.jwt.claims', $1, true), set_config('role', 'authenticated', true)`,
    [JSON.stringify({ sub: userId, role: 'authenticated' })]);
  try {
    return await fn();
  } finally {
    await q('rollback to savepoint s');
  }
}
/** True when the statement is refused; the error is kept for the report. */
let lastError = '';
const refuses = async (sql, params = []) => {
  await q('savepoint r');
  try {
    await q(sql, params);
    await q('release savepoint r');
    lastError = '';
    return false;
  } catch (e) {
    await q('rollback to savepoint r');
    lastError = String(e.message ?? e);
    return true;
  }
};

await q('begin');
try {
  const [member] = await q(`select p.id from profiles p join roles r on r.id = p.role_id
      where not r.is_admin and p.deleted_at is null and p.status = 'active' and p.email like '%@tapdash.test'
      order by p.email limit 1`);
  const [other] = await q(`select id from profiles where email = $1`, [OTHER]);
  if (!member || !other) throw new Error('test accounts missing');
  const mods = Object.fromEntries((await q(`select slug, id from modules`)).map((m) => [m.slug, m.id]));
  const type = async (ut) => q(`update user_templates set template_id = (select id from permission_templates where user_type = $2) where user_id = $1`, [member.id, ut]);

  // Probes: one the member is on, one they manage (RM), one they are not on, one archived.
  const mk = async (name, values, modules) => {
    const [r] = await q(`insert into records (deal_name, values, creator_user_id) values ($1, $2, $3) returning id`, [name, values, other.id]);
    for (const m of modules) await q(`insert into record_modules (record_id, module_id) values ($1, $2)`, [r.id, mods[m]]);
    return r.id;
  };
  const onTeam = await mk('ZZ perm team', { team_members_assigned: [member.id] }, ['leads']);
  const asRm = await mk('ZZ perm rm', { relationship_manager: [member.id] }, ['leads']);
  const notMine = await mk('ZZ perm other', { team_members_assigned: [other.id] }, ['leads']);
  const archived = await mk('ZZ perm archived', { team_members_assigned: [other.id] }, []);
  const [pipe] = await q(`select p.id, (select id from pipeline_steps s where s.pipeline_id = p.id order by position limit 1) step from pipelines p where p.module_id = $1 limit 1`, [mods.leads]);

  // An update by someone else on the member's record, with a reply.
  const [upd] = await q(`insert into updates (record_id, author_id, body) values ($1, $2, 'ZZ probe update') returning id`, [onTeam, other.id]);
  const [reply] = await q(`insert into updates (record_id, parent_id, author_id, body) values ($1, $2, $3, 'ZZ probe reply') returning id`, [onTeam, upd.id, other.id]);

  const see = (rec) => q(`select record_visible($1) v`, [rec]).then((r) => r[0].v);

  // ── Sales agent ──
  await type('sales_agent');
  await as(member.id, async () => {
    t('sales agent: sees a record they are on', await see(onTeam));
    t('sales agent: sees a record they manage (relationship manager)', await see(asRm));
    t('sales agent: does not see a record they are not on', !(await see(notMine)));
    t('sales agent: does not see an archived record (Records List hidden)', !(await see(archived)));
    t('sales agent: cannot archive', await refuses(`select set_record_memberships($1, '{}')`, [onTeam]));
    t('sales agent: cannot change In modules', await refuses(`select set_record_memberships($1, $2)`, [onTeam, [mods.leads, mods.deals]]));
    // The app's own create flow: insert (no RETURNING), then place it.
    const create = async () => {
      const id = (await q(`select gen_random_uuid() id`))[0].id;
      const ok = !(await refuses(
        `insert into records (id, deal_name, creator_kind, creator_user_id, "values")
         values ($1::uuid, 'ZZ perm create ' || $1::text, 'user', $2::uuid, jsonb_build_object('team_members_assigned', jsonb_build_array($3::text)))`,
        [id, member.id, member.id]));
      return ok ? id : null;
    };
    const fresh = await create();
    t('sales agent: can create a record', Boolean(fresh), lastError);
    t('sales agent: can place their new record in Leads', Boolean(fresh) && !(await refuses(`select set_record_memberships($1, $2)`, [fresh, [mods.leads]])), lastError);
    const fresh2 = await create();
    t('sales agent: cannot create into a Hidden module', Boolean(fresh2) && (await refuses(`select set_record_memberships($1, $2)`, [fresh2, [mods.residuals]])), lastError);
    t('sales agent: can move the pipeline', !(await refuses(`select set_pipeline_step($1, $2, $3, $4)`, [onTeam, mods.leads, pipe.id, pipe.step])), lastError);
    const [g] = await q(`select record_field_grant($1, 'team_members_assigned') g`, [onTeam]);
    t('sales agent: team field is view-only', g.g === 'view', g.g);
    const [pr] = await q(`select record_field_grant($1, 'td_amex_volume') g`, [onTeam]);
    t('sales agent: Pricing is view-only', pr.g === 'view', pr.g);
    // "The most specific setting wins": one Pricing field Edit while Pricing is View.
    await q('savepoint ms');
    await q(`reset role`);
    await q(`insert into template_grants (template_id, scope_kind, scope_id, grant_level)
             select (select id from permission_templates where user_type = 'sales_agent'), 'field', id, 'edit' from fields where key = 'td_amex_volume'`);
    await q(`select set_config('role', 'authenticated', true)`);
    const [one] = await q(`select record_field_grant($1, 'td_amex_volume') g, record_field_grant($1, 'td_vmd_volume') o`, [onTeam]);
    await q('rollback to savepoint ms');
    t('sales agent: a Pricing field set to Edit beats Pricing = View', one.g === 'edit' && one.o === 'view', JSON.stringify(one));
    const [u] = await q(`select count(*)::int n from updates where id = any($1)`, [[upd.id, reply.id]]);
    t('sales agent: does not see someone else\'s update (Only mine)', u.n === 0, String(u.n));
  });
  // Granted that one update → sees it and its reply; the reply's author hides it → only the update.
  await q(`insert into item_access_grants (item_kind, item_id, record_id, grantee_user, granted_by) values ('update', $1, $2, $3, $4)`, [upd.id, onTeam, member.id, other.id]);
  await as(member.id, async () => {
    const rows = await q(`select id from updates where id = any($1)`, [[upd.id, reply.id]]);
    t('sales agent: a granted update and its reply become visible', rows.length === 2, String(rows.length));
  });
  await q(`insert into reply_hidden_from (reply_kind, reply_id, user_id, hidden_by) values ('update', $1, $2, $3)`, [reply.id, member.id, other.id]);
  await as(member.id, async () => {
    const rows = await q(`select id from updates where id = any($1)`, [[upd.id, reply.id]]);
    t('sales agent: a reply hidden from them disappears, the update stays', rows.length === 1 && rows[0].id === upd.id);
  });
  await as(member.id, async () => {
    t('sales agent: cannot share (not See all + grant)', await refuses(`select grant_item_access('update', $1, $2, null)`, [upd.id, other.id]));
  });

  // ── Accounting ──
  await type('accounting');
  await as(member.id, async () => {
    t('accounting: sees every lead (All records)', (await see(onTeam)) && (await see(notMine)));
    t('accounting: cannot create', await refuses(`insert into records (deal_name, creator_user_id) values ('ZZ perm new', $1)`, [member.id]));
    t('accounting: cannot move the pipeline', await refuses(`select set_pipeline_step($1, $2, $3, $4)`, [notMine, mods.leads, pipe.id, pipe.step]));
    const [g] = await q(`select record_field_grant($1, 'relationship_manager') g`, [notMine]);
    t('accounting: relationship manager is view-only', g.g === 'view', g.g);
    const [l] = await q(`select record_tab_grant($1, 'logins') g`, [notMine]);
    t('accounting: Logins hidden', l.g === 'hidden', l.g);
  });

  // ── Customer service ──
  await type('customer_service');
  await as(member.id, async () => {
    t('customer service: can move the pipeline', !(await refuses(`select set_pipeline_step($1, $2, $3, $4)`, [notMine, mods.leads, pipe.id, pipe.step])));
    const [g] = await q(`select record_field_grant($1, 'team_members_assigned') g`, [notMine]);
    t('customer service: can change the team', g.g === 'edit', g.g);
    const [l] = await q(`select record_tab_grant($1, 'logins') g`, [notMine]);
    t('customer service: Logins view only', l.g === 'view', l.g);
    t('customer service: cannot create', await refuses(`insert into records (deal_name, creator_user_id) values ('ZZ perm new', $1)`, [member.id]));
  });

  // ── Underwriter ──
  await type('underwriter');
  await as(member.id, async () => {
    t('underwriter: does not see archived records', !(await see(archived)));
    t('underwriter: can change In modules', !(await refuses(`select set_record_memberships($1, $2)`, [notMine, [mods.leads, mods.deals]])));
    t('underwriter: cannot archive', await refuses(`select set_record_memberships($1, '{}')`, [notMine]));
    const [l] = await q(`select record_tab_grant($1, 'logins') g`, [notMine]);
    t('underwriter: Logins edit', l.g === 'edit', l.g);
    const [m] = await q(`select record_tab_grant($1, 'marketing') g`, [notMine]);
    t('underwriter: Marketing hidden', m.g === 'hidden', m.g);
  });

  // ── Admin ──
  await type('admin');
  await as(member.id, async () => {
    t('admin: sees archived records (Records List: All)', await see(archived));
    t('admin: can archive', !(await refuses(`select set_record_memberships($1, '{}')`, [notMine])));
    const [p] = await q(`select my_permissions()->'settings'->>'admin.recycle_bin' rb, my_permissions()->'settings'->>'email.scope' em`);
    t('admin: no Recycle bin, own email only', p.rb === 'hidden' && p.em === 'own', JSON.stringify(p));
  });
} catch (e) {
  fail.push(`script stopped: ${String(e.message ?? e).slice(0, 300)}`);
} finally {
  await q('rollback');
  await c.end();
  console.log(`PASS ${pass.length}\n  ${pass.join('\n  ')}`);
  console.log(`FAIL ${fail.length}\n  ${fail.join('\n  ')}`);
  process.exit(fail.length ? 1 : 0);
}
