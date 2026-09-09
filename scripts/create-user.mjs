/**
 * Provisions a working account directly — no invite, no OTP, no email.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `invite.mjs`
 * `invite.mjs` is the honest path: it creates an invite and nothing else, so no
 * credential is ever left behind by tooling. That path needs a working outbound
 * mailer to deliver the OTP. Until RESEND_API_KEY is set there is no way to
 * finish signup, and therefore no way to open the app at all.
 *
 * This script fills exactly that hole and admits what it is: it sets a password
 * that a human chose on the command line, which is a credential you now own and
 * must rotate. It is not part of the product's auth flow and nothing in `src/`
 * imports it.
 *
 * IT REFUSES TO RUN AGAINST A PRODUCTION BUILD. It cannot tell a production
 * DATABASE from a development one — SUPABASE_DB_URL is whatever you point it at
 * — so that guard is a speed bump, not a boundary. Check the URL yourself.
 *
 * WHAT IT DOES
 * Mirrors `complete_signup()` minus the invite: creates the auth.users row with
 * the service-role admin API (email pre-confirmed, since no OTP proved control
 * of the address), then inserts the `profiles` row carrying the role. Both, or
 * neither — a failed profile insert deletes the auth user it just made, exactly
 * as `lib/auth/signup.ts` does, so no login can exist without a profile behind
 * it (middleware would sign such a user straight back out anyway).
 *
 * Re-running with the same email resets that account's password and reactivates
 * it rather than failing, so it doubles as "I forgot the demo password".
 *
 * Usage:
 *   node --env-file=.env scripts/create-user.mjs <email> <password> [role-slug]
 *   npm run create-user -- someone@company.com 'a-real-password' super_admin
 *
 * role-slug defaults to super_admin, because the reason to run this is to get
 * into an app you cannot otherwise open — including its Admin module.
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_ROLE = 'super_admin';

const dbUrl = process.env.SUPABASE_DB_URL;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (process.env.NODE_ENV === 'production') {
  console.error('\nRefusing to run with NODE_ENV=production. Use the invite flow.\n');
  process.exit(1);
}

if (!dbUrl || !supabaseUrl || !serviceKey) {
  console.error(
    '\nNeeds SUPABASE_DB_URL, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' +
      '\nRun it as: node --env-file=.env scripts/create-user.mjs ...\n',
  );
  process.exit(1);
}

const [emailArg, password, roleSlug = DEFAULT_ROLE] = process.argv.slice(2);

if (!emailArg || !password) {
  console.error('\nUsage: node --env-file=.env scripts/create-user.mjs <email> <password> [role-slug]\n');
  process.exit(1);
}

// Lowercased and trimmed here for the same reason signup does it: `profiles.email`
// is citext, but the auth.users lookup is not, and a case mismatch would create a
// second auth user shadowing the first.
const email = emailArg.trim().toLowerCase();

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

/** The auth schema is not exposed through PostgREST, so this goes over SQL. */
async function findAuthUserId() {
  const { rows } = await client.query(`select id from auth.users where lower(email) = $1`, [email]);
  return rows[0]?.id ?? null;
}

async function main() {
  await client.connect();

  const { rows: roles } = await client.query(`select id, slug, is_admin from roles where slug = $1`, [
    roleSlug,
  ]);
  if (roles.length === 0) {
    const { rows: all } = await client.query(`select slug from roles order by slug`);
    console.error(`\nNo role "${roleSlug}". Available: ${all.map((r) => r.slug).join(', ')}\n`);
    process.exit(1);
  }
  const role = roles[0];

  const existingId = await findAuthUserId();

  if (existingId) {
    const { error } = await admin.auth.admin.updateUserById(existingId, {
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`password reset rejected: ${error.message}`);

    // The account may exist but be unable to hold a session — suspended, soft
    // deleted, or (from a half-finished run) missing its profile entirely.
    // `sessions_valid_from` moves to now for the same reason a real password
    // change bumps it: any token issued before this instant must stop working.
    await client.query(
      `insert into profiles (id, email, role_id, status, sessions_valid_from)
       values ($1, $2, $3, 'active', now())
       on conflict (id) do update
          set role_id = excluded.role_id,
              status = 'active',
              deleted_at = null,
              sessions_valid_from = now()`,
      [existingId, email, role.id],
    );

    console.log(`\nReset the password for ${email} (role ${role.slug}).`);
    console.log('Any session it already had is now invalid.\n');
    await client.end();
    return;
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // nothing proved control of this address; you chose it
  });
  if (createError || !created.user) {
    throw new Error(`user creation rejected: ${createError?.message ?? 'unknown'}`);
  }

  try {
    await client.query(`insert into profiles (id, email, role_id, status) values ($1, $2, $3, 'active')`, [
      created.user.id,
      email,
      role.id,
    ]);
  } catch (error) {
    // Never leave a login with no profile behind it.
    await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
    throw error;
  }

  console.log(`\nCreated ${email} as ${role.slug}${role.is_admin ? ' (admin)' : ''}.`);
  console.log('Sign in at /login with the password you passed.\n');
  await client.end();
}

main().catch(async (error) => {
  console.error('\nFailed:', error.message, '\n');
  await client.end().catch(() => {});
  process.exit(1);
});
