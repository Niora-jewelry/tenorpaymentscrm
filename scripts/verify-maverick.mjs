/**
 * Maverick (client spec, 4 Nov 2026) through a real browser, as an admin and
 * as a member: the Reporting tab and its full-screen view, Cases › Other cases
 * with a processor ticket, the Maverick card on the Applications tab, the
 * Files tab's three send buttons, the unmatched flag, the connection page and
 * the Integrations switches and Help.
 *
 * Nothing is sent to Maverick and no sync runs. Processor rows are written
 * straight into the tables for one probe record; the probe record (and with it
 * every processor row, by cascade), the probe merchant and the probe sync
 * state are removed at the end and the counts compared.
 *
 *   npm run start -- -p 3222
 *   node --env-file=.env scripts/verify-maverick.mjs [base] [member email] [shots dir]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import net from 'node:net';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
const BASE = process.argv[2] || 'http://localhost:3222';
const MEMBER = process.argv[3];
if (!MEMBER) { console.log('usage: verify-maverick.mjs <base> <active member .test email> [shots]'); process.exit(1); }
const SHOTS = process.argv[4] || null;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
for (const e of [ADMIN, MEMBER]) if (!/@([a-z0-9-]+\.)*test$/i.test(e)) { console.log('test accounts only'); process.exit(1); }

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
const PW = 'ZzProbe-2026!maverick';
async function cookiesFor(email) {
  const [u] = await q(`select id from profiles where email=$1`, [email]);
  await svc.auth.admin.updateUserById(u.id, { password: PW });
  await q(`update profiles set last_seen_at = now() where id = $1`, [u.id]).catch(() => {});
  const { data, error } = await anon.auth.signInWithPassword({ email, password: PW });
  if (error) throw error;
  const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
  return { id: u.id, cookies: out };
}

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
const until = async (cond, ms = 45000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 500)); } return cond().catch(() => false); };

const snapshot = async () => Object.fromEntries(await Promise.all(
  ['records', 'processor_merchants', 'processor_transactions', 'processor_tickets', 'processor_sync_state', 'processor_applications', 'cases'].map(async (tb) => [tb, (await q(`select count(*)::int n from ${tb}`))[0].n]),
));
const before = await snapshot();
const hadMerchantState = (await q(`select 1 from processor_sync_state where processor='maverick' and data_type='merchants'`)).length > 0;

const contacts = (await q(`select id, slug from modules where slug='contacts'`))[0];
const tabs = Object.fromEntries((await q(`select key, shows_reporting, shows_applications, kind from tabs`)).map((r) => [r.key, r]));
const reportingKey = Object.values(tabs).find((x) => x.shows_reporting)?.key;
const applicationsKey = Object.values(tabs).find((x) => x.shows_applications)?.key;

const admin = await cookiesFor(ADMIN);
const member = await cookiesFor(MEMBER);
const perm = async (uid, key) => (await q(`select user_perm($1, $2) v`, [uid, key]))[0]?.v ?? null;
const memberPerms = Object.fromEntries(await Promise.all(['reporting.tab', 'maverick.status', 'maverick.other_cases', 'maverick.unmatched_flag', 'maverick.connection', 'maverick.resolve_unmatched'].map(async (k) => [k, await perm(member.id, k)])));

const tag = Math.random().toString(36).slice(2, 8);
const [probe] = await q(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, $3::jsonb) returning id`, [
  `ZZ maverick probe ${tag}`, admin.id, JSON.stringify({ legal_business_name: `ZZ Maverick Probe ${tag} LLC`, team_members_assigned: [admin.id, member.id] }),
]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, contacts.id, admin.id]);
await q(`insert into record_team_members (record_id, user_id) values ($1, $2), ($1, $3) on conflict do nothing`, [probe.id, admin.id, member.id]).catch(() => {});
const [merchant] = await q(`insert into processor_merchants (processor, external_id, mid, name, record_id) values ('maverick', $1, $2, $3, $4) returning id`, [`zz-${tag}`, `99${tag}`, `ZZ Probe ${tag}`, probe.id]);
const [lonely] = await q(`insert into processor_merchants (processor, external_id, mid, name) values ('maverick', $1, $2, $3) returning id`, [`zz-u-${tag}`, `98${tag}`, `ZZ Unmatched ${tag}`]);
for (let i = 0; i < 3; i++) {
  await q(`insert into processor_transactions (processor, merchant_id, record_id, external_id, card_type, card_brand, card_last4, amount, terminal_id, transaction_type, authorized_at, status)
           values ('maverick', $1, $2, $3, 'Credit', $4, $5, $6, 'T100', 'Sale', now() - ($7 || ' hours')::interval, 'Approved')`,
    [merchant.id, probe.id, `zz-tx-${tag}-${i}`, i === 2 ? 'Mastercard' : 'Visa', `424${i}`, 10 + i, String(i)]);
}
await q(`insert into processor_tickets (processor, merchant_id, record_id, external_id, title, status, details, opened_at)
         values ('maverick', $1, $2, $3, 'ZZ probe: terminal offline', 'Open', '[{"label":"Category","value":"Equipment"}]'::jsonb, now())`, [merchant.id, probe.id, `zz-tk-${tag}`]);
// The unmatched flag only shows once a merchants sync has succeeded.
if (!hadMerchantState) await q(`insert into processor_sync_state (processor, data_type, last_success_at, last_attempt_at) values ('maverick', 'merchants', now(), now())`);

const browser = await chromium.launch();
const errors = [];
async function open(cookies) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  return page;
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
const body = (page) => page.evaluate(() => document.body.innerText);
const go = (page, url) => page.goto(`${BASE}${url}`, { waitUntil: 'networkidle', timeout: 180000 });

try {
  const page = await open(admin.cookies);

  // ── Reporting ──────────────────────────────────────────────────────────
  t('setup: Reporting tab exists on Contacts', Boolean(reportingKey));
  await go(page, `/contacts?record=${probe.id}&tab=${reportingKey}`);
  t('admin: Reporting card', await until(() => page.getByRole('button', { name: /Open Reporting/ }).isVisible()));
  await shot(page, 'mav-1-reporting-card');
  await page.getByRole('button', { name: /Open Reporting/ }).click();
  t('admin: full-screen view opens', await until(() => page.getByRole('button', { name: /Back to record/ }).isVisible()));
  t('admin: transactions listed', await until(async () => (await body(page)).includes('4242') && (await body(page)).includes('4240')));
  await shot(page, 'mav-2-reporting-full');
  await page.getByRole('button', { name: /Back to record/ }).click();
  t('admin: back to record', await until(async () => !(await page.getByRole('button', { name: /Back to record/ }).isVisible())));

  // ── Other cases ────────────────────────────────────────────────────────
  await go(page, `/contacts?record=${probe.id}&tab=cases`);
  t('admin: Cases tab shows unsynced badge', await until(async () => /1 to sync/.test(await body(page))));
  const other = page.getByRole('tab', { name: /Other cases/ });
  t('admin: Cases | Other cases switch', await until(() => other.isVisible()));
  await other.click();
  t('admin: ticket listed', await until(async () => (await body(page)).includes('ZZ probe: terminal offline')));
  t('admin: Sync with a case offered', await page.getByRole('button', { name: /Sync with a case/ }).isVisible());
  await page.getByRole('button', { name: /Sync with a case/ }).click();
  t('admin: sync dialog opens', await until(() => page.getByRole('heading', { name: /Sync ticket/ }).isVisible()));
  await shot(page, 'mav-3-sync-dialog');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // ── Applications tab card ──────────────────────────────────────────────
  await go(page, `/contacts?record=${probe.id}&tab=${applicationsKey}`);
  t('admin: Maverick application card', await until(async () => /Maverick application/.test(await body(page))));
  t('admin: not-connected note', /not connected yet/.test(await body(page)));
  await go(page, `/contacts?record=${probe.id}&tab=files`);
  const check = page.getByRole('region', { name: 'Send documents' }).getByRole('button', { name: 'Preview' });
  if (await check.isVisible()) {
    await check.click();
    t('admin: pre-send check dialog lists problems', await until(async () => /Application data|need|missing/i.test(await body(page))));
    await shot(page, 'mav-4-precheck');
    await page.keyboard.press('Escape');
  } else t('admin: Maverick Preview button', false);

  // ── Files tab send bar ─────────────────────────────────────────────────
  await go(page, `/contacts?record=${probe.id}&tab=files`);
  const bar = await until(async () => /Application/.test(await body(page)) && /Proposal/.test(await body(page)) && /Acquiring agreement/.test(await body(page)) && /ACH agreement/.test(await body(page)) && /to Maverick|Update Maverick/.test(await body(page)));
  t('admin: Files tab has the send buttons', bar);
  await shot(page, 'mav-5-files-bar');

  // ── Vital Info + list flag ─────────────────────────────────────────────
  await go(page, `/contacts?record=${probe.id}`);
  // The eighth slot folds away with the others past the first few; unfold first.
  const showAll = page.getByRole('button', { name: /Show all/ }).first();
  if (await showAll.isVisible().catch(() => false)) await showAll.click();
  t('admin: Vital Info shows Maverick status', await until(async () => /Maverick status/.test(await body(page))));
  // The probe merchant is matched, but the record has no MID: flagged.
  t('admin: drawer shows the unmatched flag', /Not matched to Maverick/.test(await body(page)));
  await go(page, `/contacts?q=${encodeURIComponent(`ZZ maverick probe ${tag}`)}`);
  t('admin: list row carries the flag', await until(() => page.getByLabel('Not matched to Maverick').first().isVisible()));

  // ── Connection page ────────────────────────────────────────────────────
  // Since 6 Nov 2026 the connection lives in Integrations › Maverick Payments; the old address forwards there.
  await go(page, '/admin/maverick');
  t('admin: old address forwards to Integrations › Maverick', page.url().includes('/admin/integrations?tab=maverick'));
  const conn = await body(page);
  t('admin: Main connector shows health', /Each kind of data/.test(conn) && /Recent daily runs/.test(conn));
  await page.getByRole('tab', { name: 'Individual connectors' }).click();
  t('admin: unmatched merchant under Individual connectors', await until(async () => (await body(page)).includes(`ZZ Unmatched ${tag}`)));
  t('admin: no Maverick item in the menu', !(await page.getByRole('link', { name: 'Maverick', exact: true }).first().isVisible().catch(() => false)));
  await shot(page, 'mav-6-connection');

  // ── Integrations ───────────────────────────────────────────────────────
  await go(page, '/admin/integrations');
  const integ = await body(page);
  t('admin: Integrations lists Maverick', /Maverick/.test(integ));
  t('admin: on/off switches', (await page.getByRole('switch').count()) >= 4);
  const help = page.getByRole('button', { name: /Help/ }).first();
  await help.click();
  t('admin: Help panel opens with steps', await until(async () => /Where each value comes from/i.test(await body(page))));
  await shot(page, 'mav-7-integrations-help');

  // ── Automations trigger ────────────────────────────────────────────────
  // The builder's trigger list is client-side; the label is the contract.
  t('admin: no 5xx so far', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ── Member ─────────────────────────────────────────────────────────────
  const mp = await open(member.cookies);
  await go(mp, `/contacts?record=${probe.id}&tab=cases`);
  const mt = await body(mp);
  t(`member: Other cases ${memberPerms['maverick.other_cases'] === 'yes' ? 'shown' : 'absent'}`, (memberPerms['maverick.other_cases'] === 'yes') === /Other cases/.test(mt));
  await go(mp, `/contacts?record=${probe.id}`);
  t('member: signed in (not on the sign-in page)', !/\/login|Sign in/.test(mp.url()) && !/Welcome back/.test(await body(mp)));
  const mAll = mp.getByRole('button', { name: /Show all/ }).first();
  if (await mAll.isVisible().catch(() => false)) await mAll.click();
  const mv = await body(mp);
  t(`member: Maverick status ${memberPerms['maverick.status'] === 'yes' ? 'shown' : 'absent'}`, (memberPerms['maverick.status'] === 'yes') === /Maverick status/.test(mv));
  t(`member: unmatched flag ${memberPerms['maverick.unmatched_flag'] === 'yes' ? 'shown' : 'absent'}`, (memberPerms['maverick.unmatched_flag'] === 'yes') === /Not matched to Maverick/.test(mv));
  await go(mp, `/contacts?record=${probe.id}&tab=${reportingKey}`);
  const reportingShown = await until(() => mp.getByRole('button', { name: /Open Reporting/ }).isVisible(), 20000);
  t(`member: Reporting ${memberPerms['reporting.tab'] === 'view' ? 'shown' : 'absent'}`, (memberPerms['reporting.tab'] === 'view') === reportingShown);
  await go(mp, '/admin/maverick');
  const allowedConn = memberPerms['maverick.connection'] === 'yes' || memberPerms['maverick.resolve_unmatched'] === 'yes';
  t(`member: connection page ${allowedConn ? 'opens' : 'redirects'}`, allowedConn ? mp.url().includes('/admin/integrations') : !mp.url().includes('/admin/'));
  await shot(mp, 'mav-8-member');
  t('member perms read', true, JSON.stringify(memberPerms));
  t('no 5xx / page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close().catch(() => {});
  await db.query(`delete from records where id=$1`, [probe.id]);
  await db.query(`delete from processor_merchants where id = any($1::uuid[])`, [[merchant.id, lonely.id]]);
  if (!hadMerchantState) await db.query(`delete from processor_sync_state where processor='maverick' and data_type='merchants'`);
  const after = await snapshot();
  t('cleanup: counts back to start', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  await db.end();
  console.log(`PASS ${pass.length}`); for (const p of pass) console.log('  ✓', p);
  console.log(`FAIL ${fail.length}`); for (const f of fail) console.log('  ✗', f);
  process.exitCode = fail.length ? 1 : 0;
}
