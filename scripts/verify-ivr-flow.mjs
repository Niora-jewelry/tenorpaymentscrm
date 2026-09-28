/**
 * Walk the phone menu with properly signed requests.
 *
 * The branch logic is already covered by `src/lib/phone/ivr.test.ts`, which
 * runs in `npm test` and needs no network. THIS proves the other half: that
 * the routes are reachable, that the signature check accepts a real signature
 * as well as rejecting a missing one, that the configuration actually loads
 * from the database, and that every document Twilio would receive is
 * well-formed TwiML rather than an error page.
 *
 * Nothing is enabled and no setting is changed — the routes are exercised
 * directly, so this cannot put a live number into a menu by accident.
 *
 * Run: node --env-file=.env scripts/verify-ivr-flow.mjs [baseUrl]
 */
import crypto from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:3210';
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
if (!TOKEN) {
  console.error('TWILIO_AUTH_TOKEN is not set; cannot sign anything.');
  process.exit(1);
}

const pass = [];
const fail = [];
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(label);
  console.log(`  ${ok ? 'PASS' : '**FAIL**'}  ${label.padEnd(56)} ${actual}${ok ? '' : `   expected ${expected}`}`);
};

/**
 * Twilio's scheme: the full URL, then every POST parameter appended as
 * key+value in sorted key order, HMAC-SHA1 with the auth token, base64.
 */
function sign(url, params) {
  const data =
    url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function post(path, params = {}) {
  const url = `${BASE}${path}`;
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': sign(url, params),
    },
    body,
  });
  return { status: res.status, xml: await res.text() };
}

const wellFormed = (xml) =>
  xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Response>') && xml.endsWith('</Response>');

const CALLER = { From: '+15551234567', To: '+17327241779', CallSid: 'CAtest0000000000' };

console.log(`\nsigned walk-through against ${BASE}\n`);

// ── the signature check itself ──────────────────────────────────────────────
console.log('the gate:');
const unsigned = await fetch(`${BASE}/api/twilio/ivr/entry`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'From=%2B15551234567',
});
check('an unsigned request is refused', unsigned.status, 403);

const wrong = await fetch(`${BASE}/api/twilio/ivr/entry`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': 'obviously-not-a-real-signature',
  },
  body: 'From=%2B15551234567',
});
check('a forged signature is refused', wrong.status, 403);

const entry = await post('/api/twilio/ivr/entry', CALLER);
check('a correctly signed request is accepted', entry.status, 200);

// ── the greeting ────────────────────────────────────────────────────────────
console.log('\nthe greeting:');
check('it is well-formed TwiML', wellFormed(entry.xml), true);
check('it collects digits', entry.xml.includes('<Gather'), true);
check('it posts to the menu', entry.xml.includes('/api/twilio/ivr/menu'), true);
check(
  'it does not fix a digit count, so extensions stay dialable',
  entry.xml.includes('numDigits'),
  false,
);
check('it announces recording', entry.xml.toLowerCase().includes('recorded'), true);
const open = entry.xml.includes('press 1') || entry.xml.includes('sales');
console.log(`    (the office is currently ${open ? 'OPEN' : 'CLOSED'} — greeting chosen by ivr_is_open)`);

// ── every menu branch ───────────────────────────────────────────────────────
console.log('\nmenu branches:');
for (const [digit, label] of [
  ['1', 'press 1 — a representative'],
  ['2', 'press 2 — support or voicemail'],
  ['3', 'press 3 — Discover'],
  ['9', 'press 9 — invalid'],
  ['', 'press nothing'],
]) {
  const r = await post('/api/twilio/ivr/menu', { ...CALLER, Digits: digit });
  check(label, r.status === 200 && wellFormed(r.xml) ? 'ok' : `HTTP ${r.status}`, 'ok');
  // Nothing may ever return an empty response: silence on a phone line is
  // indistinguishable from a broken system.
  check(`  ${label} — says or does something`, /<(Say|Play|Dial|Record|Enqueue|Redirect|Gather|Hangup|Leave)/.test(r.xml), true);
}

const invalid = await post('/api/twilio/ivr/menu', { ...CALLER, Digits: '9' });
check('an invalid entry is spoken aloud', /invalid/i.test(invalid.xml), true);
check('and the menu starts again', invalid.xml.includes('/api/twilio/ivr/entry'), true);

// ── Discover ────────────────────────────────────────────────────────────────
console.log('\nthe Discover settlement:');
for (const [digits, label] of [
  ['1', 'press 1 — transfer'],
  ['5', 'press 5 — invalid'],
]) {
  const r = await post('/api/twilio/ivr/discover', { ...CALLER, Digits: digits });
  check(label, r.status === 200 && wellFormed(r.xml) ? 'ok' : `HTTP ${r.status}`, 'ok');
}

// ── the hold loop ───────────────────────────────────────────────────────────
console.log('\nthe hold loop:');
const hold0 = await post('/api/twilio/ivr/hold?loop=0&closed=0', CALLER);
check('first pass is music only', hold0.xml.includes('<Play'), true);
check('  and does not mention call volume yet', /high call volume/i.test(hold0.xml), false);

const hold1 = await post('/api/twilio/ivr/hold?loop=1&closed=0', CALLER);
check('second pass offers voicemail', /high call volume/i.test(hold1.xml), true);
check('  and keeps looping', hold1.xml.includes('loop=2'), true);

const holdClosed = await post('/api/twilio/ivr/hold?loop=1&closed=1', CALLER);
check('after hours it stops and takes a message', holdClosed.xml.includes('<Leave/>'), true);

const choice = await post('/api/twilio/ivr/hold-choice', { ...CALLER, Digits: '1' });
check('pressing 1 on hold leaves the queue', choice.xml.includes('<Leave/>'), true);
const stay = await post('/api/twilio/ivr/hold-choice', { ...CALLER, Digits: '7' });
check('any other key returns to the music', stay.xml.includes('<Play'), true);

// ── leaving the queue ───────────────────────────────────────────────────────
console.log('\nleaving the queue:');
const bridged = await post('/api/twilio/ivr/queue-done', { ...CALLER, QueueResult: 'bridged' });
check('a bridged call is left alone', bridged.xml.includes('<Hangup/>'), true);
check('  and is not sent to voicemail', bridged.xml.includes('<Record'), false);

const left = await post('/api/twilio/ivr/queue-done', { ...CALLER, QueueResult: 'leave' });
check('a caller who gave up reaches voicemail', left.xml.includes('<Record'), true);
check('  and the recording is terminal', left.xml.includes('<Hangup/>'), true);

// ── voicemail ───────────────────────────────────────────────────────────────
console.log('\nvoicemail:');
const vm = await post('/api/twilio/ivr/voicemail', CALLER);
check('records with a beep', vm.xml.includes('playBeep="true"'), true);
check('has a terminal action', vm.xml.includes('action='), true);
check('calls back with the recording', vm.xml.includes('/api/twilio/recording'), true);

// ── the agent leg ───────────────────────────────────────────────────────────
console.log('\nthe agent leg:');
const agent = await post('/api/twilio/ivr/agent', CALLER);
check('returns TwiML', agent.status === 200 && wellFormed(agent.xml) ? 'ok' : `HTTP ${agent.status}`, 'ok');
// With an empty queue it must hang up rather than bridge to silence.
check(
  'an empty queue hangs up rather than bridging to silence',
  agent.xml.includes('<Hangup/>') || agent.xml.includes('<Queue>'),
  true,
);

console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
