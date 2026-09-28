/**
 * The address book end to end, against the live database.
 *
 * Covers the three things the client asked for, in the order they happen:
 *   1. add / edit / remove a contact
 *   2. the automatic path — a number that matches a record files itself
 *   3. sync — calls, texts and recordings find the contact BY NUMBER,
 *      including ones that happened before the contact existed
 *
 * Everything runs as a real signed-in user through PostgREST, so RLS is in
 * force throughout. Scratch rows only, all prefixed ZZ_FLOW and removed at the
 * end — never a client record.
 *
 * Run: node --env-file=.env scripts/verify-contacts-flow.mjs
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
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(56)} ${actual}${ok ? '' : `   expected ${expected}`}`);
};

const NUM_A = '+15550199001';
const NUM_B = '+15550199002';
const TAG = 'ZZ_FLOW';

await db.connect();

const { data: users } = await admin.auth.admin.listUsers();
const me = users.users.find((u) => u.email === 'brimesh@tapdash.com');
if (!me) throw new Error('no user to test with');

const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: me.email });
const anonClient = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
const { data: v } = await anonClient.auth.verifyOtp({
  type: 'magiclink',
  token_hash: link.properties.hashed_token,
});
const token = v.session.access_token;

const rest = async (path, init = {}) => {
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

async function cleanup() {
  await db.query(`delete from phone_contacts where display_name like $1`, [`${TAG}%`]);
  await db.query(`delete from phone_calls where from_e164 = any($1) or to_e164 = any($1)`, [[NUM_A, NUM_B]]);
  await db.query(`delete from phone_messages where thread_key = any($1)`, [[NUM_A, NUM_B]]);
}
await cleanup();

console.log(`\nacting as ${me.email}\n`);

// ── history FIRST, before any contact exists ────────────────────────────────
// This is the point of matching by number: these must be found later.
console.log('history that predates the contact:');
const callRow = await db.query(
  `insert into phone_calls (direction, from_e164, to_e164, status, owner_id, started_at, duration_seconds)
   values ('in', $1, '+17327241779', 'completed', $2, now() - interval '2 days', 95)
   returning id`,
  [NUM_A, me.id],
);
await db.query(
  `insert into phone_recordings (call_id, kind, twilio_recording_sid, storage_path, duration_seconds)
   values ($1, 'call', $2, $3, 95)`,
  [callRow.rows[0].id, `RE${TAG}${Date.now()}`, `recordings/${TAG}.mp3`],
);
await db.query(
  `insert into phone_messages (thread_key, direction, from_e164, to_e164, body, status, owner_id, sent_at)
   values ($1, 'in', $1, '+17327241779', 'Message sent before the contact existed', 'received', $2, now() - interval '2 days')`,
  [NUM_A, me.id],
);
check('a call, a recording and a text exist', 'seeded', 'seeded');

// ── 1. add ──────────────────────────────────────────────────────────────────
console.log('\nadd:');
const created = await rest('phone_contacts', {
  method: 'POST',
  body: JSON.stringify({ owner_id: me.id, display_name: `${TAG}_Jane`, company: 'Cohen Hardware' }),
});
const contactId = created.body?.[0]?.id;
check('contact created', created.status, 201);

const numRes = await rest('phone_contact_numbers', {
  method: 'POST',
  body: JSON.stringify({ contact_id: contactId, owner_id: me.id, e164: NUM_A, is_primary: true }),
});
check('primary number attached', numRes.status, 201);
check('no CRM record was created', (await db.query(
  `select count(*)::int n from records where values->>'deal_name' like $1`, [`${TAG}%`],
)).rows[0].n, 0);

// ── 2. sync, by number ──────────────────────────────────────────────────────
console.log('\nsync (matched by number, not by a stored link):');
/*
 * Through supabase-js, with the SAME query shape `lib/phone/contacts.ts`
 * uses - deliberately not a hand-built URL. A '+' in a query string decodes
 * to a space, so `from_e164.eq.+1555...` silently becomes a search for
 * ' 1555...' and finds nothing. Every number here is E.164, so that trap is
 * one typo away at all times; testing through the real client is what proves
 * the app itself is not standing in it.
 */
const asUser = createClient(URL, ANON, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { headers: { authorization: `Bearer ${token}` } },
});

const { data: callsData, error: callsErr } = await asUser
  .from('phone_calls')
  .select('id, duration_seconds, phone_recordings (id, kind, storage_path)')
  .or(`from_e164.in.(${NUM_A}),to_e164.in.(${NUM_A})`)
  .is('deleted_at', null);
if (callsErr) console.log('    calls query error:', callsErr.message);
check('the earlier call is found', (callsData ?? []).length, 1);
check('its recording comes with it', (callsData?.[0]?.phone_recordings ?? []).length, 1);

const { data: msgData, error: msgErr } = await asUser
  .from('phone_messages')
  .select('id, body')
  .in('thread_key', [NUM_A])
  .is('deleted_at', null);
if (msgErr) console.log('    messages query error:', msgErr.message);
check('the earlier text is found', (msgData ?? []).length, 1);

// ── 3. a second number brings its own history ───────────────────────────────
console.log('\na second number brings its history with it:');
await db.query(
  `insert into phone_messages (thread_key, direction, from_e164, to_e164, body, status, owner_id, sent_at)
   values ($1, 'out', '+17327241779', $1, 'To the desk line', 'sent', $2, now())`,
  [NUM_B, me.id],
);
await rest('phone_contact_numbers', {
  method: 'POST',
  body: JSON.stringify({ contact_id: contactId, owner_id: me.id, e164: NUM_B, label: 'Desk' }),
});
const { data: bothData } = await asUser
  .from('phone_messages')
  .select('id')
  .in('thread_key', [NUM_A, NUM_B])
  .is('deleted_at', null);
check('both numbers now resolve to this contact', (bothData ?? []).length, 2);

// ── 4. edit ─────────────────────────────────────────────────────────────────
console.log('\nedit:');
const edited = await rest(`phone_contacts?id=eq.${contactId}`, {
  method: 'PATCH',
  body: JSON.stringify({ display_name: `${TAG}_Jane_Cohen`, notes: 'Prefers texts after 4pm' }),
});
check('name and notes updated', edited.body?.[0]?.display_name, `${TAG}_Jane_Cohen`);
const touched = await db.query(
  `select updated_at > created_at as t from phone_contacts where id = $1`, [contactId],
);
check('updated_at moved (the trigger fired)', touched.rows[0].t, true);

// ── 5. the automatic path ───────────────────────────────────────────────────
console.log('\nthe automatic path:');
const rec = await db.query(
  `select r.id from records r where r.deleted_at is null and coalesce(r.values->>'deal_name','') <> '' limit 1`,
);
const realRecordId = rec.rows[0]?.id ?? null;

const auto = await rest('rpc/ensure_auto_contact', {
  method: 'POST',
  body: JSON.stringify({ p_owner_id: me.id, p_e164: '+15550199003', p_record_id: realRecordId }),
});
const autoId = auto.body;
check('a matched number files itself', autoId ? 'created' : 'nothing', 'created');
if (autoId) {
  const row = await db.query(`select source, record_id from phone_contacts where id = $1`, [autoId]);
  check("it is marked 'auto'", row.rows[0]?.source, 'auto');
  check('it is linked to the record', row.rows[0]?.record_id ? 'linked' : 'null', 'linked');
}

const again = await rest('rpc/ensure_auto_contact', {
  method: 'POST',
  body: JSON.stringify({ p_owner_id: me.id, p_e164: '+15550199003', p_record_id: realRecordId }),
});
check('calling it twice makes only one contact', again.body === autoId ? 'same' : 'DUPLICATE', 'same');

const unmatched = await rest('rpc/ensure_auto_contact', {
  method: 'POST',
  body: JSON.stringify({ p_owner_id: me.id, p_e164: '+15550199004', p_record_id: null }),
});
check('an unmatched number files nothing', unmatched.body === null ? 'null' : 'CREATED', 'null');

// ── 6. remove ───────────────────────────────────────────────────────────────
console.log('\nremove:');
const removed = await rest(`phone_contacts?id=eq.${contactId}`, { method: 'DELETE' });
check('contact removed', (removed.body ?? []).length, 1);
const orphanNums = await db.query(
  `select count(*)::int n from phone_contact_numbers where contact_id = $1`, [contactId],
);
check('its numbers went with it', orphanNums.rows[0].n, 0);

const survivingCalls = await db.query(
  `select count(*)::int n from phone_calls where from_e164 = $1`, [NUM_A],
);
check('the call survives the contact', survivingCalls.rows[0].n, 1);
const survivingMsgs = await db.query(
  `select count(*)::int n from phone_messages where thread_key = $1`, [NUM_A],
);
check('the text survives the contact', survivingMsgs.rows[0].n, 1);

// ── tidy ────────────────────────────────────────────────────────────────────
await db.query(`delete from phone_contacts where owner_id = $1 and id = $2`, [me.id, autoId]);
await db.query(`delete from phone_contacts where display_name like $1`, [`${TAG}%`]);
await cleanup();

console.log(`\ncleaned up. ${pass.length} passed, ${fail.length} failed`);
await db.end();
process.exit(fail.length ? 1 : 0);
