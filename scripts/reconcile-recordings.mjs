/**
 * Find recordings that are still on Twilio but never made it into our storage.
 *
 * ── WHY THIS IS NEEDED, EXACTLY ──────────────────────────────────────────
 * `/api/twilio/recording` deletes the Twilio-side copy only after a CONFIRMED
 * store — download, upload, insert, then delete. That ordering is right: it can
 * never destroy the only copy of a call.
 *
 * But the route also answers 200 on every handled failure, deliberately, so a
 * 5xx cannot make Twilio retry-storm it. The cost of that choice is that a
 * transient download or upload failure is NOT retried, and the recording is
 * then left on Twilio with no row here and nothing to notice it.
 *
 * Asked whether Twilio had any retention or lifecycle rule configured, Donny's
 * answer was no — "nothing was set up through Twilio regarding recordings,
 * everything relevant is done through the code". So there is no safety net on
 * the other side either: an orphan sits there forever, quietly billed, and the
 * call it belongs to shows no recording in the CRM.
 *
 * This is the reconciliation sweep his notes deferred. Run it periodically, or
 * whenever someone says a recording is missing.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────
 * It never deletes anything on Twilio. It reports, and with --repair it pulls
 * the missing audio into our bucket and inserts the row — the same work the
 * webhook would have done. Deleting the Twilio copy is left to the webhook's
 * own path so there is exactly one place that decides a recording is safely
 * stored.
 *
 * Usage:
 *   node --env-file=.env scripts/reconcile-recordings.mjs           # report
 *   node --env-file=.env scripts/reconcile-recordings.mjs --repair  # backfill
 */
import pg from 'pg';
import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

const REPAIR = process.argv.includes('--repair');
const BUCKET = 'phone-recordings';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  console.error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set.');
  process.exit(1);
}

const db = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await db.connect();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const client = twilio(accountSid, authToken);

// Everything Twilio still holds. If the webhook did its job this list is
// empty or near-empty — a recording lingers only between the call ending and
// the callback completing.
const remote = await client.recordings.list({ limit: 1000 });
console.log(`Twilio still holds ${remote.length} recording(s).`);

if (remote.length === 0) {
  console.log('Nothing to reconcile.');
  await db.end();
  process.exit(0);
}

const { rows: known } = await db.query(
  `select twilio_recording_sid from phone_recordings where twilio_recording_sid is not null`,
);
const knownSids = new Set(known.map((r) => r.twilio_recording_sid));

const orphans = remote.filter((r) => !knownSids.has(r.sid));
console.log(`${orphans.length} of those have NO row here.`);

if (orphans.length === 0) {
  console.log('\nEvery Twilio-side recording is already stored. They are simply awaiting deletion');
  console.log('by their own callback, which is normal for a call that just ended.');
  await db.end();
  process.exit(0);
}

let repaired = 0;
let unmatched = 0;

for (const rec of orphans) {
  // Correlate by the call SID, which /api/twilio/status backfills onto the row.
  // An orphan whose call we cannot identify is reported, never guessed at.
  const { rows } = await db.query(
    `select id from phone_calls where twilio_call_sid = $1 and deleted_at is null limit 1`,
    [rec.callSid],
  );
  const callRowId = rows[0]?.id ?? null;

  if (!callRowId) {
    unmatched += 1;
    console.log(`  ⚠ ${rec.sid} — no phone_calls row for CallSid ${rec.callSid}`);
    continue;
  }

  console.log(`  ${REPAIR ? 'repairing' : 'would repair'} ${rec.sid} → call ${callRowId}`);
  if (!REPAIR) continue;

  const mp3Url = `https://api.twilio.com${rec.uri.replace('.json', '')}.mp3`;
  const basic = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const res = await fetch(mp3Url, { headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) {
    console.log(`    download failed: ${res.status}`);
    continue;
  }
  const audio = Buffer.from(await res.arrayBuffer());
  const storagePath = `calls/${callRowId}/${rec.sid}.mp3`;

  const upload = await supabase.storage.from(BUCKET).upload(storagePath, audio, {
    contentType: 'audio/mpeg',
    upsert: true,
  });
  if (upload.error) {
    console.log(`    upload failed: ${upload.error.message}`);
    continue;
  }

  await db.query(
    `insert into phone_recordings (call_id, kind, storage_path, twilio_recording_sid, duration_seconds)
     values ($1, 'call', $2, $3, $4)
     on conflict do nothing`,
    [callRowId, storagePath, rec.sid, rec.duration ? Number(rec.duration) : null],
  );
  repaired += 1;
}

console.log();
if (REPAIR) {
  console.log(`${repaired} recording(s) pulled into storage.`);
  console.log('Their Twilio-side copies were left in place — deleting is the webhook\'s job,');
  console.log('so exactly one code path decides a recording is safely stored.');
} else {
  console.log('Dry run. Re-run with --repair to pull the missing audio in.');
}
if (unmatched) {
  console.log(`${unmatched} could not be matched to a call and need looking at by hand.`);
}

await db.end();
