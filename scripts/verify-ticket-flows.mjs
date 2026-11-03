/**
 * Ticket automations (Ticket Automation Flow Builder spec, 1 Nov 2026), through
 * a real browser as an admin: the builder, the Awaiting client button and tag,
 * the ticket log, the tag and the "choose" badge in the Tickets list, the note
 * in Vital Info, and the permission row.
 *
 * One probe record with two open tickets, and two probe automations, are
 * created for the run and hard-deleted at the end. Record, case and automation
 * counts are compared before and after. (record_activity is append-only; the
 * probe's few rows stay, pointing at an id no screen can reach.)
 *
 *   npm run dev -- -p 3221
 *   node --env-file=.env scripts/verify-ticket-flows.mjs
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import net from 'node:net';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
const BASE = process.argv[2] || 'http://localhost:3221';
const SHOTS = process.argv[3] || null;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(ADMIN)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const [me] = await q(`select id from profiles where email=$1`, [ADMIN]);
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PW = 'ZzProbe-2026!page';
await svc.auth.admin.updateUserById(me.id, { password: PW });
await q(`update profiles set last_seen_at = now() where id = $1`, [me.id]).catch(() => {});
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email: ADMIN, password: PW });
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++)
  cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
else cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });

const snapshot = async () => ({
  records: (await q(`select count(*)::int n from records`))[0].n,
  cases: (await q(`select count(*)::int n from cases`))[0].n,
  automations: (await q(`select count(*)::int n from automations`))[0].n,
  choices: (await q(`select count(*)::int n from ticket_choices`))[0].n,
});
const before = await snapshot();
const tickets = (await q(`select id, slug, label from modules where shows_open_cases limit 1`))[0];
const home = (await q(`select id, slug from modules where kind='display' and not admin_only and not shows_open_cases order by position limit 1`))[0];
const template = (await q(`select pt.id from permission_templates pt where pt.user_type = 'sales_agent'`))[0];

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
// A dev server compiles each page on first use: give a refresh its time.
const until = async (cond, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 500)); } return cond(); };

const tag = Math.random().toString(36).slice(2, 8);
const [probe] = await q(
  `insert into records (deal_name, creator_kind, creator_user_id, "values")
   values ($1, 'user', $2, jsonb_build_object('team_members_assigned', jsonb_build_array($4::text), 'contact', jsonb_build_array(jsonb_build_object('name', 'Mia Probe', 'email', $3::text))))
   returning id`, [`ZZ ticket-flows probe ${tag}`, me.id, `zz-${tag}@client.test`, me.id]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, home.id, me.id]);
const mkCase = async (title) => {
  const [c] = await q(`insert into cases (record_id, title, issue, issue_author) values ($1, $2, 'Probe issue', $3) returning id, number`, [probe.id, title, me.id]);
  await q(`insert into case_managers (case_id, user_id) values ($1, $2)`, [c.id, me.id]);
  return c;
};
const fees = await mkCase(`ZZ Fees ${tag}`);
const terminal = await mkCase(`ZZ Terminal ${tag}`);
const automationIds = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
const consoleErrors = [];
const KNOWN_NOISE = /\[Report Only\]|upgrade-insecure-requests|status of 403/;
page.on('console', (m) => { if (m.type() === 'error' && !KNOWN_NOISE.test(m.text())) consoleErrors.push(`[${page.url().replace(BASE, '')}] ${m.text().slice(0, 200)}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {}) : null);
const menuItems = async () => (await page.getByRole('menuitem').all());

try {
  // ── the builder ─────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/automations`, { waitUntil: 'networkidle', timeout: 180000 });
  const nav = page.getByRole('navigation', { name: 'Builders' });
  t('Automations shows Record and Ticket builders side by side', (await nav.getByRole('link').count()) === 2);
  await nav.getByRole('link', { name: /Ticket automations/ }).click();
  await page.waitForURL(/kind=ticket/);
  t('the Ticket tab opens the ticket builder list', (await page.getByRole('link', { name: /New ticket automation/ }).count()) === 1);
  await shot('tf-list');
  await page.getByRole('link', { name: /New ticket automation/ }).click();
  await page.waitForURL(/\/admin\/automations\/new\?kind=ticket/);
  await page.getByRole('button', { name: 'Add trigger' }).click();
  const triggers = (await Promise.all((await menuItems()).map((i) => i.innerText()))).map((s) => s.trim());
  t('two triggers, the spec’s own', JSON.stringify(triggers) === JSON.stringify(['Button clicked: Awaiting client', 'Email received']), triggers.join(' | '));
  await page.getByRole('menuitem', { name: 'Button clicked: Awaiting client' }).click();
  await page.getByRole('button', { name: 'Add condition' }).click();
  const conditions = (await Promise.all((await menuItems()).map((i) => i.innerText()))).map((s) => s.trim());
  t('three conditions', JSON.stringify(conditions) === JSON.stringify(['And ticket is open', 'And ticket is not open', 'Email connects to a record']), conditions.join(' | '));
  t('Email connects to a record is off without Email received', await page.getByRole('menuitem', { name: 'Email connects to a record' }).isDisabled());
  await page.getByRole('menuitem', { name: 'And ticket is open' }).click();
  await page.getByRole('button', { name: 'Add action' }).click();
  const actions = (await Promise.all((await menuItems()).map((i) => i.innerText()))).map((s) => s.trim());
  t('six actions in the ticket builder’s words', JSON.stringify(actions) === JSON.stringify(['Send merchant an email', 'Close ticket', 'Notify user', 'Create a team assignment', 'Open ticket', 'Clear Awaiting client']), actions.join(' | '));
  t('Open ticket is off without And ticket is not open', await page.getByRole('menuitem', { name: 'Open ticket' }).isDisabled());
  await page.getByRole('menuitem', { name: 'Close ticket' }).click();
  await page.getByRole('button', { name: 'Add wait' }).click();
  await page.getByLabel('Automation name').fill(`ZZ ticket builder ${tag}`);
  t('the rail says it is ready', (await page.getByText('Ready to run').count()) === 1);
  await shot('tf-builder');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/\/admin\/automations\/[0-9a-f-]{36}$/, { timeout: 30000 });
  const savedId = page.url().split('/').pop();
  automationIds.push(savedId);
  const saved = (await q(`select a.kind, a.status, v.steps from automations a join automation_versions v on v.id = a.current_version_id where a.id = $1`, [savedId]))[0];
  t('saved as a ticket automation, Draft', saved?.kind === 'ticket' && saved?.status === 'draft');
  t('with the steps as built', saved?.steps.triggers[0].type === 'awaiting_client' && saved?.steps.flow.map((f) => f.type).join() === 'close_ticket,wait');
  await page.getByRole('radio', { name: /Test/ }).click();
  await page.getByPlaceholder('Ticket number, title or record name…').fill(String(fees.number));
  const hit = page.getByRole('button', { name: new RegExp(`#${fees.number}`) });
  t('the Test picker finds the ticket by number', await hit.waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
  await shot('tf-test-picker');
  await page.keyboard.press('Escape');

  // ── the ticket card ─────────────────────────────────────────────────────────
  await page.goto(`${BASE}/${tickets.slug}?record=${probe.id}&tab=cases`, { waitUntil: 'networkidle', timeout: 180000 });
  const dialog = page.locator('[role="dialog"]').last();
  const awaitingButtons = dialog.getByRole('button', { name: 'Awaiting client', exact: true });
  t('each open ticket has an Awaiting client button', (await awaitingButtons.count()) === 2);
  await awaitingButtons.first().click();
  const tagged = async () => (await q(`select count(*)::int n from cases where record_id = $1 and awaiting_client_at is not null`, [probe.id]))[0].n;
  t('clicking it tags one ticket', await until(async () => (await tagged()) === 1));
  const tagPill = dialog.locator('span[title^="Awaiting client since"]');
  t('the tag shows on the card', await until(async () => (await tagPill.count()) === 1));
  t('the ticket log names who did it', await until(async () => (await dialog.getByText(/TapDash Admin\s+Marked Awaiting client\./).count()) === 1));
  t('and the other ticket still offers the button', (await dialog.getByRole('button', { name: 'Awaiting client', exact: true }).count()) === 1);
  await shot('tf-card');
  const clear = dialog.getByRole('button', { name: 'Clear Awaiting client' });
  t('the tag can be cleared by hand', await until(async () => (await clear.count()) === 1));
  await clear.click();
  t('clearing removes it', await until(async () => (await tagged()) === 0));
  await until(async () => (await dialog.getByText('Cleared Awaiting client.').count()) === 1);
  await dialog.getByRole('button', { name: 'Awaiting client', exact: true }).first().click();
  await until(async () => (await tagged()) === 1);

  // ── the Tickets list ────────────────────────────────────────────────────────
  // An email waiting for its ticket, as the engine leaves it.
  const [choiceFlow] = await q(
    `insert into automations (name, status, kind, created_by, updated_by) values ($1, 'off', 'ticket', $2, $2) returning id`, [`ZZ choice ${tag}`, me.id]);
  automationIds.push(choiceFlow.id);
  const [ver] = await q(`insert into automation_versions (automation_id, number, steps, created_by) values ($1, 1, $2, $3) returning id`,
    [choiceFlow.id, { triggers: [], conditions: { join: 'and', groups: [] }, flow: [] }, me.id]);
  await q(`update automations set current_version_id = $1 where id = $2`, [ver.id, choiceFlow.id]);
  const [run] = await q(`insert into automation_runs (automation_id, version_id, automation_name, record_id, record_label, status, reason)
                         values ($1, $2, $3, $4, 'probe', 'choosing', 'Waiting for someone to choose the ticket.') returning id`,
    [choiceFlow.id, ver.id, `ZZ choice ${tag}`, probe.id]);
  await q(`insert into ticket_choices (run_id, record_id, automation_name, sender, subject) values ($1, $2, $3, 'Mia Probe', 'About the fees')`,
    [run.id, probe.id, `ZZ choice ${tag}`]);

  await page.goto(`${BASE}/${tickets.slug}`, { waitUntil: 'networkidle', timeout: 180000 });
  const row = page.locator('tbody tr').filter({ hasText: `ZZ ticket-flows probe ${tag}` });
  t('the probe is in the Tickets list', (await row.count()) === 1);
  t('its row shows Awaiting client', (await row.getByText('Awaiting client').count()) === 1);
  t('and the Choose badge', (await row.getByRole('button', { name: /choose its ticket/ }).count()) === 1);
  await shot('tf-list-row');

  // ── Vital Info ─────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/${tickets.slug}?record=${probe.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  const note = page.getByRole('group', { name: 'Choose the ticket for an email' });
  t('Vital Info asks which ticket the email is about', (await note.count()) === 1);
  t('naming the sender and the subject', (await note.getByText('About the fees').count()) === 1 && (await note.getByText('Mia Probe').count()) === 1);
  t('with both open tickets to pick from', (await note.getByRole('button').count()) === 2);
  await shot('tf-vital');
  await page.goto(`${BASE}/${home.slug}?record=${probe.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  t('the note is not in other modules', (await page.getByRole('group', { name: 'Choose the ticket for an email' }).count()) === 0);
  await page.goto(`${BASE}/${tickets.slug}?record=${probe.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.getByRole('group', { name: 'Choose the ticket for an email' }).getByRole('button', { name: new RegExp(`#${terminal.number}`) }).click();
  const chosen = async () => (await q(`select c.chosen_case_id, r.status, r.case_id from ticket_choices c join automation_runs r on r.id = c.run_id where c.run_id = $1`, [run.id]))[0];
  t('choosing resolves it, and the flow runs on that ticket', await until(async () => (await chosen())?.chosen_case_id === terminal.id && (await chosen())?.case_id === terminal.id));
  t('and the note goes', await until(async () => (await page.getByRole('group', { name: 'Choose the ticket for an email' }).count()) === 0));

  // ── the permission ──────────────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/templates/${template.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  t('Permissions lists Use Awaiting client', (await page.getByText('Use Awaiting client').count()) >= 1);

  t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
  t('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 300)}`);
  await shot('tf-fail');
} finally {
  try {
    await db.query(`delete from records where id=$1`, [probe.id]);
    for (const id of automationIds) {
      await db.query(`delete from automation_runs where automation_id = $1`, [id]);
      await db.query(`update automations set current_version_id = null where id = $1`, [id]);
      await db.query(`delete from automation_versions where automation_id = $1`, [id]);
      await db.query(`delete from automations where id = $1`, [id]);
    }
  } catch (e) { fail.push(`restore failed: ${e.message}`); }
  const after = await snapshot();
  const same = JSON.stringify(before) === JSON.stringify(after);
  console.log(same ? `restore: ${JSON.stringify(after)} — exactly as before` : `⚠ RESTORE MISMATCH\n${JSON.stringify(before)}\n${JSON.stringify(after)}`);
  if (!same) fail.push('restore mismatch');
  await browser.close();
  await db.end();
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
process.exit(fail.length ? 1 : 0);
