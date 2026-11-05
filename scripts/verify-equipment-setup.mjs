/**
 * Merchant Equipment Setup, end to end in a real browser, as an admin and as a member.
 *
 * NEEDS MIGRATION 9911 APPLIED, and the configuration reloaded. Nothing shows without
 * it. The script stops at once, and changes nothing, if the sub-tab is not there.
 *
 * Writes one probe record, its rows, a ZZ custom provider and temporary settings on the
 * member, and removes them at the end. Provider, row, grant and setting counts are
 * compared. The probe's activity entries stay behind by design: record_activity is
 * append-only and survives a record being removed.
 *
 * Prints shapes and pass or fail only, never a person's data.
 *
 *   npx next dev -p 3221
 *   node --env-file=.env scripts/verify-equipment-setup.mjs
 */
import net from 'node:net';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const MEMBER = 'itest-invited-1788686334823@tapdash.test';
for (const e of [ADMIN, MEMBER]) if (!/@([a-z0-9-]+\.)*test$/i.test(e)) process.exit(1);

// A pool, not one client: a dropped connection is replaced, where a lone client takes the
// whole process down before `finally` can clean the shared database.
const db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 3, keepAlive: true });
db.on('error', (e) => console.error('[pool] connection dropped, carrying on:', e.message));
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

// The sub-tab is found by its flag, as the app finds it.
const [where] = await q(`select s.id subtab_id, s.key subtab_key, t.id tab_id, t.key tab_key from subtabs s join tabs t on t.id = s.tab_id where s.shows_equipment_setup`);
if (!where) {
  console.error('Migration 9911 has not been applied: there is no sub-tab to test. Nothing was changed.');
  await db.end();
  process.exit(2);
}

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
const savedHashes = new Map();
const seenBefore = new Map();
async function cookiesFor(email) {
  const [u] = await q(`select id, last_seen_at from profiles where email=$1`, [email]);
  if (!seenBefore.has(u.id)) seenBefore.set(u.id, u.last_seen_at);
  await db.query(`update profiles set last_seen_at = now() where id=$1`, [u.id]);
  const PW = 'ZzProbe-2026!equip';
  if (!savedHashes.has(u.id)) savedHashes.set(u.id, (await db.query('select encrypted_password from auth.users where id = $1', [u.id])).rows[0]?.encrypted_password ?? null);
  await svc.auth.admin.updateUserById(u.id, { password: PW });
  await new Promise((r) => setTimeout(r, 1100));
  const { data, error } = await anon.auth.signInWithPassword({ email, password: PW });
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
const SHOTS = process.env.VERIFY_SHOTS_DIR ?? null;
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {});
};
let lastPage = null;
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    fail.push(`${name} threw: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`);
    console.log(`THREW ${name}: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`);
    if (lastPage) await shot(lastPage, `fail-${name.replace(/[^a-z0-9]+/gi, '-')}`);
  }
};

const counts = async () => (await q(`select
  (select count(*)::int from equipment_providers) providers,
  (select count(*)::int from equipment_rows) equipment_rows,
  (select count(*)::int from subtabs) subtabs,
  (select count(*)::int from fields) fields,
  (select count(*)::int from template_grants) template_grants`))[0];
const before = await counts();
const oldSubtabBefore = (await q(`select s.key, s.label, s.position, (select count(*)::int from fields f where f.subtab_id = s.id) fields from subtabs s where s.key in ('equipment', 'vendor_to_td', 'other_vendor') order by s.key`));

const member = await cookiesFor(MEMBER);
const admin = await cookiesFor(ADMIN);
const ids = [member.id, admin.id];
const cleanRate = () => db.query(`delete from rate_limit_counters where key like any($1)`, [ids.map((id) => `equipment:user:${id}`)]);
await cleanRate();

// Temporary settings and grants on the member: whatever they held is put back at the end.
const SETTINGS = ['equipment.add_providers'];
const permsBefore = await q(`select * from permission_settings where owner_kind='user' and owner_id=$1 and key = any($2)`, [member.id, SETTINGS]);
const setSetting = async (key, value) => {
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1 and key=$2`, [member.id, key]);
  if (value !== null) await db.query(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, $3)`, [member.id, key, value]);
};
const scopes = await q(`select id, key::text from fields where subtab_id = $1`, [where.subtab_id]);
const fieldId = (key) => scopes.find((f) => f.key === key).id;
const SCOPE_IDS = [where.subtab_id, where.tab_id, ...scopes.map((f) => f.id)];
const grantsBefore = await q(`select * from user_grants where user_id=$1 and scope_id = any($2)`, [member.id, SCOPE_IDS]);
const setGrant = async (kind, scopeId, level) => {
  await db.query(`delete from user_grants where user_id=$1 and scope_kind=$2 and scope_id=$3 and module_id is null`, [member.id, kind, scopeId]);
  if (level) await db.query(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, $2, $3, $4)`, [member.id, kind, scopeId, level]);
};

const contacts = (await q(`select id, slug from modules where slug='contacts'`))[0];
const tag = Math.random().toString(36).slice(2, 8);
const NAME = `ZZ equipment probe ${tag}`;
const PROVIDER = `ZZ Provider ${tag}`;
// On the team, so the member can open the record.
const [probe] = await q(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, $3::jsonb) returning id`, [NAME, admin.id, JSON.stringify({ legal_business_name: `${NAME} LLC`, team_members_assigned: [admin.id, member.id] })]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, contacts.id, admin.id]);
await q(`insert into record_team_members (record_id, user_id) values ($1, $2), ($1, $3) on conflict do nothing`, [probe.id, admin.id, member.id]).catch(() => {});
const recordUrl = `/${contacts.slug}?record=${probe.id}&tab=${where.tab_key}&subtab=${where.subtab_key}`;

const browser = await chromium.launch();
const watchdog = setTimeout(() => {
  fail.push('watchdog: the run took over 30 minutes');
  void browser.close();
}, 30 * 60 * 1000);
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
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const panel = (page) => page.locator('[data-equipment-panel]');
const row = (page, n) => page.locator(`[data-equipment-row="${n}"]`);
const box = (page, column, n) => row(page, n).getByLabel(`${column}, row ${n}`, { exact: true });
const dbRows = () => q(`select * from equipment_rows where record_id=$1 order by row_no`, [probe.id]);
const dbRow = async (n) => (await dbRows()).find((r) => r.row_no === n);
const typeInto = async (page, column, n, text) => {
  const b = box(page, column, n);
  await b.click();
  await b.fill(text);
  await b.blur();
  await idle(page);
};
const addRow = async (page) => {
  await page.getByRole('button', { name: 'Add row' }).click();
  await idle(page);
};
const COLUMNS = ['Provider name', 'Billed by', 'Billed to', 'Item', 'Item amount', 'Monthly fee', 'Per item fee', 'One-time fee', 'Volume fee', 'Notes', 'Proposal'];

try {
  const a = await session(admin.cookies);
  const m = await session(member.cookies);
  const adminPage = a.page;
  const page = m.page;

  await step('warm up', async () => {
    for (const p of [adminPage, page]) {
      const started = Date.now();
      await p.goto(`${BASE}${recordUrl}`, { waitUntil: 'load', timeout: 300000 });
      console.log(`warm ${Date.now() - started} ms`);
    }
  });

  await step('admin: starts empty', async () => {
    await go(adminPage, recordUrl);
    await panel(adminPage).waitFor({ timeout: 30000 });
    t('admin: the sub-tab opens on the panel', true);
    t('starts empty: no preset rows', (await dbRows()).length === 0 && (await adminPage.getByText('No equipment rows yet.').count()) === 1);
    t('old sub-tab still in the strip, side by side', (await adminPage.getByText('Merchant Equipment List', { exact: true }).count()) >= 1);
    t('no "All changes saved" before anything is saved', (await adminPage.getByText('All changes saved').count()) === 0);
    await shot(adminPage, 'eq-1-empty');
  });

  await step('admin: adding a row, one at a time', async () => {
    await addRow(adminPage);
    await row(adminPage, 1).waitFor();
    t('one click, one row', (await dbRows()).length === 1);
    t('"All changes saved" after a save', (await adminPage.getByText('All changes saved').count()) === 1);
    const headers = (await panel(adminPage).locator('thead th').allInnerTexts()).map((h) => h.trim().toLowerCase()).filter((h) => h && h !== 'row actions');
    t('all eleven columns, in order', JSON.stringify(headers) === JSON.stringify(COLUMNS.map((c) => c.toLowerCase())), headers.join(' | '));
    const r = await dbRow(1);
    t('every fee starts NULL', [r.monthly_fee, r.per_item_fee, r.one_time_fee, r.volume_fee, r.item_amount].every((v) => v === null));
    t('a blank fee draws blank, not $0', (await box(adminPage, 'Monthly fee', 1).inputValue()) === '');
    t('tab notes still under the panel', (await adminPage.getByText(/^tab notes$/i).count()) >= 1);
    await shot(adminPage, 'eq-2-row');
  });

  await step('admin: typing, and blanks', async () => {
    await typeInto(adminPage, 'Item', 1, 'Probe terminal');
    await typeInto(adminPage, 'Item amount', 1, '3');
    await typeInto(adminPage, 'Monthly fee', 1, '$1,250.5');
    await typeInto(adminPage, 'Volume fee', 1, '2.5%');
    const r = await dbRow(1);
    t('saved by leaving the box', r.item === 'Probe terminal' && r.item_amount === 3);
    t('currency to two places', Number(r.monthly_fee) === 1250.5 && (await box(adminPage, 'Monthly fee', 1).inputValue()) === '1250.50');
    t('percentage as a number', Number(r.volume_fee) === 2.5);
    t('no calculation anywhere: other fees still NULL', r.per_item_fee === null && r.one_time_fee === null);

    await typeInto(adminPage, 'Monthly fee', 1, '');
    t('clearing a fee stores NULL, never 0', (await dbRow(1)).monthly_fee === null);
    await typeInto(adminPage, 'Monthly fee', 1, 'lots');
    t('a bad value says so and is not kept', (await adminPage.getByRole('alert').count()) >= 1 && (await box(adminPage, 'Monthly fee', 1).inputValue()) === '' && (await dbRow(1)).monthly_fee === null);
    await typeInto(adminPage, 'Monthly fee', 1, '10');

    const proposal = box(adminPage, 'Proposal', 1);
    await proposal.check();
    await idle(adminPage);
    t('Proposal checkbox stored', (await dbRow(1)).proposal === true);
    await typeInto(adminPage, 'Notes', 1, 'Probe note');
    t('Notes saved', (await dbRow(1)).notes === 'Probe note');
    const notes = box(adminPage, 'Notes', 1);
    // Typing left the mouse over the box, and hovering is what opens it.
    await adminPage.mouse.move(0, 0);
    await adminPage.waitForTimeout(300);
    const small = (await notes.boundingBox()).height;
    await notes.click();
    await adminPage.waitForTimeout(250);
    const big = (await notes.boundingBox()).height;
    await notes.blur();
    t('Notes: one line, bigger on click', big > small * 1.5, `${small} → ${big}`);
    await adminPage.mouse.move(0, 0);
    // The table scrolls inside its own box. The drawer around it must not move or scroll.
    const sideways = await panel(adminPage).evaluate((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.scrollLeft !== 0 || (getComputedStyle(p).overflowX !== 'visible' && p.scrollWidth > p.clientWidth + 1)) return `${p.tagName} ${p.scrollLeft} ${p.scrollWidth}/${p.clientWidth}`;
      }
      return null;
    });
    t('the drawer does not scroll sideways', sideways === null, sideways ?? '');
  });

  await step('admin: Billed by follows the provider', async () => {
    const billed = box(adminPage, 'Billed by', 1);
    const options = async () => (await billed.locator('option').allInnerTexts()).map((o) => o.trim()).filter(Boolean);
    t('no provider yet: only Tenor', JSON.stringify(await options()) === JSON.stringify(['Tenor']), (await options()).join(', '));

    const provider = box(adminPage, 'Provider name', 1);
    const presets = (await provider.locator('option').allInnerTexts()).map((o) => o.trim()).filter(Boolean);
    t('the ten presets in order, then the add option', presets.slice(0, 10).join() === 'Accept.blue,Authorize.net,NMI,Maverick,Tenor,Deja Voo,IPOS,Deja Pro,Valor,UsaEpay' && presets.includes('Add new provider'), presets.length + ' options');

    await provider.selectOption({ label: 'NMI' });
    await idle(adminPage);
    t('second choice is the row\'s provider', (await options()).join() === 'Tenor,NMI', (await options()).join(', '));
    await billed.selectOption({ label: 'NMI' });
    await idle(adminPage);
    t('stored as the choice, not the name', (await dbRow(1)).billed_by === 'provider');

    await provider.selectOption({ label: 'Valor' });
    await idle(adminPage);
    t('changing the provider clears it, on the server', (await dbRow(1)).billed_by === null);
    t('changing the provider clears it, on the screen', (await billed.inputValue()) === '');
    t('second choice now names the new provider', (await options()).join() === 'Tenor,Valor', (await options()).join(', '));

    await box(adminPage, 'Billed to', 1).selectOption({ label: 'ISO' });
    await idle(adminPage);
    t('Billed to saved', (await dbRow(1)).billed_to === 'iso');
    await shot(adminPage, 'eq-3-filled');
  });

  await step('admin: custom provider', async () => {
    await addRow(adminPage);
    await row(adminPage, 2).waitFor();
    const provider = box(adminPage, 'Provider name', 2);
    await provider.selectOption({ label: 'Add new provider' });
    const name = adminPage.getByLabel('New provider name');
    await name.fill('nmi');
    await name.press('Enter');
    await adminPage.getByText('That provider is already on the list.').waitFor();
    t('a duplicate is refused, ignoring case', (await q(`select count(*)::int n from equipment_providers where lower(name)='nmi'`))[0].n === 1);
    await name.fill(PROVIDER);
    await name.press('Enter');
    await idle(adminPage);
    t('added to the shared list', (await q(`select count(*)::int n from equipment_providers where name=$1 and not is_preset and created_by=$2`, [PROVIDER, admin.id]))[0].n === 1);
    const [p] = await q(`select id from equipment_providers where name=$1`, [PROVIDER]);
    t('and picked on the row it was added from', (await dbRow(2)).provider_id === p?.id);
    await box(adminPage, 'Provider name', 1).selectOption({ label: 'NMI' });
    await idle(adminPage);
    await box(adminPage, 'Provider name', 2).selectOption({ label: 'NMI' });
    await idle(adminPage);
    t('one provider on many rows', (await dbRow(1)).provider_id === (await dbRow(2)).provider_id);

    // Saves do not recompute the page, so leaving the sub-tab and coming back must still
    // show them.
    await box(adminPage, 'Item', 2).fill('Second probe item');
    await box(adminPage, 'Item', 2).blur();
    await idle(adminPage);
    await adminPage.getByText('Merchant Equipment List', { exact: true }).click();
    await panel(adminPage).waitFor({ state: 'detached', timeout: 30000 });
    await adminPage.getByText('Merchant Equipment Setup', { exact: true }).click();
    await panel(adminPage).waitFor({ timeout: 30000 });
    t('saved rows are still there after leaving the sub-tab', await until(async () => (await box(adminPage, 'Item', 2).inputValue()) === 'Second probe item'));
  });

  await step('the log', async () => {
    const updates = await q(`select body, author_id, is_log from updates where record_id=$1 and is_log`, [probe.id]);
    t('Updates: added and changed, with who', updates.some((u) => u.body === 'Added equipment row 1.' && u.author_id === admin.id) && updates.some((u) => u.body === 'Changed equipment row 1.'));
    const act = await q(`select kind::text, summary, actor_id from record_activity where record_id=$1 and kind='equipment'`, [probe.id]);
    t('history: an entry for each, by the admin', act.length >= 5 && act.every((x) => x.actor_id === admin.id), `${act.length} entries`);
    t('history: a custom provider is logged', act.some((x) => x.summary === `Added custom provider ${PROVIDER}.`));
    const all = JSON.stringify([updates, act, await q(`select body from update_details where record_id=$1`, [probe.id])]);
    t('no value in any log line', !all.includes('1250') && !all.includes('Probe terminal') && !all.includes('Probe note'));
  });

  await step('member: the setting they inherited', async () => {
    await setSetting('equipment.add_providers', 'no');
    await setGrant('tab', where.tab_id, 'edit');
    await setGrant('subtab', where.subtab_id, 'edit');
    await go(page, recordUrl);
    await panel(page).waitFor({ timeout: 30000 });
    t('member: opens the sub-tab', true);
    const provider = box(page, 'Provider name', 1);
    const options = (await provider.locator('option').allInnerTexts()).map((o) => o.trim());
    t('no permission: no "Add new provider"', !options.includes('Add new provider'));
    t('no permission: custom providers can still be picked', options.includes(PROVIDER));
    await provider.selectOption({ label: PROVIDER });
    await idle(page);
    const [p] = await q(`select id from equipment_providers where name=$1`, [PROVIDER]);
    t('member: picking saves', (await dbRow(1)).provider_id === p.id);
    await provider.selectOption({ label: 'NMI' });
    await idle(page);
    await shot(page, 'eq-4-member');
  });

  await step('member: permission on', async () => {
    await setSetting('equipment.add_providers', 'yes');
    await go(page, recordUrl);
    await panel(page).waitFor({ timeout: 30000 });
    const options = (await box(page, 'Provider name', 1).locator('option').allInnerTexts()).map((o) => o.trim());
    t('with the permission: the option is there', options.includes('Add new provider'));
    await setSetting('equipment.add_providers', 'no');
  });

  await step('member: one column hidden', async () => {
    await setGrant('field', fieldId('eq_monthly_fee'), 'hidden');
    await go(page, recordUrl);
    await panel(page).waitFor({ timeout: 30000 });
    const headers = (await panel(page).locator('thead th').allInnerTexts()).map((h) => h.trim().toLowerCase());
    t('hidden column: no heading', !headers.includes('monthly fee') && headers.includes('per item fee'), headers.length + ' headings');
    t('hidden column: no cell', (await box(page, 'Monthly fee', 1).count()) === 0);
    const html = await page.content();
    // Exactly this key: other Pricing fields are called td_monthly_fee and so on.
    t('hidden column: the value is not in the page', !/[\\"]monthly_fee[\\"]/.test(html) && !html.includes('eq_monthly_fee'));
    await setGrant('field', fieldId('eq_monthly_fee'), null);
    await shot(page, 'eq-5-hidden-column');
  });

  await step('member: one column read only, provider hidden', async () => {
    await setGrant('field', fieldId('eq_item'), 'view');
    await setGrant('field', fieldId('eq_provider'), 'hidden');
    await go(page, recordUrl);
    await panel(page).waitFor({ timeout: 30000 });
    t('view-only column: the box is disabled', await box(page, 'Item', 1).isDisabled());
    t('provider hidden: no column', (await box(page, 'Provider name', 1).count()) === 0);
    const html = await page.content();
    // The custom name, because the presets can also be choices on the old sub-tab's own fields.
    t('provider hidden: the list and its names are not in the page', !html.includes(PROVIDER));
    await setGrant('field', fieldId('eq_item'), null);
    await setGrant('field', fieldId('eq_provider'), null);
  });

  await step('member: sub-tab View', async () => {
    await setGrant('subtab', where.subtab_id, 'view');
    await go(page, recordUrl);
    await panel(page).waitFor({ timeout: 30000 });
    t('view: no Add row', (await page.getByRole('button', { name: 'Add row' }).count()) === 0);
    t('view: no row removal', (await page.getByRole('button', { name: /Delete row/ }).count()) === 0);
    t('view: boxes disabled', await box(page, 'Monthly fee', 1).isDisabled());
  });

  await step('member: sub-tab Hidden', async () => {
    await setGrant('subtab', where.subtab_id, 'hidden');
    await go(page, recordUrl);
    t('hidden: no panel', (await panel(page).count()) === 0);
    const html = await page.content();
    t('hidden: no row data in the page', !html.includes('Probe terminal'));
    await setGrant('subtab', where.subtab_id, 'edit');
  });

  await step('removing a row', async () => {
    await go(page, recordUrl);
    await panel(page).waitFor({ timeout: 30000 });
    await row(page, 2).getByRole('button', { name: 'Delete row 2' }).click();
    await page.getByText('Delete this row? It goes to the Recycle Bin.').waitFor();
    await shot(page, 'eq-6-confirm');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await until(async () => (await row(page, 2).count()) === 0);
    const r = await dbRow(2);
    t('soft: still in the table, marked by who', r.deleted_at !== null && r.deleted_by === member.id);
    t('gone from the panel', (await row(page, 2).count()) === 0);
    t('logged as removed, by the member', (await q(`select 1 from record_activity where record_id=$1 and kind='equipment' and summary='Removed equipment row 2.' and actor_id=$2`, [probe.id, member.id])).length === 1);
  });

  await step('the Recycle Bin', async () => {
    await go(adminPage, '/admin/recycle-bin');
    await adminPage.getByRole('tab', { name: /^Equipment/ }).or(adminPage.getByRole('button', { name: /^Equipment/ })).first().click();
    const entry = adminPage.locator('div.rounded-lg').filter({ hasText: 'Equipment row 2' }).filter({ hasText: NAME }).last();
    await entry.waitFor({ timeout: 30000 });
    t('admin: the row is in the bin, under its record', true);
    await shot(adminPage, 'eq-7-bin');
    await entry.getByRole('button', { name: /restore/i }).click();
    t('admin: restores', await until(async () => (await dbRow(2)).deleted_at === null));
    t('restoring is logged', (await q(`select 1 from record_activity where record_id=$1 and summary='Restored equipment row 2.'`, [probe.id])).length === 1);
    await go(adminPage, recordUrl);
    await row(adminPage, 2).waitFor({ timeout: 30000 });
    t('admin: back on the record', true);
  });

  await step('Configure > Permissions and the grant matrix', async () => {
    const [template] = await q(`select id from permission_templates where user_type='sales_agent'`);
    await go(adminPage, `/admin/templates/${template.id}`);
    const text = await adminPage.locator('body').innerText();
    t('Permissions: "Add custom providers" is listed', text.includes('Add custom providers'));
    // The matrix starts collapsed; its search opens what it finds.
    await adminPage.getByPlaceholder(/^Search module, tab, field or key/).fill('Per item fee');
    await adminPage.waitForTimeout(500);
    const found = await adminPage.locator('body').innerText();
    t('Permissions: a column can be set on its own', found.includes('Per item fee') && found.includes('Merchant Equipment Setup'));
    await shot(adminPage, 'eq-8-permissions');
    await go(adminPage, '/admin/presets');
    t('Presets: the columns are not listed as fields', !(await adminPage.locator('body').innerText()).includes('Per item fee'));
  });

  await step('nothing old moved', async () => {
    await go(adminPage, `/${contacts.slug}?record=${probe.id}&tab=${where.tab_key}&subtab=equipment`);
    t('old sub-tab: still the field grid, not the panel', (await panel(adminPage).count()) === 0);
    const after = await q(`select s.key, s.label, s.position, (select count(*)::int from fields f where f.subtab_id = s.id) fields from subtabs s where s.key in ('equipment', 'vendor_to_td', 'other_vendor') order by s.key`);
    t('the old sub-tabs and their fields are as they were', JSON.stringify(after) === JSON.stringify(oldSubtabBefore));
    t('the eleven columns are not in the ordinary grid', (await adminPage.getByText('Provider name', { exact: true }).count()) === 0);
  });

  await step('member: the drawer wording', async () => {
    await go(page, recordUrl);
    await panel(page).waitFor({ timeout: 30000 });
    const words = (await panel(page).innerText()).toLowerCase();
    t('no module or Tickets wording in the panel', !words.includes('ticket') && !words.includes('archive'));
  });
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  clearTimeout(watchdog);
  await browser.close().catch(() => {});
  // Remove everything the run created. Rows go with the record; the provider after them,
  // because a row still pointing at it would refuse.
  await db.query(`delete from records where id = $1`, [probe.id]).catch((e) => fail.push(`remove probe: ${e}`));
  await db.query(`delete from equipment_providers where name = $1 and not is_preset`, [PROVIDER]).catch((e) => fail.push(`remove provider: ${e}`));
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1 and key = any($2)`, [member.id, SETTINGS]).catch(() => {});
  for (const p of permsBefore) {
    const cols = Object.keys(p);
    await db.query(`insert into permission_settings (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => p[c])).catch((e) => fail.push(`restore setting: ${e}`));
  }
  await db.query(`delete from user_grants where user_id=$1 and scope_id = any($2)`, [member.id, SCOPE_IDS]).catch(() => {});
  for (const g of grantsBefore) {
    const cols = Object.keys(g);
    await db.query(`insert into user_grants (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => g[c])).catch((e) => fail.push(`restore grant: ${e}`));
  }
  for (const [id, seen] of seenBefore) await db.query(`update profiles set last_seen_at = $2 where id=$1`, [id, seen]).catch((e) => fail.push(`restore last_seen_at: ${e}`));
  await cleanRate();
  const after = await counts();
  const drift = Object.keys(before).filter((k) => after[k] !== before[k]);
  t('every count back to where it started', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${after[d]}`).join(', '));
  t('the probe record is gone', (await q(`select count(*)::int n from records where deal_name like 'ZZ equipment probe%'`))[0].n === 0);
  t('no page errors / 5xx', errors.length === 0, errors.join(' | ').slice(0, 600));
  for (const [id, hash] of savedHashes) {
    if (hash) await db.query('update auth.users set encrypted_password = $2 where id = $1', [id, hash]).catch(() => {});
  }
  await db.end();
}

console.log(`\nPASS ${pass.length}`);
for (const p of pass) console.log('  ✓ ' + p);
console.log(`FAIL ${fail.length}`);
for (const f of fail) console.log('  ✗ ' + f);
process.exit(fail.length ? 1 : 0);
