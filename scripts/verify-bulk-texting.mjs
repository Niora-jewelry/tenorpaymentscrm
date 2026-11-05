/**
 * Broadcast and group texting, end to end in a real browser, as an admin and as a
 * member, with the real Twilio SDK talking to `fake-twilio.cjs`. Proves the CRM's side
 * only: what real carriers do with a group text is not something this can show.
 *
 * Uses fictional 555-01xx numbers and `.test` accounts, and removes what it writes.
 * Prints shapes and pass or fail only.
 *
 *   FAKE_TWILIO_LOG=<file> NODE_OPTIONS="--require <path>/fake-twilio.cjs" npx next start -p 3221
 *   FAKE_TWILIO_LOG=<same file> node --env-file=.env --env-file=.env.local scripts/verify-bulk-texting.mjs
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
const require = createRequire(import.meta.url);
const { getExpectedTwilioSignature } = require('twilio/lib/webhooks/webhooks');

const BASE = process.argv[2] || 'http://localhost:3221';
const SHOTS = process.env.VERIFY_SHOTS_DIR ?? null;
const LOG = process.env.FAKE_TWILIO_LOG;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const MEMBER = 'itest-invited-1788686334823@tapdash.test';
if (!LOG) throw new Error('FAKE_TWILIO_LOG is required');

const LINE_ADMIN = '+12025550150';
const LINE_MEMBER = '+12025550151';
const A = '+12025550101';
const B = '+12025550102';
const OPTED_OUT = '+12025550103';
const NO_CONSENT = '+12025550104';
const D = '+12025550105';
const REFUSED = '+12025550199';
const TOLL_FREE = '+18005550101';
const CONSENTED = [A, B, D, REFUSED];
const NUMBERS = [A, B, OPTED_OUT, NO_CONSENT, D, REFUSED];

const db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 3 });
db.on('error', () => {});
const q = async (sql, params) => (await db.query(sql, params)).rows;
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];

const sessions = new Map();
async function cookiesFor(email) {
  const [u] = await q(`select id from profiles where email=$1`, [email]);
  await db.query(`update profiles set last_seen_at = now() where id=$1`, [u.id]);
  const password = randomBytes(24).toString('base64url');
  await svc.auth.admin.updateUserById(u.id, { password });
  await new Promise((r) => setTimeout(r, 1100));
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw error;
  sessions.set(email, data.session);
  const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
  return { id: u.id, cookies: out };
}

const fail = [];
let passed = 0;
const t = (n, ok, d = '') => {
  if (ok) passed += 1;
  else fail.push(n);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`);
};
const shot = async (page, name) => {
  if (SHOTS) await page.locator('[data-text-many]').screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {});
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    t(`${name} ran to the end`, false, String(e.message).split('\n')[0].slice(0, 200));
  }
};
const twilioLog = () => {
  try {
    return readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const clearLog = () => writeFileSync(LOG, '');
const until = async (fn, ms = 45000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
};

async function cleanup(ids) {
  await db.query(`delete from sms_groups where owner_id = any($1) or name like 'zz-%'`, [ids]);
  await db.query(`delete from sms_broadcasts where created_by = any($1)`, [ids]);
  await db.query(`delete from phone_messages where to_e164 = any($1) or from_e164 = any($1)`, [NUMBERS]);
  await db.query(`delete from sms_consents where e164 = any($1)`, [NUMBERS]);
  await db.query(`delete from phone_numbers where e164 = any($1)`, [[LINE_ADMIN, LINE_MEMBER]]);
  await db.query(`delete from phone_contacts where owner_id = any($1) and display_name like 'zz-%'`, [ids]);
  await db.query(`delete from permission_settings where owner_kind = 'user' and key = 'phone.bulk' and owner_id = any($1)`, [ids]);
  await db.query(`delete from notifications where recipient_id = any($1) and body like 'New text in the group zz-%'`, [ids]);
}

const tab = (page, name) => page.locator('[data-text-many]').getByRole('tab', { name });
const gotoPhone = async (page) => {
  await page.goto(`${BASE}/phone`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
};

async function reply(params, { sign = true } = {}) {
  const url = `${BASE}/api/twilio/group-message`;
  const signature = getExpectedTwilioSignature(sign ? process.env.TWILIO_AUTH_TOKEN : 'wrong', url, params);
  const res = await fetch(`${BASE}/api/twilio/group-message`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(params).toString(),
  });
  return res.status;
}

const browser = await chromium.launch();
const errors = [];
let ids = [];
try {
  const admin = await cookiesFor(ADMIN);
  const member = await cookiesFor(MEMBER);
  ids = [admin.id, member.id];
  await cleanup(ids);

  await db.query(`insert into phone_numbers (e164, kind, user_id, label, is_active) values ($1,'user',$2,'test',true), ($3,'user',$4,'test',true)`, [LINE_ADMIN, admin.id, LINE_MEMBER, member.id]);
  for (const n of [...CONSENTED, OPTED_OUT]) {
    await db.query(`insert into sms_consents (e164, source, consent_text) values ($1, 'verbal', 'zz test')`, [n]);
  }
  await db.query(`update sms_consents set revoked_at = now(), revoked_reason = 'zz test' where e164 = $1`, [OPTED_OUT]);
  const [contact] = await q(`insert into phone_contacts (owner_id, display_name, source) values ($1, 'zz-Picker Person', 'manual') returning id`, [admin.id]);
  await db.query(`insert into phone_contact_numbers (contact_id, owner_id, e164, is_primary) values ($1,$2,$3,true)`, [contact.id, admin.id, A]);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(admin.cookies);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));

  // ── Broadcast ─────────────────────────────────────────────────────────
  await step('broadcast', async () => {
    clearLog();
    await gotoPhone(page);
    const panel = page.locator('[data-text-many]');
    t('admin sees the panel', await panel.isVisible());
    t('page links down to it', await page.getByRole('link', { name: 'Broadcast and group texts' }).isVisible());
    const words = (await panel.innerText()).toLowerCase();
    t('no "delete" in the panel', !words.includes('delete'));

    await panel.getByLabel('Search contacts').first().fill('zz-picker');
    await panel.getByRole('checkbox').first().check();
    await panel.getByPlaceholder('One per line, or separated by commas').fill(
      [A, B, OPTED_OUT, NO_CONSENT, D, REFUSED, 'not a number', '12'].join('\n'),
    );
    await panel.locator('#broadcast-body').fill('zz test broadcast');
    await panel.getByRole('button', { name: 'Review recipients' }).click();
    const review = panel.locator('[data-broadcast-review]');
    await review.waitFor({ timeout: 15000 });
    const text = await review.innerText();
    t('review counts who will receive it', text.includes('4 people will receive this'), text.split('\n')[0]);
    t('review counts no consent', text.includes('1 number skipped: no texting consent'));
    t('review counts opted out', text.includes('1 number skipped: replied STOP'));
    t('review counts duplicates', text.includes('1 duplicate removed'));
    t('review names what is not a number', text.includes('not a number'));
    t('nothing sent by reviewing', twilioLog().length === 0);
    await shot(page, 'broadcast-review');

    await panel.getByRole('button', { name: 'Send to 4 people' }).click();
    await panel.getByText('Sending to 4 people').waitFor({ timeout: 15000 });

    const [b] = await q(`select id from sms_broadcasts where created_by=$1 order by created_at desc limit 1`, [admin.id]);
    const finished = await until(async () => (await q(`select status from sms_broadcasts where id=$1`, [b.id]))[0].status === 'finished');
    t('broadcast finishes', Boolean(finished));
    const rows = await q(`select e164, status, message_id, error, claimed_at from sms_broadcast_recipients where broadcast_id=$1 order by e164`, [b.id]);
    const of = (n) => rows.find((r) => r.e164 === n)?.status;
    t('consented numbers sent', of(A) === 'sent' && of(B) === 'sent' && of(D) === 'sent');
    t('opted out skipped', of(OPTED_OUT) === 'skipped_opted_out');
    t('no consent skipped', of(NO_CONSENT) === 'skipped_no_consent');
    t('refused number marked failed with the reason', of(REFUSED) === 'failed' && rows.find((r) => r.e164 === REFUSED).error.includes('refused'));

    const sent = twilioLog().filter((l) => l.path.endsWith('/Messages.json'));
    t('each number reached Twilio exactly once', sent.length === 4 && new Set(sent.map((l) => l.form.To)).size === 4, `${sent.length}`);
    t('never sent to the skipped numbers', !sent.some((l) => [OPTED_OUT, NO_CONSENT].includes(l.form.To)));
    t('from the sender’s own line', sent.every((l) => l.form.From === LINE_ADMIN));
    t('STOP line added', sent.every((l) => l.form.Body === 'zz test broadcast Reply STOP to opt out.'));
    t('delivery callback set', sent.every((l) => /\/api\/twilio\/message-status\?messageId=/.test(l.form.StatusCallback)));
    const gaps = sent.map((l) => l.at).sort((x, y) => x - y).slice(1).map((v, i, all) => v - (i ? all[i - 1] : sent.map((l) => l.at).sort((x, y) => x - y)[0]));
    t('paced at about one a second', gaps.every((g) => g >= 700), gaps.join(','));

    const msgs = await q(`select to_e164, status, owner_id, thread_key from phone_messages where from_e164=$1`, [LINE_ADMIN]);
    t('each text is a normal thread message', msgs.length === 4 && msgs.every((m) => m.owner_id === admin.id && m.thread_key === m.to_e164));
    t('the refused one reads failed', msgs.find((m) => m.to_e164 === REFUSED)?.status === 'failed');

    await gotoPhone(page);
    const row = panel.locator('[data-broadcast-row]').first();
    t('recent list shows the result', (await row.innerText()).includes('3 sent'));
    await row.getByRole('button', { name: 'Show who did not get it' }).click();
    await row.getByText('No consent on file').waitFor({ timeout: 10000 });
    t('who did not get it is listed', (await row.innerText()).includes('Replied STOP'));
    await shot(page, 'broadcast-result');
  });

  await step('stop a broadcast', async () => {
    const [b] = await q(`select sms_broadcast_create($1,$2,'zz stop me',$3,'{}','{}') id`, [admin.id, LINE_ADMIN, [A, B, D]]);
    await gotoPhone(page);
    const row = page.locator('[data-broadcast-row]').filter({ hasText: 'zz stop me' });
    await row.getByRole('button', { name: 'Stop sending' }).click();
    await row.getByRole('button', { name: 'Stop', exact: true }).click();
    const stopped = await until(async () => (await q(`select status from sms_broadcasts where id=$1`, [b.id]))[0].status === 'stopped', 10000);
    t('stop halts it', Boolean(stopped));
    const allCancelled = await until(async () => {
      const left = await q(`select status, count(*)::int n from sms_broadcast_recipients where broadcast_id=$1 group by 1`, [b.id]);
      return left.length === 1 && left[0].status === 'cancelled' && left[0].n === 3;
    }, 10000);
    t('nothing left queued', Boolean(allCancelled));
    const [c] = await q(`select count(*)::int n from sms_broadcast_claim()`);
    t('the worker has nothing to claim', c.n === 0);
  });

  // ── Group ─────────────────────────────────────────────────────────────
  let groupId = null;
  let conversation = null;
  await step('group', async () => {
    clearLog();
    await gotoPhone(page);
    const panel = page.locator('[data-text-many]');
    await tab(page, /Group texts/).click();

    const newGroup = panel.getByRole('button', { name: 'New group' });
    await newGroup.click();
    const form = panel.locator('[data-new-group]');
    await form.getByLabel('Name').fill('zz-refused');
    await form.getByPlaceholder('One per line').fill(`${A}\n${REFUSED}`);
    await form.getByRole('button', { name: 'Create group' }).click();
    await form.getByRole('alert').waitFor({ timeout: 20000 });
    t('a Twilio refusal is said plainly', (await form.getByRole('alert').innerText()).includes('Fake Twilio refused'));
    t('it leaves no group behind', (await q(`select 1 from sms_groups where name='zz-refused'`)).length === 0);
    t('and removes the conversation at Twilio', twilioLog().some((l) => l.method === 'DELETE' && /\/Conversations\/[^/]+$/.test(l.path)));

    await form.getByPlaceholder('One per line').fill(`${A}\n${TOLL_FREE}`);
    await form.getByRole('button', { name: 'Create group' }).click();
    await form.getByText('not toll-free').waitFor({ timeout: 15000 });
    t('toll-free refused before Twilio', true);

    await form.getByPlaceholder('One per line').fill(`${A}\n${OPTED_OUT}`);
    await form.getByRole('button', { name: 'Create group' }).click();
    await form.getByText('replied STOP').waitFor({ timeout: 15000 });
    t('opted out refused', true);

    await form.getByPlaceholder('One per line').fill(A);
    t('one person is too few', await form.getByRole('button', { name: 'Create group' }).isDisabled());

    clearLog();
    await form.getByLabel('Name').fill('zz-Sales team');
    await form.getByPlaceholder('One per line').fill(`${A}\n${B}`);
    await shot(page, 'group-new');
    await form.getByRole('button', { name: 'Create group' }).click();
    const convo = panel.locator('[data-group-conversation]');
    await convo.waitFor({ timeout: 20000 });
    const [g] = await q(`select id, twilio_conversation_sid sid, owner_id, from_e164 from sms_groups where name='zz-Sales team'`);
    groupId = g.id;
    conversation = g.sid;
    t('group saved with its conversation', Boolean(g.sid) && g.owner_id === admin.id && g.from_e164 === LINE_ADMIN);

    const log = twilioLog();
    t('conversation created first', log[0]?.path === '/v1/Conversations' && log[0]?.form.FriendlyName === 'zz-Sales team');
    const hook = log.find((l) => l.path.endsWith('/Webhooks'));
    t('a webhook scoped to this conversation', hook?.form.Target === 'webhook' && hook.form['Configuration.Url'].endsWith('/api/twilio/group-message') && hook.form['Configuration.Filters'] === 'onMessageAdded', JSON.stringify(hook?.form ?? {}).slice(0, 180));
    const parts = log.filter((l) => l.path.endsWith('/Participants'));
    t('CRM line joins first with the projected number', parts[0]?.form.Identity === `crm-${g.id}` && parts[0]?.form['MessagingBinding.ProjectedAddress'] === LINE_ADMIN, JSON.stringify(parts[0]?.form ?? {}).slice(0, 160));
    t('then each person with no proxy', parts.length === 3 && parts[1].form['MessagingBinding.Address'] === A && parts[2].form['MessagingBinding.Address'] === B && !parts[1].form['MessagingBinding.ProxyAddress']);

    await panel.getByRole('button', { name: 'New group' }).click();
    await form.getByLabel('Name').fill('zz-same people');
    await form.getByPlaceholder('One per line').fill(`${B}
${A}`);
    await form.getByRole('button', { name: 'Create group' }).click();
    await form.getByText('already have an open group').waitFor({ timeout: 15000 });
    t('the same people twice refused', (await q(`select 1 from sms_groups where name='zz-same people'`)).length === 0);
    await form.getByRole('button', { name: 'Cancel' }).click();

    clearLog();
    await convo.getByPlaceholder('Everyone in the group sees this').fill('zz hello group');
    await convo.getByRole('button', { name: 'Send', exact: true }).click();
    await convo.getByRole('list', { name: 'Messages' }).getByText('zz hello group').waitFor({ timeout: 15000 });
    const sent = twilioLog().find((l) => l.path === `/v1/Conversations/${g.sid}/Messages`);
    t('group message sent as the CRM line', sent?.form.Author === `crm-${g.id}` && sent?.form.Body === 'zz hello group');
    t('no 1-to-1 text used', !twilioLog().some((l) => l.path.endsWith('/Messages.json')));
    t('and stored with its Twilio id', (await q(`select status, twilio_message_sid s from sms_group_messages where group_id=$1`, [g.id]))[0]?.status === 'sent');
  });

  await step('group replies', async () => {
    if (!groupId) throw new Error('no group');
    const before = (await q(`select count(*)::int n from notifications where recipient_id=$1 and body like 'New text in the group zz-%'`, [admin.id]))[0].n;
    const params = { EventType: 'onMessageAdded', ConversationSid: conversation, MessageSid: 'IMfakeinbound0001', Author: A, Body: 'zz reply from A', Source: 'SMS' };
    t('bad signature refused', (await reply(params, { sign: false })) === 403);
    t('signed reply accepted', (await reply(params)) === 200);
    t('a retry is accepted too', (await reply(params)) === 200);
    const stored = await q(`select direction, author_e164, body, status from sms_group_messages where twilio_message_sid='IMfakeinbound0001'`);
    t('stored once', stored.length === 1 && stored[0].direction === 'in' && stored[0].author_e164 === A);
    const after = (await q(`select count(*)::int n from notifications where recipient_id=$1 and body like 'New text in the group zz-%'`, [admin.id]))[0].n;
    t('owner notified once', after === before + 1, `${before}->${after}`);

    t('the CRM’s own message ignored', (await reply({ ...params, MessageSid: 'IMfakeown', Source: 'API', Author: `crm-${groupId}` })) === 200 && (await q(`select 1 from sms_group_messages where twilio_message_sid='IMfakeown'`)).length === 0);
    t('an unknown conversation ignored', (await reply({ ...params, MessageSid: 'IMfakeother', ConversationSid: 'CHnope' })) === 200 && (await q(`select 1 from sms_group_messages where twilio_message_sid='IMfakeother'`)).length === 0);

    await gotoPhone(page);
    const convo = page.locator('[data-group-conversation]');
    await convo.getByRole('list', { name: 'Messages' }).getByText('zz reply from A').waitFor({ timeout: 15000 });
    t('reply shows with the sender', (await convo.innerText()).includes('(202) 555-0101') || (await convo.innerText()).includes('zz-Picker Person'));
    await shot(page, 'group-conversation');

    clearLog();
    t('STOP accepted', (await reply({ ...params, MessageSid: 'IMfakestop', Author: B, Body: 'STOP' })) === 200);
    const [memberB] = await q(`select removed_at, removed_reason from sms_group_members where group_id=$1 and e164=$2`, [groupId, B]);
    t('STOP takes them out of the group', Boolean(memberB.removed_at) && memberB.removed_reason === 'replied STOP');
    t('and removes them at Twilio', twilioLog().some((l) => l.method === 'DELETE' && l.path.includes('/Participants/')));
    t('and revokes consent', (await q(`select 1 from sms_consents where e164=$1 and revoked_at is null`, [B])).length === 0);
    await db.query(`insert into sms_consents (e164, source, consent_text) values ($1, 'verbal', 'zz test')`, [B]);

    await gotoPhone(page);
    const list = convo.getByRole('button', { name: '+ Add person' });
    await list.click();
    await convo.getByLabel('Number to add').fill(TOLL_FREE);
    await convo.getByRole('button', { name: 'Add', exact: true }).click();
    await convo.getByText('not toll-free').waitFor({ timeout: 15000 });
    t('adding a toll-free number refused', true);
    await convo.getByLabel('Number to add').fill(D);
    await convo.getByRole('button', { name: 'Add', exact: true }).click();
    await until(async () => (await q(`select 1 from sms_group_members where group_id=$1 and e164=$2 and removed_at is null`, [groupId, D])).length === 1, 15000);
    t('a person can be added', (await q(`select 1 from sms_group_members where group_id=$1 and e164=$2 and removed_at is null`, [groupId, D])).length === 1);

    await db.query(`update sms_consents set revoked_at = now(), revoked_reason = 'zz test' where e164 = $1`, [D]);
    clearLog();
    await convo.getByPlaceholder('Everyone in the group sees this').fill('zz after opt out');
    await convo.getByRole('button', { name: 'Send', exact: true }).click();
    await convo.getByRole('list', { name: 'Messages' }).getByText('zz after opt out').waitFor({ timeout: 15000 });
    t('someone who opted out elsewhere is dropped before sending', (await q(`select removed_reason r from sms_group_members where group_id=$1 and e164=$2`, [groupId, D]))[0]?.r === 'opted out');
    await db.query(`insert into sms_consents (e164, source, consent_text) values ($1, 'verbal', 'zz test')`, [D]);
  });

  // ── Member ────────────────────────────────────────────────────────────
  await step('member', async () => {
    const mctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mctx.addCookies(member.cookies);
    const mpage = await mctx.newPage();
    mpage.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));
    await gotoPhone(mpage);
    t('member without the setting sees no panel', !(await mpage.locator('[data-text-many]').isVisible()));

    const session = sessions.get(MEMBER);
    const asMember = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${session.access_token}` } } });
    t('RLS: another’s groups unreadable', ((await asMember.from('sms_groups').select('id')).data ?? []).length === 0);
    t('RLS: another’s messages unreadable', ((await asMember.from('sms_group_messages').select('id')).data ?? []).length === 0);
    t('RLS: another’s broadcasts unreadable', ((await asMember.from('sms_broadcasts').select('id')).data ?? []).length === 0);
    t('RLS: another’s recipients unreadable', ((await asMember.from('sms_broadcast_recipients').select('id')).data ?? []).length === 0);
    t('browser cannot write a group', Boolean((await asMember.from('sms_groups').insert({ name: 'zz-x', from_e164: LINE_MEMBER, owner_id: member.id })).error));
    t('browser cannot write a broadcast', Boolean((await asMember.from('sms_broadcasts').insert({ from_e164: LINE_MEMBER, body: 'x', total: 1, created_by: member.id })).error));
    t('browser cannot run the queue', Boolean((await asMember.rpc('sms_broadcast_claim')).error));
    t('browser cannot create a broadcast', Boolean((await asMember.rpc('sms_broadcast_create', { p_created_by: member.id, p_from: LINE_MEMBER, p_body: 'x', p_queued: [A], p_opted_out: [], p_no_consent: [] })).error));

    await db.query(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'phone.bulk', 'yes')`, [member.id]);
    await gotoPhone(mpage);
    const panel = mpage.locator('[data-text-many]');
    t('with the setting the panel appears', await panel.isVisible());
    await tab(mpage, /Group texts/).click();
    t('admin’s group is not listed', !(await panel.innerText()).includes('zz-Sales team'));
    await panel.getByRole('button', { name: 'New group' }).click();
    const form = panel.locator('[data-new-group]');
    await form.getByLabel('Name').fill('zz-Member group');
    await form.getByPlaceholder('One per line').fill(`${A}\n${D}`);
    await form.getByRole('button', { name: 'Create group' }).click();
    await panel.locator('[data-group-conversation]').waitFor({ timeout: 20000 });
    const [g] = await q(`select owner_id, from_e164 from sms_groups where name='zz-Member group'`);
    t('member’s group is theirs, on their line', g.owner_id === member.id && g.from_e164 === LINE_MEMBER);
    t('member reads their own group', ((await asMember.from('sms_groups').select('id')).data ?? []).length === 1);
    await mpage.setViewportSize({ width: 390, height: 800 });
    const wide = await mpage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    t('no sideways scroll at phone width', !wide);
    if (SHOTS) await mpage.locator('[data-text-many]').screenshot({ path: `${SHOTS}/group-phone-width.png` }).catch(() => {});
    await mctx.close();
  });

  await step('close', async () => {
    await gotoPhone(page);
    // The admin also sees the member's newer group, so choose this one by name.
    await page.locator('[data-text-many]').getByRole('button', { name: /zz-Sales team/ }).click();
    const convo = page.locator('[data-group-conversation]');
    await convo.getByRole('heading', { name: 'zz-Sales team' }).waitFor({ timeout: 10000 });
    clearLog();
    await convo.getByRole('button', { name: 'Close group' }).click();
    await convo.getByRole('button', { name: 'Close group' }).click();
    await until(async () => (await q(`select closed_at from sms_groups where id=$1`, [groupId]))[0]?.closed_at, 15000);
    t('closing sets the conversation closed at Twilio', twilioLog().some((l) => l.path === `/v1/Conversations/${conversation}` && l.form.State === 'closed'));
    await gotoPhone(page);
    await tab(page, /Group texts/).click();
    t('a closed group leaves the list', !(await page.locator('[data-text-many]').innerText()).includes('zz-Sales team'));
  });

  await step('cron route', async () => {
    t('cron without the secret refused', (await fetch(`${BASE}/api/phone/broadcast-tick`)).status === 401);
  });

  t('no browser errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  if (ids.length) await cleanup(ids);
  const left = await q(`select (select count(*)::int from sms_groups where name like 'zz-%') g, (select count(*)::int from phone_numbers where e164 = any($1)) n, (select count(*)::int from sms_consents where e164 = any($2)) c`, [[LINE_ADMIN, LINE_MEMBER], NUMBERS]);
  t('test data removed', left[0].g === 0 && left[0].n === 0 && left[0].c === 0);
  await browser.close();
  await db.end();
}
console.log(`\n${passed} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
