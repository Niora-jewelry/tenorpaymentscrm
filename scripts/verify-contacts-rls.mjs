/**
 * Attack the address book's RLS with two real signed-in users.
 *
 * Contacts are PRIVATE — that was the client's one-word answer, and privacy
 * that holds only because the UI does not offer a button is not privacy. Every
 * check below goes straight at PostgREST with a real user's token, bypassing
 * the app entirely, which is the only way to know.
 *
 * Run: node --env-file=.env scripts/verify-contacts-rls.mjs
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

const pass = [];
const fail = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(58)} ${actual}${ok ? '' : `   expected ${expected}`}`);
};

/** A real access token for an existing user, without touching their password. */
async function tokenFor(email) {
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink(${email}): ${error.message}`);
  const anon = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error: vErr } = await anon.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });
  if (vErr) throw new Error(`verifyOtp(${email}): ${vErr.message}`);
  return data.session.access_token;
}

const rest = (token) => async (path, init = {}) => {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
};

await db.connect();

// ── two real users ──────────────────────────────────────────────────────────
const { data: users } = await admin.auth.admin.listUsers();
const alice = users.users.find((u) => u.email === 'brimesh@tapdash.com');
const bob = users.users.find((u) => u.email === 'demo.rep@tapdash.test');
if (!alice || !bob) throw new Error('need two existing users to test with');

const A = rest(await tokenFor(alice.email));
const B = rest(await tokenFor(bob.email));

const TAG = 'ZZ_RLS_PROBE';
const cleanup = () =>
  db.query(`delete from phone_contacts where display_name like $1`, [`${TAG}%`]);
await cleanup();

console.log(`\nalice = ${alice.email}\nbob   = ${bob.email}\n`);

// ── 1. a contact each ───────────────────────────────────────────────────────
const mk = async (client, owner, name, e164) => {
  const c = await client('phone_contacts', {
    method: 'POST',
    body: JSON.stringify({ owner_id: owner, display_name: name }),
  });
  const id = Array.isArray(c.body) ? c.body[0]?.id : null;
  if (id) {
    await client('phone_contact_numbers', {
      method: 'POST',
      body: JSON.stringify({ contact_id: id, owner_id: owner, e164, is_primary: true }),
    });
  }
  return { status: c.status, id };
};

const aC = await mk(A, alice.id, `${TAG}_alice`, '+15550100001');
const bC = await mk(B, bob.id, `${TAG}_bob`, '+15550100002');
console.log('own contacts create:');
check('alice can create her own contact', aC.status, 201);
check('bob can create his own contact', bC.status, 201);

// ── 2. reading across the boundary ──────────────────────────────────────────
console.log('\nreading someone else\'s address book:');
const aSees = await A(`phone_contacts?select=id,display_name&display_name=like.${TAG}*`);
const names = (aSees.body ?? []).map((r) => r.display_name);
check('alice sees exactly her own contact', names.join(','), `${TAG}_alice`);
check("alice cannot see bob's contact", names.includes(`${TAG}_bob`) ? 'visible' : 'absent', 'absent');

const bNums = await B(`phone_contact_numbers?select=e164`);
const bList = (bNums.body ?? []).map((r) => r.e164);
check("bob cannot see alice's number", bList.includes('+15550100001') ? 'visible' : 'absent', 'absent');

// ── 3. writing across the boundary ──────────────────────────────────────────
console.log('\nwriting into someone else\'s address book:');
const plant = await A('phone_contacts', {
  method: 'POST',
  body: JSON.stringify({ owner_id: bob.id, display_name: `${TAG}_planted` }),
});
check('alice cannot create a contact owned by bob', plant.status >= 400 ? 'refused' : `allowed(${plant.status})`, 'refused');

const steal = await A(`phone_contacts?id=eq.${bC.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ display_name: `${TAG}_hijacked` }),
});
const stolen = Array.isArray(steal.body) && steal.body.length > 0;
check("alice cannot edit bob's contact", stolen ? 'MODIFIED' : 'refused', 'refused');

const giveAway = await A(`phone_contacts?id=eq.${aC.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ owner_id: bob.id }),
});
const gave = Array.isArray(giveAway.body) && giveAway.body.length > 0;
check('alice cannot hand her contact to bob', gave ? 'MOVED' : 'refused', 'refused');

const del = await A(`phone_contacts?id=eq.${bC.id}`, { method: 'DELETE' });
const deleted = Array.isArray(del.body) && del.body.length > 0;
check("alice cannot delete bob's contact", deleted ? 'DELETED' : 'refused', 'refused');

const addNum = await A('phone_contact_numbers', {
  method: 'POST',
  body: JSON.stringify({ contact_id: bC.id, owner_id: alice.id, e164: '+15550100003' }),
});
check("alice cannot add a number to bob's contact", addNum.status >= 400 ? 'refused' : `allowed(${addNum.status})`, 'refused');

// ── 4. the SECURITY DEFINER function ────────────────────────────────────────
console.log('\nensure_auto_contact, called as a person:');
const cross = await A('rpc/ensure_auto_contact', {
  method: 'POST',
  body: JSON.stringify({ p_owner_id: bob.id, p_e164: '+15550100009', p_record_id: null }),
});
check('alice cannot file a contact for bob', cross.status >= 400 ? 'refused' : `allowed(${cross.status})`, 'refused');

const own = await A('rpc/ensure_auto_contact', {
  method: 'POST',
  body: JSON.stringify({ p_owner_id: alice.id, p_e164: '+15550100010', p_record_id: null }),
});
check('unmatched number creates NO contact', own.body === null ? 'null' : String(own.body), 'null');

// ── 5. anon ─────────────────────────────────────────────────────────────────
console.log('\nsigned out:');
for (const t of ['phone_contacts', 'phone_contact_numbers']) {
  const res = await fetch(`${URL}/rest/v1/${t}?select=id`, { headers: { apikey: ANON } });
  const rows = res.ok ? await res.json() : null;
  check(`anon reads nothing from ${t}`, Array.isArray(rows) && rows.length ? 'ROWS' : 'nothing', 'nothing');
}

// ── 6. the constraint the automatic path depends on ─────────────────────────
console.log('\nduplicate protection:');
const dup = await A('phone_contact_numbers', {
  method: 'POST',
  body: JSON.stringify({ contact_id: aC.id, owner_id: alice.id, e164: '+15550100001' }),
});
check('the same number cannot be added twice for one owner', dup.status >= 400 ? 'refused' : `allowed(${dup.status})`, 'refused');

// ── 7. the client's rule: a contact never creates a record ──────────────────
console.log("\nthe client's one-way rule:");
const before = (await db.query('select count(*)::int n from records')).rows[0].n;
await mk(A, alice.id, `${TAG}_norecord`, '+15550100011');
const after = (await db.query('select count(*)::int n from records')).rows[0].n;
check('creating a contact creates no CRM record', after - before, 0);

await cleanup();
console.log(`\ncleaned up. ${pass.length} passed, ${fail.length} failed`);
await db.end();
process.exit(fail.length ? 1 : 0);
