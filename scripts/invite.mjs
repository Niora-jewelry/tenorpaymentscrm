/**
 * Creates an invite.
 *
 * Until the Admin Panel ships (Phase 3), this is how people are let into the
 * system. It creates an INVITE only — never an account, never a password — so
 * no default credential can ever be left behind. The invited person still
 * completes the normal signup flow.
 *
 * Usage:
 *   node scripts/invite.mjs someone@company.com            # normal member
 *   node scripts/invite.mjs someone@company.com super_admin
 *   node scripts/invite.mjs --list
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL first.');
  process.exit(1);
}

const [arg, roleSlug = 'member'] = process.argv.slice(2);
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  if (!arg || arg === '--list') {
    const { rows } = await client.query(
      `select i.email, r.slug as role, i.status, i.expires_at, i.accepted_at
         from invites i join roles r on r.id = i.role_id
        order by i.created_at desc limit 25`,
    );
    if (rows.length === 0) {
      console.log('\nNo invites yet.\n');
    } else {
      console.log('\nInvites\n');
      for (const row of rows) {
        const when = row.accepted_at
          ? `accepted ${row.accepted_at.toISOString().slice(0, 16).replace('T', ' ')}`
          : `expires ${row.expires_at.toISOString().slice(0, 16).replace('T', ' ')}`;
        console.log(`  ${row.email.padEnd(32)} ${row.role.padEnd(13)} ${row.status.padEnd(9)} ${when}`);
      }
      console.log('');
    }
    await client.end();
    return;
  }

  const email = arg.trim().toLowerCase();

  const { rows: roles } = await client.query(`select id, slug from roles where slug = $1`, [roleSlug]);
  if (roles.length === 0) {
    const { rows: all } = await client.query(`select slug from roles order by slug`);
    console.error(`\nNo role "${roleSlug}". Available: ${all.map((r) => r.slug).join(', ')}\n`);
    process.exit(1);
  }

  const { rows: existing } = await client.query(
    `select id from profiles where email = $1 and deleted_at is null`,
    [email],
  );
  if (existing.length > 0) {
    console.error(`\n${email} already has an account. Nothing to do.\n`);
    process.exit(1);
  }

  // The partial unique index allows only one PENDING invite per address, so an
  // existing one is superseded rather than duplicated.
  await client.query(
    `update invites set status = 'revoked' where email = $1 and status = 'pending'`,
    [email],
  );

  const { rows } = await client.query(
    `insert into invites (email, role_id, status, expires_at)
     values ($1, $2, 'pending', now() + interval '7 days')
     returning expires_at`,
    [email, roles[0].id],
  );

  console.log(`\nInvited ${email} as ${roleSlug}.`);
  console.log(`Expires ${rows[0].expires_at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
  console.log(`\nThey now complete signup at /signup using this exact address.\n`);

  await client.end();
}

main().catch(async (error) => {
  console.error('\nFailed:', error.message);
  await client.end().catch(() => {});
  process.exit(1);
});
