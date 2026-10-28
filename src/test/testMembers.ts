/**
 * Active non-admin test members for an integration test that runs inside a
 * transaction it always rolls back.
 *
 * The standing `@tapdash.test` / `itest-` accounts come first; when there are
 * too few — the client tidies them away from the Users screen, which is their
 * right — the rest are created here, inside the caller's transaction, and
 * vanish with its ROLLBACK. So a suite never depends on who is still around.
 *
 * Must be called after BEGIN.
 */
import type pg from 'pg';

export async function testMembers(db: pg.Client, n: number): Promise<string[]> {
  const { rows } = await db.query(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where p.deleted_at is null and p.status = 'active' and not r.is_admin
        and (p.email::text like '%@tapdash.test' or p.email::text like 'itest-%')
      order by p.email limit $1`,
    [n],
  );
  const ids = rows.map((r) => r.id as string);
  while (ids.length < n) {
    const email = `itest-tmp-${ids.length}-${Date.now()}@tapdash.test`;
    const { rows: u } = await db.query(
      `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
       values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, now(), now())
       returning id`,
      [email],
    );
    const id = u[0].id as string;
    await db.query(
      `insert into profiles (id, email, role_id, status)
       values ($1, $2, (select id from roles where not is_admin order by slug limit 1), 'active')`,
      [id, email],
    );
    await db.query(
      `insert into user_templates (user_id, template_id)
       select $1, id from permission_templates where user_type = 'sales_agent'
       on conflict (user_id) do nothing`,
      [id],
    );
    ids.push(id);
  }
  return ids;
}

/** A Super admin test account: the standing one, else one made in the transaction. */
export async function testAdmin(db: pg.Client): Promise<string> {
  const { rows } = await db.query(
    `select p.id from profiles p join roles r on r.id = p.role_id
      where p.deleted_at is null and p.status = 'active' and r.is_admin
        and (p.email::text like '%@tapdash.test' or p.email::text like 'itest-%')
      order by p.email limit 1`,
  );
  if (rows[0]) return rows[0].id as string;
  const email = `itest-tmp-admin-${Date.now()}@tapdash.test`;
  const { rows: u } = await db.query(
    `insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, now(), now())
     returning id`,
    [email],
  );
  await db.query(`insert into profiles (id, email, role_id, status) values ($1, $2, (select id from roles where is_admin order by slug limit 1), 'active')`, [u[0].id, email]);
  return u[0].id as string;
}
