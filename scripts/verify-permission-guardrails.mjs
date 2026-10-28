// Permissions spec guardrails, checked against a migration file applied inside a rolled-back transaction.
// Usage: node --env-file=.env scripts/verify-permission-guardrails.mjs [migration.sql]
// The migration argument is optional — without it the live definitions are checked.
import pg from 'pg';
import { readFileSync } from 'node:fs';
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL }); await c.connect();
const q = (s, p = []) => c.query(s, p).then((r) => r.rows);
const out = [];
const expectErr = async (name, sql, p) => { await q('savepoint g'); try { await q(sql, p); out.push(`FAIL ${name} (allowed)`); } catch (e) { out.push(`PASS ${name} — ${e.message}`); } await q('rollback to savepoint g'); };
const expectOk = async (name, sql, p) => { await q('savepoint g'); try { await q(sql, p); out.push(`PASS ${name}`); await q('release savepoint g'); } catch (e) { out.push(`FAIL ${name} — ${e.message}`); await q('rollback to savepoint g'); } };
await q('begin');
try {
  if (process.argv[2]) await q(readFileSync(process.argv[2], 'utf8'));
  const id = async (e) => (await q('select id from profiles where email=$1', [e]))[0].id;
  const tpl = async (t) => (await q('select id from permission_templates where user_type=$1', [t]))[0].id;
  const admin = await id('admin@tapdash.test'), maylyn = await id('maylyn@tapdash.co'), member = (await q(`select p.id from profiles p join roles r on r.id = p.role_id
      where not r.is_admin and p.deleted_at is null and p.status = 'active' and p.email like '%@tapdash.test'
      order by p.email limit 1`))[0].id;
  // Make Maylyn an Admin type for the actor checks (rolled back).
  await q(`update user_templates set template_id=$2 where user_id=$1`, [maylyn, await tpl('admin')]);
  await expectErr('1. cannot edit own overrides', `select perm_set_setting($1,'user',$1,'action.archive','no')`, [maylyn]);
  await expectErr('1. cannot edit own type', `select perm_set_setting($1,'template',$2,'action.archive','no')`, [maylyn, await tpl('admin')]);
  await expectErr('2. cannot grant above own (recycle bin)', `select perm_set_setting($1,'template',$2,'admin.recycle_bin','full')`, [maylyn, await tpl('sales_agent')]);
  await expectOk('2. can grant at or below own', `select perm_set_setting($1,'template',$2,'action.archive','yes')`, [maylyn, await tpl('sales_agent')]);
  await expectErr('3. Admin cannot change a Super admin', `select perm_set_setting($1,'user',$2,'action.archive','no')`, [maylyn, admin]);
  await expectErr('3. Admin cannot make a Super admin', `select perm_assign_type($1,$2,$3)`, [maylyn, member, await tpl('super_admin')]);
  await expectOk('Admin can change a Sales agent\'s type', `select perm_assign_type($1,$2,$3)`, [maylyn, member, await tpl('customer_service')]);
  const [log] = await q(`select count(*)::int n from permission_audit_log where actor_id=$1`, [maylyn]);
  out.push(`${log.n >= 2 ? 'PASS' : 'FAIL'} audit rows written — ${log.n}`);
  await q(`set constraints all immediate`);
  await expectErr('4. cannot remove the last Super admin', `update profiles set status='suspended' where role_id=(select id from roles where is_admin) and status='active'`);
  // Migration 9820: the six user types are permanent.
  await expectErr('user types cannot be deleted', `delete from permission_templates where user_type='accounting'`);
  await expectErr('a user type cannot become another', `update permission_templates set user_type='admin' where user_type='accounting'`);
  await expectOk('a user type can be renamed', `update permission_templates set label='ZZ renamed' where user_type='accounting'`);
  // Migration 9821: only the levels a tab offers.
  const tab = async (k) => (await q('select id from tabs where key=$1', [k]))[0].id;
  await expectErr('Communication has no tab level', `select perm_set_grant($1,'template',$2,'tab',$3,null,'hidden')`, [admin, await tpl('sales_agent'), await tab('communication')]);
  await expectErr('Marketing has no View only', `select perm_set_grant($1,'template',$2,'tab',$3,null,'view')`, [admin, await tpl('sales_agent'), await tab('marketing')]);
  await expectOk('Marketing can be Full access', `select perm_set_grant($1,'template',$2,'tab',$3,null,'edit')`, [admin, await tpl('sales_agent'), await tab('marketing')]);
} catch (e) { out.push('STOPPED ' + e.message); }
finally { await q('rollback'); await c.end(); console.log(out.join('\n')); }
