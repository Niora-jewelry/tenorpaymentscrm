/**
 * Why can nobody sign in?
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────
 * Signing in has two halves, and they fail in ways that look identical from
 * the browser — you land back on the login page either way:
 *
 *   1. Supabase Auth (GoTrue) checks the password and issues a token.
 *   2. Every page then reads data through PostgREST using that token.
 *
 * If half 2 refuses the token, the app has no choice but to treat the visitor
 * as signed out and bounce them to /login. The password was correct, the
 * token is valid, and the screen says "sign in" — which is the most
 * misleading failure this stack can produce.
 *
 * This script does both halves separately and says which one broke, so the
 * next twenty minutes are spent in the right place.
 *
 * ── IT CREATES AND DELETES A SCRATCH ACCOUNT ─────────────────────────────
 * There is no way to test a real sign-in without a real credential, and
 * reusing a human's password is not an option. The account is created, used,
 * and deleted in the `finally`, so it does not survive a crash either.
 *
 * Run: node --env-file=.env scripts/diagnose-auth.mjs
 */
import { createClient } from '@supabase/supabase-js';

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA || !ANON || !SVC) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

const EMAIL = 'zz-auth-diagnostic@tapdash.test';
const PASSWORD = 'ZzAuthDiag-2026!x';

const ok = (s) => `  OK    ${s}`;
const bad = (s) => `  FAIL  ${s}`;

/** A JWT's payload, without verifying it — this is a diagnostic, not a gate. */
function claims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

function header(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  } catch {
    return null;
  }
}

const admin = createClient(SUPA, SVC, { auth: { persistSession: false } });
let uid = null;
let verdict = 0;

try {
  console.log(`\nProject: ${SUPA}`);
  console.log(
    `Publishable key: ${
      ANON.startsWith('sb_publishable') ? 'new format (sb_publishable_…)' : 'legacy JWT'
    }`,
  );

  /* ── 0. the service role, which bypasses user auth entirely ─────────── */
  console.log('\n0. The service-role key (used by server-side admin reads)');
  {
    const r = await fetch(`${SUPA}/rest/v1/modules?select=slug&limit=1`, {
      headers: { apikey: SVC, authorization: `Bearer ${SVC}` },
    });
    const c = claims(SVC);
    const age = c?.iat ? Math.round((Date.now() / 1000 - c.iat) / 86400) : null;
    console.log(
      r.ok
        ? ok(`PostgREST accepts it${age !== null ? ` (${header(SVC)?.alg}, issued ${age} days ago)` : ''}`)
        : bad(`PostgREST refused it: ${r.status} ${(await r.text()).slice(0, 90)}`),
    );
    if (!r.ok) verdict = 1;
  }

  /* ── 1. can Auth issue a token at all ───────────────────────────────── */
  console.log('\n1. Supabase Auth — password check and token issue');
  const created = await admin.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  uid = created.data.user.id;

  const signIn = await (
    await fetch(`${SUPA}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
  ).json();

  if (!signIn.access_token) {
    console.log(bad(`Auth refused the sign-in: ${JSON.stringify(signIn).slice(0, 140)}`));
    console.log('\n→ The problem is in Supabase Auth, not in the app.');
    verdict = 1;
  } else {
    const h = header(signIn.access_token);
    const c = claims(signIn.access_token);
    const drift = c.iat - Math.floor(Date.now() / 1000);
    console.log(ok(`Auth issued a token (${h?.alg}${h?.kid ? ', asymmetric signing key' : ', shared secret'})`));
    console.log(`        issued-at is ${drift >= 0 ? `${drift}s ahead of` : `${-drift}s behind`} this machine's clock`);

    /* ── 2. does Auth itself accept it back ──────────────────────────── */
    console.log('\n2. Supabase Auth — does it accept its own token back');
    const me = await fetch(`${SUPA}/auth/v1/user`, {
      headers: { apikey: ANON, authorization: `Bearer ${signIn.access_token}` },
    });
    console.log(me.ok ? ok('Yes — the token is genuine and correctly signed') : bad(`No: ${me.status}`));

    /* ── 3. the half that actually breaks ────────────────────────────── */
    console.log('\n3. PostgREST — the same token, used to read data');
    const r = await fetch(`${SUPA}/rest/v1/profiles?select=id&limit=1`, {
      headers: { apikey: ANON, authorization: `Bearer ${signIn.access_token}` },
    });
    const body = await r.text();

    if (r.ok) {
      console.log(ok('PostgREST accepts it — sign-in should work'));
    } else {
      console.log(bad(`PostgREST refused it: ${r.status} ${body.slice(0, 120)}`));
      verdict = 1;

      console.log('\n──────────────────────────────────────────────────────────');
      console.log('DIAGNOSIS');
      console.log('──────────────────────────────────────────────────────────');
      console.log('Auth is fine. Data access is not.');
      console.log('');
      console.log('The password is accepted and the token is valid — step 2');
      console.log('proves it — but every data read is refused, so the app has');
      console.log('no choice but to send the visitor back to the login page.');
      console.log('');
      console.log('Nothing in this repository can fix that: the refusal happens');
      console.log('inside Supabase, before any of our code runs. It is a project');
      console.log('setting or a platform fault.');

      if (body.includes('PGRST303')) {
        console.log('');
        console.log('The specific refusal is "JWT issued at future", which means');
        console.log('PostgREST thinks the token was issued after the current time.');
        console.log('Tokens live one hour, so if this persists past an hour of');
        console.log('token age, no session can ever work.');
      }
    }
  }
} catch (e) {
  console.error('\nThe diagnostic itself failed:', e instanceof Error ? e.message : e);
  verdict = 2;
} finally {
  if (uid) {
    await admin.auth.admin.deleteUser(uid).catch(() => {});
    console.log('\n(scratch account removed)');
  }
}

process.exit(verdict);
