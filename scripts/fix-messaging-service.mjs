/**
 * Repoints the Twilio Messaging Service at this deployment.
 *
 * ── WHY THIS IS NEEDED ───────────────────────────────────────────────────
 * The numbers and the TwiML app were moved off Donny's cloudflared tunnels and
 * onto the Vercel URL. The MESSAGING SERVICE was not, and both numbers sit in
 * its sender pool:
 *
 *   inbound_request_url           https://nutritional-reserve-excerpt-rings
 *                                   .trycloudflare.com/api/twilio/message
 *   status_callback               (the same dead host)
 *   use_inbound_webhook_on_number false
 *
 * That last flag is the one that decides it. `false` means Twilio delivers
 * inbound messages to the SERVICE's URL and ignores the per-number `smsUrl` —
 * so fixing the numbers did not fix inbound texts, and every one of them is
 * being posted to a host that no longer resolves.
 *
 * ── WHAT IT SETS ─────────────────────────────────────────────────────────
 *   InboundRequestUrl  <base>/api/twilio/message
 *   StatusCallback     <base>/api/twilio/message-status
 *
 * The status callback is a DIFFERENT route from the inbound one. Both were
 * previously pointed at `/api/twilio/message`, which is the inbound handler and
 * does not update delivery state. `sendMessage` already passes its own
 * `statusCallback` carrying `?messageId=`, and a per-message callback takes
 * precedence over the service-level one, so this is the fallback for anything
 * sent without one — `/api/twilio/message-status` ignores a callback with no
 * messageId and returns 200, so the fallback is harmless either way.
 *
 * ── IT PRINTS THE OLD VALUES BEFORE CHANGING ANYTHING ────────────────────
 * This edits a live Twilio account. The previous values are printed first so a
 * rollback is a copy-paste, and `--dry-run` shows what would change without
 * sending anything.
 *
 * Usage:
 *   node --env-file=.env scripts/fix-messaging-service.mjs --dry-run
 *   node --env-file=.env scripts/fix-messaging-service.mjs
 *   node --env-file=.env scripts/fix-messaging-service.mjs --base https://staging.example.com
 */

const SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID ?? 'MGf70d7319fe8411610ae8a4ddbaee0c33';
const DEFAULT_BASE = 'https://tapdash-new-crm.vercel.app';

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
if (!sid || !token) {
  console.error('\nNeeds TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.');
  console.error('Run as: node --env-file=.env scripts/fix-messaging-service.mjs\n');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const baseArg = args.indexOf('--base');
const base = (baseArg !== -1 ? args[baseArg + 1] : DEFAULT_BASE)?.replace(/\/$/, '');
if (!base || !base.startsWith('https://')) {
  console.error(`\nBase URL must be https. Got: ${base}\n`);
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
const endpoint = `https://messaging.twilio.com/v1/Services/${SERVICE_SID}`;

const WANT = {
  InboundRequestUrl: `${base}/api/twilio/message`,
  InboundMethod: 'POST',
  StatusCallback: `${base}/api/twilio/message-status`,
};

const show = (label, s) => {
  console.log(`\n${label}`);
  for (const k of [
    'friendly_name',
    'inbound_request_url',
    'inbound_method',
    'status_callback',
    'use_inbound_webhook_on_number',
  ]) {
    console.log(`  ${k.padEnd(32)}: ${s[k] === '' || s[k] == null ? '(none)' : s[k]}`);
  }
};

async function main() {
  const readRes = await fetch(endpoint, { headers: { authorization: auth } });
  const before = await readRes.json();
  if (!readRes.ok) {
    console.error(`\nCould not read the service: HTTP ${readRes.status}`);
    console.error(JSON.stringify(before, null, 2));
    process.exit(1);
  }

  show(`BEFORE — Messaging Service ${SERVICE_SID}`, before);
  console.log('\nWILL SET');
  for (const [k, v] of Object.entries(WANT)) console.log(`  ${k.padEnd(32)}: ${v}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing sent.\n');
    return;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(WANT),
  });
  const after = await res.json();
  if (!res.ok) {
    console.error(`\nUpdate failed: HTTP ${res.status}`);
    console.error(JSON.stringify(after, null, 2));
    process.exit(1);
  }

  show('AFTER', after);

  const ok =
    after.inbound_request_url === WANT.InboundRequestUrl &&
    after.status_callback === WANT.StatusCallback;
  console.log(ok ? '\nDone — both URLs now point at this deployment.\n' : '\n⚠ Twilio accepted the request but the values do not match. Check above.\n');

  console.log('To roll back, re-run with the old values:');
  console.log(`  InboundRequestUrl = ${before.inbound_request_url}`);
  console.log(`  StatusCallback    = ${before.status_callback}\n`);
}

main().catch((e) => {
  console.error('\nFailed:', e.message, '\n');
  process.exit(1);
});
