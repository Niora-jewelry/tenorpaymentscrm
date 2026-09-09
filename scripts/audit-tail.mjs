/**
 * Reads the auth audit trail.
 *
 * This is the Admin Panel's per-user login history, in a terminal, until that
 * screen is built. Useful for confirming during development that a flow wrote
 * what it should have.
 *
 * Usage:
 *   node scripts/audit-tail.mjs                     # last 20 events
 *   node scripts/audit-tail.mjs someone@company.com # one person's history
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL first.');
  process.exit(1);
}

const email = process.argv[2]?.trim().toLowerCase();
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const { rows } = await (async () => {
  await client.connect();
  return email
    ? client.query(
        `select created_at, event_type, email_attempted, ip, user_agent, metadata
           from auth_audit_log where email_attempted = $1
          order by created_at desc limit 40`,
        [email],
      )
    : client.query(
        `select created_at, event_type, email_attempted, ip, user_agent, metadata
           from auth_audit_log order by created_at desc limit 20`,
      );
})();

console.log(email ? `\nAuth history — ${email}\n` : '\nAuth audit trail — most recent\n');

if (rows.length === 0) {
  console.log('  (nothing recorded yet)\n');
} else {
  for (const row of rows) {
    const when = row.created_at.toISOString().replace('T', ' ').slice(0, 19);
    const meta =
      row.metadata && Object.keys(row.metadata).length > 0 ? `  ${JSON.stringify(row.metadata)}` : '';
    console.log(
      `  ${when}  ${row.event_type.padEnd(28)} ${(row.email_attempted ?? '-').padEnd(28)} ` +
        `${(row.ip ?? '-').padEnd(16)}${meta}`,
    );
  }
  console.log('');
}

await client.end();
