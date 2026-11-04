/**
 * CRM Settings › Integrations, through a real browser, against the real providers.
 *
 * Run the server under test with NO provider keys in its environment, so anything
 * that works can only have come from what was entered on the screen:
 *
 *   TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= TWILIO_API_KEY_SID= TWILIO_API_KEY_SECRET= \
 *   TWILIO_TWIML_APP_SID= SIGNWELL_API_KEY= SIGNWELL_WEBHOOK_ID= SMTP_HOST= SMTP_USER= \
 *   SMTP_PASSWORD= npx next dev -p 3222
 *
 *   node --env-file=.env scripts/verify-integrations.mjs [base] [shots dir]
 *
 * The real keys are read from this script's own environment, typed into the form
 * and never printed. Providers are only read from: no call, email or document.
 * Twilio's success path needs live keys, so a sealed test token proves the webhooks
 * trust what is saved; the save itself is proved with SignWell's real key.
 * Everything it writes is removed by the end, and the table must finish empty.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import net from 'node:net';
import twilio from 'twilio';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
const BASE = process.argv[2] || 'http://localhost:3222';
const SHOTS = process.argv[3] || null;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const PW = 'ZzProbe-2026!page';
const env = process.env;

let FAKE_TOKEN = '';
const SECRETS = ['TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SECRET', 'SIGNWELL_API_KEY', 'SIGNWELL_WEBHOOK_ID', 'SMTP_PASSWORD'].map((k) => env[k]).filter(Boolean);

const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);
const one = async (s, p = []) => (await q(s, p))[0];

const svc = createClient(SUPA, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];

const started = (await one('select now() t')).t;
const me = await one('select id, email from profiles where email=$1', [ADMIN]);
const member = await one(
  `select p.id, p.email from profiles p join roles r on r.id = p.role_id
    where not r.is_admin and p.deleted_at is null and p.status='active' and p.email like '%@tapdash.test' order by p.email limit 1`,
);

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`${cond ? '  ok ' : 'FAIL '} ${label}`);
}
const noSecrets = (text) => SECRETS.every((s) => !text.includes(s));

const savedHashes = new Map();
async function sessionFor(user) {
  if (!savedHashes.has(user.id)) savedHashes.set(user.id, (await one('select encrypted_password p from auth.users where id=$1', [user.id])).p);
  await svc.auth.admin.updateUserById(user.id, { password: PW });
  await q('update profiles set last_seen_at = now() where id=$1', [user.id]);
  const { data, error } = await anon.auth.signInWithPassword({ email: user.email, password: PW });
  if (error) throw error;
  return data.session;
}
async function cookiesFor(user) {
  const session = await sessionFor(user);
  const v = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  const host = new URL(BASE).hostname;
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: host, path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: host, path: '/' });
  return out;
}

const statusUrl = () => `${new URL(BASE).origin.replace('http://', 'https://')}/api/twilio/status`;
async function signedPost(token) {
  const params = { CallStatus: 'completed' };
  const signature = token ? twilio.getExpectedTwilioSignature(token, statusUrl(), params) : 'bad-signature';
  const res = await fetch(`${BASE}/api/twilio/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature, 'x-forwarded-proto': 'https' },
    body: new URLSearchParams(params).toString(),
  });
  return res.status;
}

const template = await one(`select ut.template_id t from user_templates ut where ut.user_id=$1`, [member.id]);
const adminTemplate = await one(`select id from permission_templates where user_type='admin' limit 1`);

const browser = await chromium.launch();
const failures = [];

async function cleanup() {
  await q(`delete from integration_settings`);
  await q(`delete from integration_tests where tested_by=$1`, [me.id]);
  await q(`alter table integration_changes disable trigger integration_changes_append_only`);
  await q(`delete from integration_changes where actor_id=$1 and changed_at >= $2`, [me.id, started]);
  await q(`alter table integration_changes enable trigger integration_changes_append_only`);
  if (template) await q(`update user_templates set template_id=$1 where user_id=$2`, [template.t, member.id]);
  for (const [id, hash] of savedHashes) await q('update auth.users set encrypted_password=$1 where id=$2', [hash, id]);
}

try {
  const existing = (await one('select count(*)::int n from integration_settings')).n;
  if (existing > 0) throw new Error('integration_settings is not empty: real keys may be saved. Refusing to run.');

  /* ── no browser role can touch these tables ─────────────────────────────── */
  console.log('\nBrowser roles');
  const memberSession = await sessionFor(member);
  const asMember = createClient(SUPA, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${memberSession.access_token}` } } });
  const adminSession = await sessionFor(me);
  const asAdmin = createClient(SUPA, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${adminSession.access_token}` } } });
  for (const [who, client] of [['anon', anon], ['member', asMember], ['super admin', asAdmin]]) {
    for (const t of ['integration_settings', 'integration_tests', 'integration_changes']) {
      const { error } = await client.from(t).select('*').limit(1);
      ok(Boolean(error), `${who} cannot read ${t}`);
    }
    const { error: w } = await client.from('integration_settings').insert({ key: 'X', grp: 'twilio', sealed: 'x', iv: 'x', hint: 'x' });
    ok(Boolean(w), `${who} cannot write integration_settings`);
    const { error: r } = await client.rpc('integration_apply', { p_actor: me.id, p_group: 'twilio', p_set: [], p_remove: [], p_test_ok: null, p_test_note: null });
    ok(Boolean(r), `${who} cannot call integration_apply`);
  }

  /* ── ordinary member, then an Admin who is not a super admin ─────────────── */
  console.log('\nOther people');
  const mctx = await browser.newContext();
  await mctx.addCookies(await cookiesFor(member));
  const mp = await mctx.newPage();
  await mp.goto(`${BASE}/admin/integrations`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  if (template?.t !== adminTemplate.id) {
    const allowed = await one(`select user_perm($1, 'admin.integrations') v`, [member.id]);
    await mp.waitForURL((u) => !u.pathname.includes('/admin/integrations'), { timeout: 20000 }).catch(() => undefined);
    ok(allowed.v === 'yes' ? true : !mp.url().includes('/admin/integrations'), `a member without the page is sent away (their setting: ${allowed.v})`);
    ok((await mp.locator('section[aria-labelledby^="group-"]').count()) === 0 || allowed.v === 'yes', 'and sees none of the panel');
  }

  if (template) await q(`update user_templates set template_id=$1 where user_id=$2`, [adminTemplate.id, member.id]);
  await q(`update profiles set last_seen_at = now() where id=$1`, [member.id]);
  await mp.goto(`${BASE}/admin/integrations`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await mp.waitForSelector('h1:has-text("Integrations")', { timeout: 60000 });
  ok(await mp.getByText('Only a super admin can change these').isVisible(), 'an Admin is told only a super admin can change these');
  ok((await mp.locator('section[aria-labelledby^="group-"]').count()) === 4, 'an Admin sees the four services');
  ok((await mp.locator('section[aria-labelledby^="group-"] input').count()) === 0, 'an Admin gets no inputs');
  ok((await mp.getByRole('button', { name: /Replace|Add |Test connection|Test and save/ }).count()) === 0, 'an Admin gets no change buttons');
  ok(!(await mp.content()).includes('ending in'), 'an Admin sees no key details');
  if (SHOTS) await mp.screenshot({ path: `${SHOTS}/int-admin.png`, fullPage: true });
  await mctx.close();
  if (template) await q(`update user_templates set template_id=$1 where user_id=$2`, [template.t, member.id]);

  /* ── super admin, on a server with no keys of its own ───────────────────── */
  console.log('\nSuper admin: starting from nothing');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(await cookiesFor(me));
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  const open = async () => {
    await page.goto(`${BASE}/admin/integrations`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForSelector('section[aria-labelledby="group-twilio"]', { timeout: 60000 });
    await page.waitForTimeout(800);
  };
  await open();
  const group = (g) => page.locator(`section[aria-labelledby="group-${g}"]`);
  const type = async (g, label, value) => {
    const row = group(g);
    const add = row.getByRole('button', { name: new RegExp(`^(Add|Replace) ${label}$`) });
    if (await add.count()) await add.click();
    await row.getByLabel(new RegExp(`^${label}`)).fill(value);
  };
  const statusText = async (g) => {
    const s = group(g).locator('[role="status"]');
    await s.waitFor({ timeout: 45000 });
    return s.innerText();
  };

  // The status line appears when the action returns; the card redraws just after it.
  const eventually = async (check, ms = 20000) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(300)) if (await check()) return true;
    return false;
  };
  const waitStatus = async (g, re) => {
    const s = group(g).locator('[role="status"]');
    for (let i = 0; i < 120; i++) {
      const t = (await s.count()) ? await s.innerText() : '';
      if (re.test(t)) return t;
      await page.waitForTimeout(500);
    }
    const t = (await s.count()) ? await s.innerText() : '(nothing on screen)';
    throw new Error(`${g}: wanted ${re} but the screen says: ${noSecrets(t) ? t : '[held back]'}`);
  };

  ok((await group('twilio').getByText('Not connected').count()) === 1, 'Twilio starts Not connected on a server with no keys');
  ok((await signedPost(env.TWILIO_AUTH_TOKEN)) === 403, 'with no token anywhere, a correctly signed webhook is refused (fails closed)');

  console.log('\nTwilio');
  await type('twilio', 'Account SID', 'not-a-sid');
  await group('twilio').getByRole('button', { name: 'Test and save' }).click();
  ok((await statusText('twilio')).includes('starts with AC'), 'a badly shaped SID is refused with a plain message');
  ok((await one('select count(*)::int n from integration_settings')).n === 0, 'and nothing is saved');

  await type('twilio', 'Account SID', env.TWILIO_ACCOUNT_SID);
  await type('twilio', 'Auth token', 'wrongwrongwrongwrongwrongwrong12');
  await group('twilio').getByRole('button', { name: 'Test and save' }).click();
  await waitStatus('twilio', /refused/);
  const refused = await statusText('twilio');
  ok(refused.includes('Twilio refused') && refused.includes('Nothing was saved'), 'Twilio itself refuses a wrong token: nothing saved');
  ok((await one('select count(*)::int n from integration_settings')).n === 0, 'and the table is still empty');
  ok((await group('twilio').getByLabel(/^Auth token/).inputValue()) === 'wrongwrongwrongwrongwrongwrong12', 'what was typed stays, so a typo can be fixed');
  ok((await group('twilio').getByLabel(/^Auth token/).getAttribute('type')) === 'password', 'a secret is typed into a password box');

  await group('twilio').getByRole('button', { name: 'Cancel' }).first().click();
  await group('twilio').getByRole('button', { name: 'Cancel' }).first().click();

  // The token the phone webhooks trust, placed the way a save places it. Twilio would
  // refuse a made-up key at the door, and that door is tested above; this is what
  // happens behind it. The server gets no token from anywhere else.
  const seal = (key, value) => {
    const k = Buffer.from(hkdfSync('sha256', Buffer.from(env.LOGIN_ENC_KEY, 'utf8'), Buffer.alloc(0), 'tenor/integrations/v1', 32));
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', k, iv);
    c.setAAD(Buffer.from(key, 'utf8'));
    const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return { key, sealed: Buffer.concat([body, c.getAuthTag()]).toString('base64'), iv: iv.toString('base64'), hint: value.length >= 16 && /TOKEN|SECRET/.test(key) ? `ending in ${value.slice(-4)}` : value };
  };
  FAKE_TOKEN = `zz${randomBytes(15).toString('hex')}`;
  SECRETS.push(FAKE_TOKEN, 'zzFakeApiKeySecretValue9');
  const placed = [
    ['TWILIO_ACCOUNT_SID', `AC${'0'.repeat(32)}`],
    ['TWILIO_AUTH_TOKEN', FAKE_TOKEN],
    ['TWILIO_API_KEY_SID', `SK${'0'.repeat(32)}`],
    ['TWILIO_API_KEY_SECRET', 'zzFakeApiKeySecretValue9'],
    ['TWILIO_TWIML_APP_SID', `AP${'0'.repeat(32)}`],
  ].map(([k, v]) => seal(k, v));
  await q(`select integration_apply($1, 'twilio', $2::jsonb, '{}'::text[], null, null)`, [me.id, JSON.stringify(placed)]);
  console.log('      (waiting 31 s: a saved value reaches every instance within 30)');
  await page.waitForTimeout(31000);

  ok((await signedPost(FAKE_TOKEN)) === 200, 'THE SERVER HAS NO TOKEN IN ITS ENVIRONMENT, and a webhook signed with the saved one passes');
  ok((await signedPost(null)) === 403, 'a badly signed webhook is still refused');
  ok((await signedPost(env.TWILIO_AUTH_TOKEN)) === 403, 'one signed with a different token is still refused');
  ok((await signedPost('some-other-token-value')) === 403, 'and another');

  await open();
  ok((await group('twilio').getByText('Connected', { exact: true }).count()) === 1, 'Twilio now shows Connected');
  ok((await group('twilio').locator('input').count()) === 0, 'no form open: nothing to read back');
  ok(await group('twilio').getByText(`ending in ${FAKE_TOKEN.slice(-4)}`).isVisible(), 'a secret shows only its last four');
  ok(noSecrets(await page.content()), 'no secret anywhere in the page');
  const raw = await page.request.get(`${BASE}/admin/integrations`);
  ok(noSecrets(await raw.text()), 'no secret in the raw server response either');

  await group('twilio').getByRole('button', { name: 'Replace Auth token' }).click();
  ok((await group('twilio').getByLabel(/^Auth token/).inputValue()) === '', 'Replace opens empty: a saved key never comes back');
  await group('twilio').getByRole('button', { name: 'Cancel' }).click();
  ok((await group('twilio').locator('input').count()) === 0, 'Cancel closes it');

  await group('twilio').getByRole('button', { name: 'Test connection' }).click();
  ok((await waitStatus('twilio', /refused/)).includes('Twilio refused'), 'Test connection really asks Twilio, which refuses these');
  ok((await one(`select ok from integration_tests where grp='twilio'`)).ok === false, 'the failure is recorded');
  await open();
  ok((await group('twilio').getByText('Last test failed').count()) === 1, 'and the card says Last test failed, not Connected');
  ok(await group('twilio').getByText(/\/api\/twilio\/voice$/).first().isVisible(), 'the address to paste into Twilio is shown');
  await group('twilio').getByRole('button', { name: 'Copy' }).first().click();
  ok((await page.evaluate(() => navigator.clipboard.readText())).endsWith('/api/twilio/voice'), 'and copies');

  console.log('\nSignWell');
  await type('signwell', 'API key', 'wrong-key-wrong-key-wrong-key');
  await type('signwell', 'Webhook ID', 'abc123');
  await group('signwell').getByRole('button', { name: 'Test and save' }).click();
  await waitStatus('signwell', /refused/);
  ok((await one(`select count(*)::int n from integration_settings where grp='signwell'`)).n === 0, 'SignWell refuses a wrong key: nothing saved');
  await type('signwell', 'API key', env.SIGNWELL_API_KEY);
  await type('signwell', 'Webhook ID', env.SIGNWELL_WEBHOOK_ID);
  await group('signwell').getByRole('button', { name: 'Test and save' }).click();
  await waitStatus('signwell', /Saved\./);
  const sw = await statusText('signwell');
  const swRows = await q(`select key, sealed, hint from integration_settings where grp='signwell'`);
  ok(swRows.length === 2, 'a real key through the whole screen: tested by SignWell, then saved');
  ok(swRows.every((r) => noSecrets(r.sealed) && noSecrets(r.hint) && noSecrets(Buffer.from(r.sealed, 'base64').toString('latin1'))), 'no secret readable in the table, sealed or hint');
  const swLog = await q(`select hint from integration_changes where grp='signwell' and actor_id=$1 and changed_at >= $2`, [me.id, started]);
  ok(swLog.length === 2 && swLog.every((c) => noSecrets(c.hint ?? '')), 'two history rows, with no values');
  ok(await eventually(async () => (await group('signwell').getByText('Connected', { exact: true }).count()) === 1), 'SignWell shows Connected');
  ok((await group('signwell').locator('input').count()) === 0, 'the form closes once saved');
  ok(noSecrets(await page.content()), 'no secret anywhere in the page');
  ok(noSecrets(await (await page.request.get(`${BASE}/admin/integrations`)).text()), 'no secret in the raw server response');
  ok(sw.includes('not sending signing events to this site'), 'the real key is accepted, and it warns events do not come here yet');
  await group('signwell').getByRole('button', { name: 'Connect this site' }).click();
  await waitStatus('signwell', /live site/);
  ok(true, 'Connect this site refuses a local address: nothing registered with SignWell');
  await open();

  console.log('\nMicrosoft');
  await type('microsoft', 'Application \\(client\\) ID', '11111111-2222-3333-4444-555555555555');
  await type('microsoft', 'Client secret value', 'not-a-real-secret-not-a-real-secret');
  await group('microsoft').getByRole('button', { name: 'Test and save' }).click();
  await waitStatus('microsoft', /tenant/);
  ok((await statusText('microsoft')).includes('tenant'), 'without the tenant it says so, and does not call Microsoft');
  await type('microsoft', 'Directory \\(tenant\\) ID', '11111111-2222-3333-4444-555555555555');
  await group('microsoft').getByRole('button', { name: 'Test and save' }).click();
  await waitStatus('microsoft', /Microsoft (refused|cannot)/);
  ok((await one(`select count(*)::int n from integration_settings where grp='microsoft'`)).n === 0, 'Microsoft refuses made-up details: nothing saved');

  console.log('\nAlert email');
  await type('alerts', 'From line', 'not an address');
  await group('alerts').getByRole('button', { name: 'Test and save' }).click();
  await waitStatus('alerts', /Enter an address/);
  ok(true, 'a From line with no address is refused');
  await group('alerts').getByRole('button', { name: 'Cancel' }).click();
  await type('alerts', 'SMTP server', env.SMTP_HOST);
  await type('alerts', 'SMTP username', env.SMTP_USER);
  await type('alerts', 'SMTP password', 'wrongwrongwrongwrongwrongwrong');
  await group('alerts').getByRole('button', { name: 'Test and save' }).click();
  await waitStatus('alerts', /refused|Saved\./);
  ok((await statusText('alerts')).includes('Nothing was saved'), 'the SMTP server refuses a wrong password: nothing saved');

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/int-super.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll on a phone');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/int-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  console.log('\nHistory and removal');
  await open();
  await page.getByText('Change history').click();
  ok(await page.getByText(/Saved Twilio Auth token/).first().isVisible(), 'the change history shows what changed');
  ok(noSecrets(await page.content()), 'with no values');
  const appendOnly = await db.query(`update integration_changes set actor_name='x' where actor_id=$1`, [me.id]).then(() => false).catch(() => true);
  ok(appendOnly, 'the history cannot be edited, even by the database owner');

  await group('twilio').getByRole('button', { name: 'Remove Auth token' }).click();
  await page.getByRole('alert').getByRole('button', { name: 'Keep it' }).click();
  ok((await one(`select count(*)::int n from integration_settings where key='TWILIO_AUTH_TOKEN'`)).n === 1, '“Keep it” keeps it');
  await group('twilio').getByRole('button', { name: 'Remove Auth token' }).click();
  await page.getByRole('alert').getByRole('button', { name: 'Remove', exact: true }).click();
  await waitStatus('twilio', /Removed/);
  ok((await one(`select count(*)::int n from integration_settings where key='TWILIO_AUTH_TOKEN'`)).n === 0, 'Remove removes it');
  ok((await signedPost(FAKE_TOKEN)) === 403, 'and at once the webhook is refused again');
  ok(await eventually(async () => (await group('twilio').getByText('Not connected').count()) === 1), 'and Twilio shows Not connected');
  const removed = await one(`select count(*)::int n from integration_changes where action='removed' and key='TWILIO_AUTH_TOKEN' and changed_at >= $1`, [started]);
  ok(removed.n === 1, 'the removal is in the history');
  await ctx.close();

  /* ── the rest of the morning's work, on the same server ─────────────────── */
  console.log('\nRemoved fields and new logos');
  const fctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fctx.addCookies(await cookiesFor(me));
  const fp = await fctx.newPage();
  const place = await one(
    `select t.key tab, s.key subtab from fields f join subtabs s on s.id=f.subtab_id join tabs t on t.id=s.tab_id where f.key='td_gateway_monthly_mav'`,
  );
  const labels = (await q(`select label from fields where key in ('td_gateway_monthly_mav','td_gateway_setup_mav','td_gateway_per_update_mav','td_terminal_monthly_mav','td_terminal_setup_mav')`)).map((r) => r.label);
  ok(labels.length === 5, 'the five fields still exist, archived');
  const rec = await one(
    `select rm.record_id id, m.slug from record_modules rm join modules m on m.id=rm.module_id join records r on r.id=rm.record_id
      where r.deleted_at is null and not m.admin_only and m.slug <> 'records-list' order by m.position limit 1`,
  );
  ok(Boolean(place && rec), 'found Merchant Pricing and a record to open it on');
  await fp.goto(`${BASE}/${rec.slug}?record=${rec.id}&tab=${place.tab}&subtab=${place.subtab}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await fp.waitForSelector('[role="dialog"]', { timeout: 60000 });
  await fp.waitForTimeout(3000);
  const text = await fp.locator('[role="dialog"]').first().innerText();
  ok(/Pricing/i.test(text), 'Merchant Pricing opens');
  for (const l of labels) ok(!text.includes(l), `gone from the screen: ${l}`);
  if (SHOTS) await fp.screenshot({ path: `${SHOTS}/int-pricing.png` });
  const logo = fp.locator('aside img, nav img').first();
  if (await logo.count()) {
    const natural = await logo.evaluate((img) => img.naturalWidth);
    ok(natural > 0, 'the sidebar logo loads');
  }
  await fctx.close();

  const pub = await browser.newContext();
  const lp = await pub.newPage();
  await lp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await lp.waitForTimeout(1500);
  const loginLogo = lp.locator('img[alt="Tenor Payments"]').first();
  ok((await loginLogo.count()) === 1 && (await loginLogo.evaluate((i) => i.naturalWidth)) > 0, 'the sign-in page logo loads');
  if (SHOTS) await lp.screenshot({ path: `${SHOTS}/int-login.png` });
  await pub.close();
} catch (e) {
  fail += 1;
  failures.push(e);
  console.log('FAIL  stopped early:', e instanceof Error ? e.message.split('\n')[0] : 'error');
} finally {
  await browser.close();
  await cleanup();
  const left = (await one('select count(*)::int n from integration_settings')).n;
  const logLeft = (await one('select count(*)::int n from integration_changes where actor_id=$1 and changed_at >= $2', [me.id, started])).n;
  console.log(`\nLeft behind: ${left} saved keys, ${logLeft} history rows`);
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
