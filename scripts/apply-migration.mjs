/**
 * Applies one migration file and RECORDS it, in a single transaction.
 *
 * ── WHY BOTH HALVES, ALWAYS ──────────────────────────────────────────────
 * Migrations in this project are applied by running their SQL directly against
 * `SUPABASE_DB_URL` rather than through `supabase db push`. That is fine, and
 * it is only half the job: the migration must also be written into
 * `supabase_migrations.schema_migrations`, which is what `supabase migration
 * repair --status applied <version>` does.
 *
 * Skipping the second half fails silently — nothing at all goes wrong until
 * somebody runs `supabase db push`, at which point the CLI sees every
 * unrecorded migration as pending and re-runs it. `create or replace function`
 * survives that; `create trigger`, `create index` and `alter table` do not, so
 * the push dies with "already exists" on a migration that is plainly applied.
 * The danger is not the failed push, it is what gets done next by someone who
 * concludes the database is broken.
 *
 * Both writes share one transaction, so the pair can never come apart.
 *
 * Usage:
 *   node --env-file=.env scripts/apply-migration.mjs supabase/migrations/<file>.sql
 *
 * Check the whole set is in step:
 *   ls supabase/migrations/*.sql | wc -l
 *   psql "$SUPABASE_DB_URL" -c 'select count(*) from supabase_migrations.schema_migrations'
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import pg from 'pg';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node --env-file=.env scripts/apply-migration.mjs <path to .sql>');
  process.exit(1);
}
if (!process.env.SUPABASE_DB_URL) {
  console.error('SUPABASE_DB_URL is not set. Run with --env-file=.env');
  process.exit(1);
}

const sql = readFileSync(file, 'utf8');
const name = basename(file, '.sql');
// The filename IS the identity: 14-digit timestamp, underscore, then the name.
const version = name.slice(0, 14);
const rest = name.slice(15);

if (!/^\d{14}$/.test(version)) {
  console.error(`"${name}" does not start with a 14-digit version. Rename it before applying.`);
  process.exit(1);
}

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

try {
  await client.query('begin');
  await client.query(sql);
  await client.query(
    `insert into supabase_migrations.schema_migrations (version, name)
     values ($1, $2)
     on conflict (version) do nothing`,
    [version, rest],
  );
  await client.query('commit');
  console.log(`applied and recorded  ${version}  ${rest}`);
} catch (error) {
  await client.query('rollback');
  console.error(`FAILED  ${version}  ${rest}`);
  console.error(`  ${error.code ?? ''} ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
