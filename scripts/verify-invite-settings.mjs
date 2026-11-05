/**
 * Module access on the invite, and the Merchant Gateway and Terminal fields being gone,
 * end to end in a real browser: as an admin, then as the person who was invited.
 *
 * Writes one invite for a `.test` address, one account for it, and one probe record, and
 * removes them at the end. Sends no email: the dialog is closed without sending. The
 * permission audit entries stay behind by design, because that log is append-only.
 *
 * Prints shapes and pass or fail only, never a person's data.
 *
 *   NODE_OPTIONS=--max-old-space-size=4096 npx next start -p 3221
 *   node --env-file=.env scripts/verify-invite-settings.mjs
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const BASE = process.argv[2] || 'http://localhost:3221';
const SHOTS = process.env.VERIFY_SHOTS_DIR ?? null;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const MEMBER = 'itest-invited-1788686334823@tapdash.test';
const tag = randomBytes(4).toString('hex');
const INVITED = `zz-invite-settings-${tag}@tapdash.test`;
for (const e of [ADMIN, MEMBER, INVITED]) if (!/@([a-z0-9-]+\.)*test$/i.test(e)) process.exit(1);

const db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 3 });
db.on('error', () => {});
const q = async (sql, params) => (await db.query(sql, params)).rows;
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const ref = new URL(SUPA).hostname.split('.')[0];
const seenBefore = new Map();
async function cookiesFor(email) {
  const [u] = await q(`select id, last_seen_at from profiles where email=$1`, [email]);
  if (!seenBefore.has(u.id)) seenBefore.set(u.id, u.last_seen_at);
  await db.query(`update profiles set last_seen_at = now() where id=$1`, [u.id]);
  // Random each run: a password written in this script would be a working login on a
  // public repository.
  const password = randomBytes(24).toString('base64url');
  await svc.auth.admin.updateUserById(u.id, { password });
  await new Promise((r) => setTimeout(r, 1100));
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
  return { id: u.id, cookies: out };
}

const pass = [];
const fail = [];
const t = (n, ok, d = '') => {
  (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`);
};
let lastPage = null;
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {});
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    const m = String(e?.message ?? e).split('\n')[0].slice(0, 300);
    fail.push(`${name} threw: ${m}`);
    console.log(`THREW ${name}: ${m}`);
    if (lastPage) await shot(lastPage, `fail-${name.replace(/[^a-z0-9]+/gi, '-')}`);
  }
};
const refused = async (sql, params) => {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return String(e.message);
  }
};

const counts = async () => (await q(`select
  (select count(*)::int from invites) invites,
  (select count(*)::int from profiles) profiles,
  (select count(*)::int from permission_settings) settings,
  (select count(*)::int from records) records`))[0];
const before = await counts();
const REMOVED = ['td_gateway_provider_mav', 'td_gateway_per_item_mav', 'td_gateway_auth_fee_mav', 'td_terminal_provider_mav', 'td_terminal_per_item_mav', 'td_terminal_auth_fee_mav'];
const hasValue = (k) => `coalesce(btrim("values"->>'${k}'), '') <> ''`;
const valuesBefore = (await q(`select count(*)::int n from records where ${REMOVED.map(hasValue).join(' or ')}`))[0].n;

const admin = await cookiesFor(ADMIN);
const member = await cookiesFor(MEMBER);
const mods = await q(`select id, slug, label from modules`);
const mod = (slug) => mods.find((m) => m.slug === slug);
const leads = mod('leads');
const deals = mod('deals');
const contacts = mod('contacts');

const pricing = (await q(`select t.key tab, s.key subtab from subtabs s join tabs t on t.id = s.tab_id where s.key = 'td_merchant'`))[0];
const NAME = `ZZ invite probe ${tag}`;
const [probe] = await q(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, '{}'::jsonb) returning id`, [NAME, admin.id]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, mod('contacts').id, admin.id]);

const browser = await chromium.launch();
const watchdog = setTimeout(() => {
  fail.push('watchdog: the run took over 20 minutes');
  void browser.close();
}, 20 * 60 * 1000);
const errors = [];
async function session(cookies) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  ctx.setDefaultTimeout(25000);
  ctx.setDefaultNavigationTimeout(180000);
  await ctx.addCookies(cookies);
  await ctx.route('**://*.posthog.com/**', (r) => r.abort());
  const page = await ctx.newPage();
  page.inflight = 0;
  page.on('request', () => (page.inflight += 1));
  page.on('requestfinished', () => (page.inflight -= 1));
  page.on('requestfailed', () => (page.inflight -= 1));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
  });
  lastPage = page;
  return { ctx, page };
}
async function idle(page) {
  const end = Date.now() + 30000;
  let quietSince = Date.now();
  await page.waitForTimeout(300);
  while (Date.now() < end) {
    if (page.inflight > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 700) return;
    await page.waitForTimeout(100);
  }
}
const go = async (page, path) => {
  lastPage = page;
  await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 180000 });
  await idle(page);
};
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
const radio = (scope, row, option) => scope.getByRole('radiogroup', { name: row, exact: true }).getByRole('radio', { name: option, exact: true });
const inviteRow = async () => (await q(`select id, status from invites where email = $1`, [INVITED]))[0];
const ownSettings = async (id) => Object.fromEntries((await q(`select key, value from permission_settings where owner_kind='invite' and owner_id=$1`, [id])).map((r) => [r.key, r.value]));

let invitedUserId = null;
let invite = null;

try {
  const { page } = await session(admin.cookies);

  await step('the fields are gone', async () => {
    await go(page, '/admin/presets');
    await page.getByRole('button', { name: /Reload configuration/ }).click();
    await idle(page);
    await go(page, `/contacts?record=${probe.id}&tab=${pricing.tab}&subtab=${pricing.subtab}`);
    await page.getByText(NAME).first().waitFor({ timeout: 30000 });
    await shot(page, 'inv-1-merchant-pricing');
    const text = (await page.locator('body').innerText()).toLowerCase();
    t('Merchant Pricing: other fields still there', text.includes('merchant pricing') && /fee|volume/.test(text));
    t('no Merchant Gateway section or field', !text.includes('merchant gateway'));
    t('no Merchant Terminal section or field', !text.includes('merchant terminal'));
    const archived = await q(`select key::text from fields where key = any($1) and archived_at is not null`, [REMOVED]);
    t('all six archived, so Presets can restore them', archived.length === 6, `${archived.length}`);
    t('no merchant lost a value', (await q(`select count(*)::int n from records where ${REMOVED.map(hasValue).join(' or ')}`))[0].n === valuesBefore, `${valuesBefore} records`);
  });

  await step('invite: step two opens on module access', async () => {
    await go(page, '/admin/users');
    await page.getByRole('button', { name: 'Invite a user' }).first().click();
    await page.locator('input[name="email"]').fill(INVITED);
    await page.getByRole('button', { name: 'Continue to permissions' }).click();
    await page.getByRole('tab', { name: 'Module access & settings' }).waitFor({ timeout: 30000 });
    invite = await inviteRow();
    t('the invite exists, nothing emailed yet', invite?.status === 'pending' && (await page.getByText('Nothing has been emailed yet').count()) === 1);
    await page.getByRole('radiogroup', { name: leads.label, exact: true }).waitFor({ timeout: 30000 });
    t('module access is on screen without leaving the dialog', (await page.getByText('Module access', { exact: true }).count()) >= 1);
    const first = await page.locator('h3').first().innerText();
    t('and comes first', first.trim().toLowerCase() === 'module access', first);
    await shot(page, 'inv-2-module-access');
  });

  await step('invite: setting module access', async () => {
    await radio(page, leads.label, 'Hidden').click();
    t('Leads Hidden is saved on the invite', await until(async () => (await ownSettings(invite.id))[`module:${leads.id}`] === 'hidden'));
    // Their type already gives Only mine here, so All records is the change.
    await radio(page, deals.label, 'All records').click();
    t('Deals All records is saved', await until(async () => (await ownSettings(invite.id))[`module:${deals.id}`] === 'all'));
    await idle(page);
    t('the choice stays on screen after the save', (await radio(page, leads.label, 'Hidden').getAttribute('aria-checked')) === 'true');
    t('marked as overrides', (await page.getByText('Override', { exact: true }).count()) >= 2);
    const audit = await q(`select what, after from permission_audit_log where target_kind='invite' and target_id=$1 and what=$2`, [invite.id, `module:${leads.id}`]);
    t('the change is in the permission log', audit.length === 1 && audit[0].after === 'hidden');

    await radio(page, contacts.label, 'Hidden').click();
    await until(async () => (await ownSettings(invite.id))[`module:${contacts.id}`] === 'hidden');
    await page.getByRole('button', { name: `Reset ${contacts.label} to their type` }).click();
    t('a row can go back to their type', await until(async () => (await ownSettings(invite.id))[`module:${contacts.id}`] === undefined));
    await idle(page);
    await shot(page, 'inv-3-overrides');
  });

  await step('invite: the two views', async () => {
    await page.getByRole('tab', { name: 'Tabs & fields' }).click();
    await page.getByText('Setting permissions for', { exact: false }).first().waitFor();
    t('Tabs & fields still has the module picker and matrix', (await page.getByText('Tabs & fields', { exact: true }).count()) >= 2);
    t('and module access is not under the module picker', (await page.getByRole('radiogroup', { name: leads.label, exact: true }).count()) === 0);
    await shot(page, 'inv-4-tabs');
    await page.getByRole('tab', { name: 'Module access & settings' }).click();
    t('coming back, the choices are still there', (await radio(page, leads.label, 'Hidden').getAttribute('aria-checked')) === 'true');
    await page.getByRole('button', { name: 'Close without sending' }).click();
    await idle(page);
    t('closing keeps the invite pending', (await inviteRow()).status === 'pending');
  });

  await step('invite: its own page', async () => {
    await go(page, `/admin/users/invites/${invite.id}/permissions`);
    await page.getByRole('radiogroup', { name: leads.label, exact: true }).waitFor({ timeout: 30000 });
    t('the page shows the same settings', (await radio(page, leads.label, 'Hidden').getAttribute('aria-checked')) === 'true' && (await radio(page, deals.label, 'All records').getAttribute('aria-checked')) === 'true');
    await radio(page, contacts.label, 'Hidden').click();
    t('and can change them', await until(async () => (await ownSettings(invite.id))[`module:${contacts.id}`] === 'hidden'));
    await page.reload({ waitUntil: 'load' });
    await idle(page);
    t('still there after a reload', (await radio(page, contacts.label, 'Hidden').getAttribute('aria-checked')) === 'true');
    await page.getByRole('button', { name: `Reset ${contacts.label} to their type` }).click();
    await until(async () => (await ownSettings(invite.id))[`module:${contacts.id}`] === undefined);
    await idle(page);
  });

  await step('the rules are in the database', async () => {
    const call = 'select perm_set_setting($1, $2, $3, $4, $5)';
    const memberHas = (await q(`select user_perm($1, $2) v`, [member.id, `module:${deals.id}`]))[0].v;
    if (memberHas !== 'all') {
      t('nothing above the actor\'s own level', /higher level/.test((await refused(call, [member.id, 'invite', invite.id, `module:${deals.id}`, 'all'])) ?? ''), memberHas);
    }
    t('a bad value is refused', /not a value/.test((await refused(call, [admin.id, 'invite', invite.id, `module:${deals.id}`, 'nonsense'])) ?? ''));
    t('an owner that does not exist is refused', /No such invite/.test((await refused(call, [admin.id, 'invite', probe.id, `module:${deals.id}`, 'all'])) ?? ''));
    t('browsers cannot call it', (await q(`select has_function_privilege('authenticated', 'perm_set_setting(uuid,text,uuid,text,text)', 'execute') v`))[0].v === false && (await q(`select has_function_privilege('authenticated', 'perm_guard_invite_target(uuid,uuid)', 'execute') v`))[0].v === false);
    const email2 = `zz-invite-super-${tag}@tapdash.test`;
    const [superRole] = await q(`select id from roles where is_admin limit 1`);
    const [other] = await q(`insert into invites (email, role_id, status, expires_at) values ($1, $2, 'pending', now() + interval '1 day') returning id`, [email2, superRole.id]);
    try {
      t('only a Super admin can change an invited Super admin', /Only a Super admin/.test((await refused(call, [member.id, 'invite', other.id, `module:${deals.id}`, 'mine'])) ?? ''));
      await q(`update invites set status = 'revoked' where id = $1`, [other.id]);
      t('a closed invite is refused', /no longer open/.test((await refused(call, [admin.id, 'invite', other.id, `module:${deals.id}`, 'mine'])) ?? ''));
      await q(`update invites set status = 'pending' where id = $1`, [other.id]);
      await q(`insert into permission_settings (owner_kind, owner_id, key, value) values ('invite', $1, $2, 'mine')`, [other.id, `module:${deals.id}`]);
    } finally {
      await q(`delete from invites where id = $1`, [other.id]);
    }
    t('an invite\'s settings go with it', (await ownSettings(other.id)) && Object.keys(await ownSettings(other.id)).length === 0);
  });

  await step('signing up applies them', async () => {
    const password = randomBytes(24).toString('base64url');
    const { data, error } = await svc.auth.admin.createUser({ email: INVITED, password, email_confirm: true });
    if (error) throw error;
    invitedUserId = data.user.id;
    await q(`select complete_signup($1, $2::citext, $3)`, [invitedUserId, INVITED, 'ZZ Invited']);
    t('the invite is accepted', (await inviteRow()).status === 'accepted');
    const own = await q(`select key, value from permission_settings where owner_kind='user' and owner_id=$1`, [invitedUserId]);
    t('the settings became theirs', own.length === 2 && own.some((r) => r.key === `module:${leads.id}` && r.value === 'hidden') && own.some((r) => r.key === `module:${deals.id}` && r.value === 'all'), `${own.length}`);
    t('the invite no longer holds a copy', Object.keys(await ownSettings(invite.id)).length === 0);
    const perm = async (id) => (await q(`select user_perm($1, $2) v`, [invitedUserId, `module:${id}`]))[0].v;
    t('the resolver agrees', (await perm(leads.id)) === 'hidden' && (await perm(deals.id)) === 'all' && (await perm(contacts.id)) === 'mine');

    await go(page, `/admin/users/invites/${invite.id}/permissions`);
    t('an accepted invite goes to their real permissions', await until(async () => page.url().includes(`/admin/users/${invitedUserId}/permissions`)));
  });

  await step('as the person invited', async () => {
    const mine = await cookiesFor(INVITED);
    const { page: theirs } = await session(mine.cookies);
    await go(theirs, `/${deals.slug}`);
    const nav = (await theirs.locator('aside, nav').first().innerText()).toLowerCase();
    await shot(theirs, 'inv-5-invited-person');
    t('Leads is not in their navigation', !nav.includes(leads.label.toLowerCase()), nav.replace(/\s+/g, ' ').slice(0, 140));
    t('Deals is', nav.includes(deals.label.toLowerCase()));
    await go(theirs, `/${contacts.slug}?q=${encodeURIComponent(NAME)}`);
    await shot(theirs, 'inv-5b-contacts-search');
    const hits = await theirs.getByText(NAME).evaluateAll((els) => els.map((e) => `${e.tagName}: ${e.textContent.trim().slice(0, 70)}`));
    t('Contacts stays on their type: Only mine, so nobody else\'s record in the list', (await theirs.locator('tbody tr, [role="row"]').filter({ hasText: NAME }).count()) === 0, hits.join(' | '));
    await go(theirs, `/${contacts.slug}?record=${probe.id}`);
    await shot(theirs, 'inv-5c-contacts-direct');
    t('and opening it by its address does not show it', (await theirs.getByRole('heading', { name: NAME }).count()) === 0);
    await go(theirs, `/${leads.slug}`);
    const leadRow = await q(`select r.deal_name from records r join record_modules rm on rm.record_id = r.id where rm.module_id = $1 and r.deal_name is not null limit 1`, [leads.id]);
    const body = await theirs.locator('body').innerText();
    t('opening Leads directly shows none of its records', leadRow.length === 0 || !body.includes(leadRow[0].deal_name), theirs.url().replace(BASE, ''));
    await shot(theirs, 'inv-6-leads-direct');
  });
} finally {
  clearTimeout(watchdog);
  await browser.close().catch(() => {});
  await db.query(`delete from records where id = $1`, [probe.id]).catch((e) => fail.push(`remove probe: ${e}`));
  await db.query(`delete from invites where email = $1`, [INVITED]).catch((e) => fail.push(`remove invite: ${e}`));
  if (invitedUserId) {
    await db.query(`delete from auth.users where id = $1`, [invitedUserId]).catch(() => {});
    await db.query(`delete from profiles where id = $1`, [invitedUserId]).catch((e) => fail.push(`remove profile: ${e}`));
    await db.query(`delete from permission_settings where owner_kind = 'user' and owner_id = $1`, [invitedUserId]).catch(() => {});
    seenBefore.delete(invitedUserId);
  }
  for (const [id, seen] of seenBefore) await db.query(`update profiles set last_seen_at = $2 where id = $1`, [id, seen]).catch((e) => fail.push(`restore last_seen_at: ${e}`));
  const after = await counts();
  const drift = Object.keys(before).filter((k) => after[k] !== before[k]);
  t('every count back to where it started', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${after[d]}`).join(', '));
  t('no page errors / 5xx', errors.length === 0, errors.join(' | ').slice(0, 600));
  // Whatever this run logged in with, nobody knows it now.
  for (const id of [admin.id, member.id]) await svc.auth.admin.updateUserById(id, { password: randomBytes(32).toString('base64url') }).catch(() => {});
  await db.end();
}

console.log(`\nPASS ${pass.length}`);
console.log(`FAIL ${fail.length}`);
for (const f of fail) console.log('  ✗ ' + f);
process.exit(fail.length ? 1 : 0);
