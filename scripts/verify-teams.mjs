/**
 * Calendar and Chat, end to end in a real browser, against the mock Microsoft
 * (`scripts/mail-mock-graph.mjs` + `scripts/mail-mock-teams.mjs`).
 *
 * A member connects (first mail only, then Approve, then "waiting for admin approval",
 * the admin approves, Try again), then uses Calendar and Chat the way the spec lists
 * them. An admin with All users then looks at the member's calendar and chats: look
 * only. The member is refused the admin's. Microsoft's side of every change is checked
 * on the mock, and the CRM's own tables after.
 *
 * Writes only the two test accounts' mock identities and what hangs off them, and
 * removes it all at the end; every mail_* and teams_* table count is compared.
 *
 *   node scripts/mail-mock-graph.mjs
 *   MAIL_PROVIDER=mock MAIL_MOCK_BASE_URL=http://127.0.0.1:4555 MAIL_ALLOWED_TENANT_IDS=tid-tapdash \
 *   MAIL_REDIRECT_URI=http://localhost:3221/api/mail/oauth/callback npx next dev -p 3221
 *   node --env-file=.env scripts/verify-teams.mjs
 */
import net from 'node:net';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const BASE = process.argv[2] || 'http://localhost:3221';
const MOCK = 'http://127.0.0.1:4555';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
// demo.rep@tapdash.test was deleted on 23 Oct; this invited test member is the active one.
const MEMBER = 'itest-invited-1788686334823@tapdash.test';
for (const e of [ADMIN, MEMBER]) if (!/@([a-z0-9-]+\.)*test$/i.test(e)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const mock = async (path, body) => {
  const r = await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const world = () => mock('/__mock/teams');

const TABLES = (await q(`select table_name t from information_schema.tables where table_schema='public' and (table_name like 'mail\\_%' or table_name like 'teams\\_%') order by 1`)).map((r) => r.t);
const counts = async () => {
  const out = {};
  for (const t of TABLES) out[t] = (await q(`select count(*)::int n from public.${t}`))[0].n;
  return out;
};
const before = await counts();
const otherCounts = async () => ({
  records: (await q(`select count(*)::int n from records`))[0].n,
  activity: (await q(`select count(*)::int n from record_activity`))[0].n,
  profiles: (await q(`select count(*)::int n, string_agg(role_id::text, ',' order by id) r from profiles`))[0],
});
const beforeOther = await otherCounts();

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
const savedHashes = new Map();
const seenBefore = new Map();
async function cookiesFor(email) {
  const [u] = await q(`select id, last_seen_at from profiles where email=$1`, [email]);
  if (!seenBefore.has(u.id)) seenBefore.set(u.id, u.last_seen_at);
  await db.query(`update profiles set last_seen_at = now() where id=$1`, [u.id]);
  const PW = 'ZzProbe-2026!teams';
  if (!savedHashes.has(u.id)) savedHashes.set(u.id, (await db.query('select encrypted_password from auth.users where id = $1', [u.id])).rows[0]?.encrypted_password ?? null);
  await svc.auth.admin.updateUserById(u.id, { password: PW });
  // A password change moves sessions_valid_from; a token issued in the same second
  // (iat is whole seconds) would count as older and be signed straight out.
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
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
const SHOTS = process.env.VERIFY_SHOTS_DIR ?? null;
let shotPage = null;
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    fail.push(`${name} threw: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`);
    if (SHOTS && shotPage) await shotPage.screenshot({ path: `${SHOTS}/${name.replace(/[^a-z0-9]+/gi, '-')}.png` }).catch(() => {});
  }
};

const member = await cookiesFor(MEMBER);
const admin = await cookiesFor(ADMIN);
const pendingBefore = (await q(`select user_id from teams_pending_approvals where user_id = any($1)`, [[member.id, admin.id]])).map((r) => r.user_id);
const ids = [member.id, admin.id];
const cleanRate = () =>
  db.query(`delete from rate_limit_counters where key like any($1)`, [ids.flatMap((id) => [`teams%:user:${id}`, `mail_connect:user:${id}`, `mail_action:user:${id}`])]);
const countsRowsBefore = (await q(`select user_id from teams_counts where user_id = any($1)`, [ids])).map((r) => r.user_id);
const settingsBefore = (await q(`select user_id, hide_my_chat, hide_my_calendar from mail_user_settings where user_id = any($1)`, [ids]));
await cleanRate();

/*
 * The deployed mail cron shares this database: it claims a mock inbox within seconds,
 * cannot refresh a mock token at the real Microsoft, and marks the connection broken.
 * Hold the mock inboxes' lease for the whole run, and put status back if it slipped in.
 */
let holding = true;
const holdMock = async () => {
  if (!holding) return;
  await db.query(`update mail_mailboxes set lease_until = now() + interval '1 hour', lease_owner = 'verify-teams', next_sync_at = now() + interval '1 hour' where address like '%@mock.test' and deleted_at is null`);
  await db.query(`update mail_identities set status = 'ok' where user_id = any($1) and microsoft_user_id like 'oid-%' and deleted_at is null and status in ('broken', 'degraded')`, [ids]);
  await db.query(`update mail_connections set status = 'ok' where user_id = any($1) and status in ('broken', 'degraded') and disconnected_at is null and mailbox_id in (select id from mail_mailboxes where address like '%@mock.test')`, [ids]);
};
const holder = setInterval(() => void holdMock().catch(() => {}), 1500);

await mock('/__mock/reset', {});
await mock('/__mock/teams-seed', {});
await mock('/__mock/fault', { mailOnlyGrant: true });

const browser = await chromium.launch();
// A last resort: closing the browser makes every pending step fail, so `finally` still cleans up.
const watchdog = setTimeout(() => {
  fail.push('watchdog: the run took over 25 minutes');
  void browser.close();
}, 25 * 60 * 1000);
const errors = [];
async function session(cookies, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, ...opts });
  // Without these Playwright waits forever on a missing element, and the cleanup never runs.
  ctx.setDefaultTimeout(25000);
  ctx.setDefaultNavigationTimeout(180000);
  if (cookies) await ctx.addCookies(cookies);
  await ctx.route('https://teams.microsoft.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Teams</title>' }));
  await ctx.route('**://*.posthog.com/**', (r) => r.abort());
  const page = await ctx.newPage();
  // Requests still in flight, so a step can wait for the app to settle instead of guessing a delay.
  page.inflight = 0;
  page.on('request', () => (page.inflight += 1));
  page.on('requestfinished', () => (page.inflight -= 1));
  page.on('requestfailed', () => (page.inflight -= 1));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
  });
  return { ctx, page };
}
/** Waits until nothing has been in flight for 700 ms (at most 30 s). */
async function idle(page) {
  const until = Date.now() + 30000;
  let quietSince = Date.now();
  await page.waitForTimeout(300);
  while (Date.now() < until) {
    if (page.inflight > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= 700) return;
    await page.waitForTimeout(100);
  }
}
const hdr = (page) => page.locator('header').filter({ has: page.getByTestId('range') });
const go = async (page, path) => {
  const r = await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 180000 });
  await idle(page);
  return r;
};
/** Polls a check until it holds (at most `ms`). */
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const heading = async (page) => ((await page.locator('h1').first().textContent({ timeout: 30000 })) ?? '').trim();
const pick = async (page, account) => {
  await page.waitForURL(/oauth2\/v2\.0\/authorize/, { timeout: 30000 });
  await page.click(`a[data-account="${account}"]`);
};
const ev = (page, subject) => page.locator(`[data-event="${subject}"]`);
const chatRow = (page, name) => page.locator(`button[data-chat="${name}"]`);
const composer = (page) => page.locator('[contenteditable="true"]').last();
const typeAndSend = async (page, text) => {
  await composer(page).click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};
const lastMessage = (w, chatId) => {
  const c = w.chats.find((x) => x.id === chatId);
  return c?.messages[c.messages.length - 1];
};
const DIRECT = '19:direct-owner-mate@unq.gbl.spaces';

let memberIdentity = null;
try {
  const m = await session(member.cookies);
  const page = m.page;
  shotPage = page;

  /* ── connecting ─────────────────────────────────────────────────────── */
  await step('connect', async () => {
    await go(page, '/calendar');
    t('sidebar: Calendar and Chat sit under Email', (await page.locator('nav a[href="/calendar"]').count()) > 0 && (await page.locator('nav a[href="/chat"]').count()) > 0);
    t('no account: only the Connect screen', (await heading(page)) === 'Connect Microsoft to use Calendar');
    await page.getByRole('button', { name: 'Connect Microsoft' }).click();
    await pick(page, 'owner@mock.test');
    await page.waitForURL(/\/calendar/, { timeout: 90000 });
    await page.waitForLoadState('networkidle');
    t('mail-only grant: asked to Approve, not to connect again', (await heading(page)) === 'Approve calendar and chat access', await heading(page));
    t('mail-only grant: the account is listed with Approve', (await page.locator('li', { hasText: 'owner@mock.test' }).getByRole('button', { name: 'Approve' }).count()) === 1);
    const [row] = await q(`select id, scopes from mail_identities where user_id=$1 and microsoft_user_id='oid-owner' and deleted_at is null`, [member.id]);
    memberIdentity = row?.id ?? null;
    t('mail-only grant: identity stored without chat scopes', row && !row.scopes.includes('Chat.ReadWrite'), JSON.stringify(row?.scopes ?? null).slice(0, 80));

    // The organization needs its admin to approve the new permissions.
    await mock('/__mock/fault', { consentPending: true });
    await page.locator('li', { hasText: 'owner@mock.test' }).getByRole('button', { name: 'Approve' }).click();
    await pick(page, 'owner@mock.test');
    await page.waitForURL(/\/calendar/, { timeout: 90000 });
    await page.waitForLoadState('networkidle');
    t('consent required: Waiting for admin approval', (await heading(page)) === 'Waiting for admin approval', await heading(page));
    const request = await page.getByLabel('Request for your Microsoft admin').inputValue();
    t('waiting: a request to copy, with the approval link', /adminconsent\?/.test(request) && request.includes('client_id='), request.slice(0, 120));
    t('waiting: noted for the person', (await q(`select 1 from teams_pending_approvals where user_id=$1`, [member.id])).length === 1);
    await go(page, '/email/settings');
    t('waiting: also said in Email settings', (await page.getByText('Waiting for admin approval:').count()) === 1);

    // The admin opens the link with no CRM session at all.
    const link = request.split('\n').find((l) => l.includes('adminconsent'));
    const outsider = await session(null);
    await outsider.page.goto(link, { waitUntil: 'load' });
    await outsider.page.click('a[data-decision="approve"]');
    await outsider.page.waitForURL(/oauth\/callback/, { timeout: 60000 });
    const body = (await outsider.page.locator('body').textContent()) ?? '';
    t('admin approval: lands on a plain "Approved" page, no sign-in needed', body.includes('Approved. Everyone in your organization can now connect'), body.slice(0, 120));
    await outsider.ctx.close();
    const refused = await (await browser.newContext()).request.get(`${BASE}/api/mail/oauth/callback?code=x&state=y&admin_consent=True`, { maxRedirects: 0 });
    t('a real sign-in return is still session-gated', refused.status() === 401 || (refused.status() >= 300 && refused.status() < 400 && /login/.test(refused.headers().location ?? '')), String(refused.status()));

    await go(page, '/calendar');
    await page.getByRole('button', { name: 'Try again' }).click();
    await pick(page, 'owner@mock.test');
    await page.waitForURL(/\/calendar/, { timeout: 90000 });
    await page.waitForLoadState('networkidle');
    t('approved: the calendar opens', (await heading(page)) === 'Calendar', await heading(page));
    t('approved: waiting note cleared', (await q(`select 1 from teams_pending_approvals where user_id=$1`, [member.id])).length === 0);
    const [after] = await q(`select id, scopes from mail_identities where id=$1`, [memberIdentity]);
    t('approved: same identity, now with chat scopes (one sign-in, no second connection)', after?.scopes.includes('Chat.ReadWrite') && after.scopes.includes('Mail.ReadWrite'));
    t('approved: still one identity for the account', (await q(`select 1 from mail_identities where user_id=$1 and microsoft_user_id='oid-owner' and deleted_at is null`, [member.id])).length === 1);
  });

  /* ── calendar ───────────────────────────────────────────────────────── */
  await step('calendar views', async () => {
    await ev(page, 'Daily standup').first().waitFor({ timeout: 30000 });
    t('work week by default: five days', (await page.locator('main [data-day]').count()) === 5);
    t('own repeating meeting shows', (await ev(page, 'Daily standup').count()) >= 1);
    t('own private event shows its title to its owner', (await ev(page, 'Dentist appointment').count()) === 1);
    const range0 = await page.getByTestId('range').textContent();
    await hdr(page).getByRole('button', { name: 'Next', exact: true }).click();
    const range1 = await page.getByTestId('range').textContent();
    await hdr(page).getByRole('button', { name: 'Previous', exact: true }).click();
    await hdr(page).getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    t('Next moves, Today comes back', range1 !== range0 && (await page.getByTestId('range').textContent()) === range0, `${range0} → ${range1}`);
    for (const [v, n] of [['day', 1], ['week', 7], ['month', 42], ['workweek', 5]]) {
      await page.selectOption('#cal-view', v);
      await page.waitForTimeout(400);
      t(`view ${v}: ${n} day cells`, (await page.locator('main [data-day]').count()) === n, String(await page.locator('main [data-day]').count()));
    }
    t('mini month has its own arrows', (await page.getByRole('button', { name: 'Next month' }).count()) === 1);
    await page.waitForLoadState('networkidle');

    await page.getByRole('region', { name: 'My calendars' }).getByLabel('Calendar', { exact: true }).uncheck();
    await page.waitForTimeout(300);
    t('My calendars: unticking hides its events', (await ev(page, 'Daily standup').count()) === 0);
    await page.getByRole('button', { name: 'Show all' }).click();
    await page.waitForTimeout(300);
    t('Show all brings them back', (await ev(page, 'Daily standup').count()) >= 1);

    await page.getByText('Filter', { exact: true }).click();
    await page.getByLabel('Not answered yet').check();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    t('Filter: only unanswered invitations, and "Filter applied"', (await ev(page, 'Daily standup').count()) === 0 && (await ev(page, 'Merchant kickoff').count()) === 1 && (await page.getByText('Filter applied').count()) === 1);
    await page.getByText('Filter', { exact: true }).click();
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await page.keyboard.press('Escape');
  });

  await step('counts', async () => {
    const c = await (await page.request.get(`${BASE}/api/msteams/counts`)).json();
    t('sidebar numbers: one unanswered invitation, two unread chats', c.calendar === 1 && c.chat === 2, JSON.stringify(c));
  });

  await step('answer an invitation', async () => {
    await ev(page, 'Merchant kickoff').first().click();
    const card = page.getByRole('dialog');
    t('invitation card: organizer, Join, and the three answers', (await card.getByText('Mae Mate').count()) >= 1 && (await card.getByRole('link', { name: 'Join' }).count()) === 1 && (await card.getByRole('button', { name: 'Tentative' }).count()) === 1);
    t('invitation card: no Edit for an attendee', (await card.getByRole('button', { name: 'Edit' }).count()) === 0);
    await card.getByRole('button', { name: 'Accept' }).click();
    await idle(page);
    const w = await world();
    t('Accept reaches Microsoft', w.events.find((e) => e.id === 'ev-invite')?.attendees[0]?.response === 'accepted');
    await page.keyboard.press('Escape');
  });

  await step('form keeps what was typed on an error', async () => {
    await hdr(page).getByText('New', { exact: true }).click();
    await page.getByRole('button', { name: 'New event' }).click();
    const dlg = page.getByRole('dialog', { name: 'New event' });
    await dlg.getByRole('button', { name: 'Save and send' }).click();
    t('no title: says so and stays open', (await dlg.getByRole('alert').textContent())?.includes('Give the event a title.'));
    await dlg.getByLabel('Title').fill('Kept');
    t('teams link off for New event', !(await dlg.getByLabel('Add Teams meeting link').isChecked()));
    await page.keyboard.press('Escape');
  });

  let meetingStart = null;
  await step('new meeting with an attendee', async () => {
    await hdr(page).getByText('New', { exact: true }).click();
    await page.getByRole('button', { name: 'New meeting' }).click();
    const dlg = page.getByRole('dialog', { name: 'New event' });
    await dlg.getByLabel('Title').fill('Verify meeting');
    t('Teams link on by default for a meeting', await dlg.getByLabel('Add Teams meeting link').isChecked());
    const people = dlg.getByLabel('Search Microsoft contacts and Tenor users');
    await people.fill('Mae');
    await dlg.getByRole('button', { name: /Mae Mate/ }).first().click({ timeout: 15000 });
    await dlg.getByRole('button', { name: 'Save and send' }).click();
    await ev(page, 'Verify meeting').first().waitFor({ timeout: 30000 });
    const w = await world();
    const made = w.events.find((e) => e.subject === 'Verify meeting');
    meetingStart = made?.start ?? null;
    t('Save and send: on Microsoft, with the attendee and a Teams link', made && made.organizer === 'owner@mock.test' && made.attendees.some((a) => a.email === 'mate@mock.test') && made.isOnlineMeeting, JSON.stringify(made ?? {}).slice(0, 160));
  });

  await step('drag to move', async () => {
    const box = await ev(page, 'Verify meeting').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 6 + 30, { steps: 6 });
    await page.mouse.move(box.x + box.width / 2, box.y + 6 + 60, { steps: 6 });
    await page.mouse.up();
    await idle(page);
    const made = (await world()).events.find((e) => e.subject === 'Verify meeting');
    t('dragging moves the time on Microsoft', made && meetingStart && made.start !== meetingStart, `${meetingStart} → ${made?.start}`);
  });

  await step('cancel a meeting', async () => {
    await ev(page, 'Verify meeting').first().click();
    const card = page.getByRole('dialog');
    t('organizer card: Edit and Cancel event, no answers', (await card.getByRole('button', { name: 'Cancel event' }).count()) === 1 && (await card.getByRole('button', { name: 'Accept' }).count()) === 0);
    await card.getByRole('button', { name: 'Cancel event' }).click();
    await idle(page);
    t('cancelled on Microsoft and gone from the grid', (await world()).events.find((e) => e.subject === 'Verify meeting')?.isCancelled === true && (await ev(page, 'Verify meeting').count()) === 0);
  });

  await step('repeating event: this and following', async () => {
    await page.selectOption('#cal-view', 'week');
    await hdr(page).getByText('New', { exact: true }).click();
    await page.getByRole('button', { name: 'New event' }).click();
    const dlg = page.getByRole('dialog', { name: 'New event' });
    await dlg.getByLabel('Title').fill('Verify series');
    const days = await page.locator('main [data-day]').evaluateAll((els) => els.map((e) => e.getAttribute('data-day')));
    await dlg.getByLabel('Date').fill(days[1]);
    await dlg.getByLabel('Repeat').selectOption('daily');
    await dlg.getByRole('button', { name: 'Save and send' }).click();
    await idle(page);
    t('repeating event on every following day of the week', (await ev(page, 'Verify series').count()) === 6, String(await ev(page, 'Verify series').count()));
    await ev(page, 'Verify series').nth(2).click();
    const card = page.getByRole('dialog');
    await card.getByRole('button', { name: 'Edit' }).click({ timeout: 15000 });
    const form = page.getByRole('dialog', { name: 'Edit event' });
    await form.getByLabel('Title').fill('Verify series later');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    const scope = page.getByRole('dialog', { name: 'Save repeating event' });
    await scope.getByLabel('This and following').check();
    await scope.getByRole('button', { name: 'Save' }).click();
    await idle(page);
    const w = await world();
    const old = w.events.find((e) => e.subject === 'Verify series');
    const next = w.events.find((e) => e.subject === 'Verify series later');
    t('this and following: old series ends the day before, a new one carries on', old?.recurrence?.range?.type === 'endDate' && old.recurrence.range.endDate < days[3] && next?.recurrence?.range?.startDate === days[3], `${JSON.stringify(old?.recurrence?.range)} / ${JSON.stringify(next?.recurrence?.range)}`);
    t('grid shows both parts', (await ev(page, 'Verify series').count()) === 2 && (await ev(page, 'Verify series later').count()) === 4);
    await page.selectOption('#cal-view', 'workweek');
  });

  await step('meet now', async () => {
    const [tab] = await Promise.all([m.ctx.waitForEvent('page'), page.getByRole('button', { name: 'Meet now' }).click()]);
    await tab.waitForURL(/teams\.microsoft\.com/, { timeout: 20000 });
    t('Meet now opens a Teams meeting', /meetup-join\/mock-now/.test(tab.url()), tab.url());
    await tab.close();
  });

  await step('add a shared calendar', async () => {
    await page.getByRole('button', { name: 'Add calendar' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add calendar' });
    await dlg.getByLabel('Name or email').fill('mate@mock.test');
    await dlg.getByLabel('Name or email').press('Enter');
    await dlg.getByRole('button', { name: 'Add', exact: true }).click();
    t('not shared: says to ask them to share it', await dlg.getByText('has not been shared with this account').waitFor({ timeout: 20000 }).then(() => true, () => false));
    await mock('/__mock/teams-share', { owner: 'mate@mock.test', with: 'owner@mock.test' });
    await dlg.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('region', { name: 'My calendars' }).getByText('Mae Mate').waitFor({ timeout: 20000 });
    t('shared: listed under My calendars', true);
    t('stored for this account', (await q(`select 1 from teams_added_calendars where identity_id=$1 and address='mate@mock.test'`, [memberIdentity])).length === 1);
  });

  /* ── chat ───────────────────────────────────────────────────────────── */
  await step('chat list', async () => {
    await go(page, '/chat');
    await chatRow(page, 'Mae Mate').waitFor({ timeout: 30000 });
    t('chat list: direct, group, meeting chat and channel', (await chatRow(page, 'Partner onboarding').count()) === 1 && (await chatRow(page, 'Weekly pipeline review').count()) === 1 && (await chatRow(page, 'General').count()) === 1);
    t('External tag on the chat with another organization', (await chatRow(page, 'Partner onboarding').getByText('External').count()) === 1);
    t('unread dot on unread chats', (await chatRow(page, 'Mae Mate').getByLabel('Unread').count()) === 1 && (await chatRow(page, 'Weekly pipeline review').getByLabel('Unread').count()) === 0);
    const chip = async (label) => {
      await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: label, exact: true }).click();
      const names = await page.locator('button[data-chat]').evaluateAll((els) => els.map((e) => e.getAttribute('data-chat')));
      await page.getByRole('group', { name: 'Filter' }).getByRole('button', { name: label, exact: true }).click();
      return names.sort().join(',');
    };
    t('chip Unread', (await chip('Unread')) === 'Mae Mate,Partner onboarding', await chip('Unread'));
    t('chip Channels', (await chip('Channels')) === 'General');
    t('chip Meeting chats', (await chip('Meeting chats')) === 'Weekly pipeline review');
    t('chip Chats', (await chip('Chats')) === 'Mae Mate,Partner onboarding');
    await page.getByLabel('Search loaded chats').fill('pipeline');
    t('search finds by name', (await page.locator('button[data-chat]').count()) === 1);
    await page.getByLabel('Search loaded chats').fill('');
  });

  await step('open a chat', async () => {
    await chatRow(page, 'Mae Mate').click();
    await page.getByText('Yes, all done.').first().waitFor({ timeout: 30000 });
    t('last two weeks shown, older not yet', (await page.getByText('Older note from three weeks ago').count()) === 0);
    t('thumbs-up count shows', await page.getByRole('button', { name: '1 thumbs-up' }).first().waitFor({ timeout: 10000 }).then(() => true, () => false));
    await page.getByRole('button', { name: 'Load older messages' }).click();
    await page.getByText('Older note from three weeks ago').waitFor({ timeout: 20000 });
    t('Load older brings earlier messages', true);
    await idle(page);
    t('opening marks it read at Microsoft', Boolean((await world()).chats.find((c) => c.id === DIRECT).readAt['oid-owner'] > new Date(Date.now() - 120000).toISOString()));
    t('unread dot gone', (await chatRow(page, 'Mae Mate').getByLabel('Unread').count()) === 0);
    await page.getByLabel('Search loaded chats').fill('three weeks');
    t('search finds text of loaded messages', (await page.locator('button[data-chat]').count()) === 1);
    await page.getByLabel('Search loaded chats').fill('');
  });

  await step('send, mention, quote, thumbs, edit, delete', async () => {
    await typeAndSend(page, 'Hello from verify');
    await page.locator('li[data-message]', { hasText: 'Hello from verify' }).getByText('Sent').waitFor({ timeout: 20000 });
    t('Enter sends; "Sent" under it', lastMessage(await world(), DIRECT)?.content.includes('Hello from verify'));

    await composer(page).click();
    await page.keyboard.type('Ping ');
    await page.getByRole('button', { name: 'Mention someone' }).click();
    await page.getByText('People in this chat').locator('..').getByRole('button', { name: /^Mae Mate/ }).click();
    await page.keyboard.press('Enter');
    await idle(page);
    const mentioned = lastMessage(await world(), DIRECT);
    t('@mention reaches Teams as a mention of that person, nothing stray', mentioned?.mentions?.[0]?.mentioned?.user?.id === 'oid-mate' && mentioned.content.includes('<at id="0">Mae Mate</at>') && !mentioned.content.includes('&amp;'), mentioned?.content);

    const theirs = page.locator('li[data-message]', { hasText: 'Yes, all done.' }).first();
    await theirs.hover();
    await theirs.getByRole('button', { name: 'Reply with quote' }).click();
    t('quote shows who is being answered', (await page.getByText('Replying to Mae Mate').count()) === 1);
    await typeAndSend(page, 'Quoted answer');
    await idle(page);
    const quoted = lastMessage(await world(), DIRECT);
    t('quoted reply carries the quote', quoted?.attachments?.some((a) => a.contentType === 'messageReference'));

    // The seeded thumbs-up is the member's own: take it off, then put it back.
    const myThumb = async () => (await world()).chats.find((c) => c.id === DIRECT).messages.find((x) => x.content.includes('Yes, all done')).reactions.some((r) => r.user === 'oid-owner' && (r.type === 'like' || r.type === '👍'));
    await theirs.hover();
    await theirs.getByRole('button', { name: 'Remove thumbs-up', exact: true }).click();
    t('thumbs-up removed at Microsoft', await until(async () => !(await myThumb())));
    await theirs.hover();
    await theirs.getByRole('button', { name: 'Thumbs-up', exact: true }).click();
    t('thumbs-up saved at Microsoft', await until(myThumb));

    const mine = page.locator('li[data-message]', { hasText: 'Hello from verify' });
    await mine.hover();
    await mine.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit message' });
    await edit.locator('[contenteditable="true"]').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' (edited)');
    await edit.getByRole('button', { name: 'Save' }).click();
    await page.locator('li[data-message]', { hasText: '(edited)' }).getByText('Edited').waitFor({ timeout: 15000 });
    t('Edit changes it in Teams, marked Edited', await until(async () => (await world()).chats.find((c) => c.id === DIRECT).messages.some((x) => x.content.includes('(edited)') && x.lastEditedDateTime)));

    const edited = page.locator('li[data-message]', { hasText: '(edited)' });
    await edited.hover();
    await edited.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog', { name: 'Delete message' }).getByRole('button', { name: 'Delete' }).click();
    await idle(page);
    t('Delete leaves "Message deleted" here and in Teams', (await page.getByText('Message deleted').count()) >= 1 && (await world()).chats.find((c) => c.id === DIRECT).messages.some((x) => x.deletedDateTime));
    t('no Edit/Delete on someone else’s message', (await theirs.getByRole('button', { name: 'Edit' }).count()) === 0);
  });

  await step('files', async () => {
    await page.locator('input[type=file]').setInputFiles({ name: 'verify-note.txt', mimeType: 'text/plain', buffer: Buffer.from('A small file for the verify run.\n'.repeat(40)) });
    await page.getByText('verify-note.txt').first().waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const card = page.locator('a[title="Download verify-note.txt"]');
    await card.waitFor({ timeout: 30000 });
    const w = await world();
    t('file sent as a card, shared with the chat without an email', w.files.some((f) => f.name === 'verify-note.txt' && f.sharedWith.includes('mate@mock.test')) && w.invites.length === 1);
    await page.waitForTimeout(500);
    const href = await card.getAttribute('href');
    const dl = await page.request.get(`${BASE}${href}`, { maxRedirects: 0 });
    t('download goes to Microsoft’s short-lived link', dl.status() >= 300 && dl.status() < 400 && (dl.headers().location ?? '').startsWith(`${MOCK}/files/`), `${dl.status()} ${dl.headers().location ?? ''}`);
    const evil = await page.request.get(`${BASE}/api/msteams/file?key=${encodeURIComponent(`chat|${memberIdentity}|${DIRECT}`)}&url=${encodeURIComponent('https://evil.test/x')}`, { maxRedirects: 0 });
    t('download refuses a link that is not a Teams file', evil.status() >= 400, String(evil.status()));

    await mock('/__mock/teams-fault', { uploadLimit: 2048 });
    await page.locator('input[type=file]').setInputFiles({ name: 'too-big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(4096, 65) });
    await page.getByText('Nothing was posted.').waitFor({ timeout: 20000 });
    const why = (await page.getByText('Nothing was posted.').textContent()) ?? '';
    t('upload refused: Teams’ reason shown, nothing posted', why.includes('this organization allows'), why);
    await mock('/__mock/teams-fault', {});
  });

  await step('pictures: paste, drop, see, enlarge, edit keeps them', async () => {
    // A picture made in the page, handed to the box the way the clipboard and a drag do.
    const give = (kind, side, noisy) =>
      page.evaluate(
        async ({ kind, side, noisy }) => {
          const c = document.createElement('canvas');
          c.width = side;
          c.height = Math.round(side * 0.6);
          const g = c.getContext('2d');
          if (noisy) {
            const img = g.createImageData(c.width, c.height);
            for (let i = 0; i < img.data.length; i += 1) img.data[i] = (i % 4 === 3) ? 255 : Math.floor(Math.random() * 256);
            g.putImageData(img, 0, 0);
          } else {
            g.fillStyle = '#bcd7f5';
            g.fillRect(0, 0, c.width, c.height);
            g.fillStyle = '#102347';
            g.fillRect(10, 10, c.width - 20, 20);
          }
          const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
          const dt = new DataTransfer();
          dt.items.add(new File([blob], `shot-${side}.png`, { type: 'image/png' }));
          const box = document.querySelector('.mail-editor-content');
          box.focus();
          if (kind === 'paste') box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          else box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
          return blob.size;
        },
        { kind, side, noisy },
      );
    const tray = page.getByRole('list', { name: 'Pictures in this message' });
    await give('paste', 320, false);
    await tray.locator('img').first().waitFor({ timeout: 15000 });
    t('pasted screenshot waits in the box as a picture', (await tray.locator('img').count()) === 1);
    await give('drop', 200, false);
    await until(async () => (await tray.locator('img').count()) === 2);
    t('dropped picture joins it', (await tray.locator('img').count()) === 2);
    await tray.getByRole('button', { name: /^Remove shot-200/ }).click();
    t('a picture can be taken off before sending', (await tray.locator('img').count()) === 1);
    await composer(page).click();
    await page.keyboard.type('Here is the screen');
    await page.keyboard.press('Enter');
    await idle(page);
    const sent = lastMessage(await world(), DIRECT);
    t('sent inside the message, as Teams keeps a pasted picture', Boolean(sent?.content.includes('Here is the screen') && /hostedContents\/[^/]+\/\$value/.test(sent.content) && sent.hosted && Object.keys(sent.hosted).length === 1), sent?.content?.slice(0, 200));
    const shown = page.locator('li[data-message]', { hasText: 'Here is the screen' }).locator('img.chat-img');
    await shown.waitFor({ timeout: 20000 });
    t('the sent picture shows in the chat, through this server', await until(async () => (await shown.evaluate((i) => i.complete && i.naturalWidth)) === 320) && ((await shown.getAttribute('src')) ?? '').startsWith('/api/msteams/image?'), await shown.getAttribute('src'));
    t('the box is empty again', (await tray.count()) === 0);

    await shown.click();
    const viewer = page.getByRole('dialog', { name: 'Picture' });
    await viewer.waitFor({ timeout: 5000 });
    t('a click opens it large, with Open full size', (await viewer.getByRole('link', { name: 'Open full size' }).count()) === 1);
    await page.keyboard.press('Escape');
    t('Escape closes it', await until(async () => (await viewer.count()) === 0));

    const mine = page.locator('li[data-message]', { hasText: 'Here is the screen' });
    await mine.hover();
    await mine.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit message' });
    t('edit says the picture stays', (await edit.getByText('The picture in this message stays as it is.').count()) === 1);
    await edit.locator('[contenteditable="true"]').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' now');
    await edit.getByRole('button', { name: 'Save' }).click();
    await idle(page);
    const after = (await world()).chats.find((c) => c.id === DIRECT).messages.find((x) => x.id === sent.id);
    t('edit changes the words and keeps the picture at Microsoft', Boolean(after?.content.includes('screen now') && /hostedContents\/[^/]+\/\$value/.test(after.content)), after?.content?.slice(0, 200));
    t('…and on screen', await until(async () => (await page.locator('li[data-message]', { hasText: 'screen now' }).locator('img.chat-img').count()) === 1));

    // A big photo is made smaller before it goes, so it fits Microsoft's 4 MB.
    const original = await give('paste', 2600, true);
    await tray.locator('img').first().waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await idle(page);
    const big = lastMessage(await world(), DIRECT);
    const hosted = Object.values(big?.hosted ?? {})[0];
    t('a big photo is shrunk and sent', Boolean(hosted && (hosted.bytes.data ?? hosted.bytes).length <= 1_200_000 && original > 1_200_000), `${original} -> ${(hosted?.bytes?.data ?? hosted?.bytes)?.length} ${hosted?.type}`);
    t('a picture on its own sends with no empty line above it', Boolean(big && !/^<p><\/p>/.test(big.content)), big?.content?.slice(0, 80));

    // Someone else's picture, received.
    await chatRow(page, 'Partner onboarding').click();
    const theirs = page.locator('li[data-message]', { hasText: 'Screenshot of the statement' }).locator('img.chat-img');
    await theirs.waitFor({ timeout: 30000 });
    t('a picture someone sent shows, not "open it in Teams"', await until(async () => (await theirs.evaluate((i) => i.complete && i.naturalWidth)) === 40));
    const src = (await theirs.getAttribute('src')) ?? '';
    const res = await page.request.get(`${BASE}${src}`);
    t('served as a picture, private, never sniffed', res.status() === 200 && res.headers()['content-type'] === 'image/png' && /private/.test(res.headers()['cache-control'] ?? '') && res.headers()['x-content-type-options'] === 'nosniff', `${res.status()} ${res.headers()['content-type']}`);
    const gone = await page.request.get(`${BASE}${src.replace(/h=[^&]+/, 'h=aWQ9bm9uZQ')}`);
    t('a picture that is not there is a 404', gone.status() === 404, String(gone.status()));
    const other = await page.request.get(`${BASE}${src.replace(/key=[^&]+/, `key=${encodeURIComponent('chat|00000000-0000-0000-0000-000000000000|19:x@thread.v2')}`)}`);
    t('another account’s conversation is refused', other.status() >= 400, String(other.status()));
    const bad = await page.request.get(`${BASE}/api/msteams/image?key=${encodeURIComponent(`chat|${memberIdentity}|${DIRECT}`)}&m=${encodeURIComponent('../../me/messages')}&h=x`);
    t('ids that try to leave the conversation are refused', bad.status() === 404, String(bad.status()));
    await chatRow(page, 'Mae Mate').click();
    await page.getByText('Yes, all done.').first().waitFor({ timeout: 30000 });
  });

  await step('not sent, then retry', async () => {
    await mock('/__mock/teams-fault', { chatSendFail: 'Sending is blocked in this chat.' });
    await typeAndSend(page, 'Retry me');
    await page.getByText('Not sent.').waitFor({ timeout: 20000 });
    t('failure: "Not sent." with the reason, text kept', (await page.getByRole('alert').filter({ hasText: 'Not sent.' }).textContent())?.includes('Sending is blocked') && ((await composer(page).textContent()) ?? '').includes('Retry me'));
    await mock('/__mock/teams-fault', {});
    await page.getByRole('button', { name: 'Retry' }).click();
    await idle(page);
    t('Retry sends it', lastMessage(await world(), DIRECT)?.content.includes('Retry me') && (await page.getByText('Not sent.').count()) === 0);
  });

  await step('favorites', async () => {
    const row = page.locator('li', { has: chatRow(page, 'Partner onboarding') });
    await row.hover();
    await page.getByRole('button', { name: 'Add Partner onboarding to Favorites' }).click();
    await page.getByRole('heading', { name: 'Favorites' }).waitFor({ timeout: 10000 });
    t('Favorites group appears, stored', await until(async () => (await q(`select 1 from teams_favorites where identity_id=$1`, [memberIdentity])).length === 1));
    await page.getByRole('button', { name: 'Remove Partner onboarding from Favorites' }).click();
    await idle(page);
    t('removed again', await until(async () => (await page.getByRole('heading', { name: 'Favorites' }).count()) === 0 && (await q(`select 1 from teams_favorites where identity_id=$1`, [memberIdentity])).length === 0));
  });

  await step('call', async () => {
    const [tab] = await Promise.all([m.ctx.waitForEvent('page'), page.getByRole('button', { name: 'Call' }).click()]);
    await tab.waitForLoadState().catch(() => {});
    t('Call opens Teams with the chat’s people, on the chat’s own account', /teams\.microsoft\.com\/l\/call/.test(tab.url()) && decodeURIComponent(tab.url()).includes('mate@mock.test') && /[?&]tenantId=/.test(tab.url()), tab.url());
    await tab.close();
    t('Call says which account Teams must be on', (await page.getByText('It has to be signed in as').count()) === 1);
  });

  await step('channel', async () => {
    await chatRow(page, 'General').click();
    await page.getByText('Welcome to the Sales team.').waitFor({ timeout: 30000 });
    const chKey = `channel|${memberIdentity}|team-sales-0001|19:general-sales@thread.tacv2`;
    const api = await (await page.request.get(`${BASE}/api/msteams/messages?key=${encodeURIComponent(chKey)}`)).json().catch(() => null);
    t('channel post with its thread reply', (await page.getByText('Thanks!').count()) >= 1, `${await page.getByText('Thanks!').count()} ${JSON.stringify(api?.messages?.map((x) => [x.text, x.replies?.length]) ?? api).slice(0, 200)}`);
    t('channel: no "Sent" read line, no quote button', (await page.getByText('Sent', { exact: true }).count()) === 0);
    const post = page.locator('li[data-message]', { hasText: 'Welcome to the Sales team.' }).first();
    await post.getByRole('button', { name: 'Reply', exact: true }).click();
    t('replying in the thread says so', (await page.getByText('Replying in the thread of Mae Mate').count()) === 1);
    await typeAndSend(page, 'Thread answer');
    await idle(page);
    const w = await world();
    const general = w.teams.find((x) => x.id === 'team-sales-0001').channels[0];
    t('thread reply posted under the post', await until(async () => (await world()).teams.find((x) => x.id === 'team-sales-0001').channels[0].messages[0].replies.some((r) => r.content.includes('Thread answer'))), JSON.stringify(general.messages[0].replies.map((r) => r.content)));
    t('still in the thread after replying', (await page.getByText('Replying in the thread of Mae Mate').count()) === 1);
    await page.getByRole('button', { name: 'Back to a new post' }).click();
    await typeAndSend(page, 'A new post');
    await idle(page);
    t('new channel post', await until(async () => (await world()).teams.find((x) => x.id === 'team-sales-0001').channels[0].messages.some((x) => x.content.includes('A new post'))));

    await page.getByRole('button', { name: 'Add channel' }).click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Add a channel to Sales' });
    await dlg.getByLabel('Channel name').fill('Verify channel');
    await dlg.getByRole('button', { name: 'Add', exact: true }).click();
    await chatRow(page, 'Verify channel').waitFor({ timeout: 30000 });
    t('Add channel: created and listed', (await world()).teams.find((x) => x.id === 'team-sales-0001').channels.some((c) => c.displayName === 'Verify channel'));
  });

  await step('new chat and new team', async () => {
    await page.locator('aside').getByTitle('New', { exact: true }).click();
    await page.getByRole('button', { name: 'New chat' }).click();
    let dlg = page.getByRole('dialog', { name: 'New chat' });
    await dlg.getByLabel('Search Microsoft contacts and Tenor users').fill('other@mock.test');
    await dlg.getByLabel('Search Microsoft contacts and Tenor users').press('Enter');
    await dlg.getByRole('button', { name: 'Start chat' }).click();
    await idle(page);
    t('new direct chat created at Microsoft and opened', (await world()).chats.some((c) => c.chatType === 'oneOnOne' && c.members.includes('oid-other') && c.members.includes('oid-owner')) && (await page.locator('main h2', { hasText: 'Otto Other' }).count()) === 1);

    await page.locator('aside').getByTitle('New', { exact: true }).click();
    await page.getByRole('button', { name: 'New team' }).click();
    dlg = page.getByRole('dialog', { name: 'New team' });
    await dlg.getByLabel('Team name').fill('Verify team');
    await dlg.getByLabel('Search Microsoft contacts and Tenor users').fill('mate@mock.test');
    await dlg.getByLabel('Search Microsoft contacts and Tenor users').press('Enter');
    await dlg.getByRole('button', { name: 'Create team' }).click();
    await dlg.waitFor({ state: 'detached', timeout: 40000 });
    const team = (await world()).teams.find((x) => x.displayName === 'Verify team');
    t('new team: owner is the member, the picked person was added once it was ready', team && team.owners[0] === 'oid-owner' && team.members.includes('oid-mate'), JSON.stringify(team?.members ?? null));
  });

  await step('offline', async () => {
    await chatRow(page, 'Mae Mate').click();
    await page.getByText('Yes, all done.').first().waitFor({ timeout: 20000 });
    await m.ctx.setOffline(true);
    await page.waitForTimeout(500);
    t('offline: says so, sending switched off', (await page.getByText('You are offline. This is the data already loaded.').count()) === 1 && (await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()));
    await m.ctx.setOffline(false);
    await page.waitForTimeout(800);
    t('back online: sending on again', !(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()));
  });

  await step('Microsoft not responding', async () => {
    await mock('/__mock/teams-fault', { down: true });
    await db.query(`update teams_snapshots set fetched_at = now() - interval '10 minutes' where identity_id=$1`, [memberIdentity]);
    await go(page, '/chat');
    await page.getByText('Microsoft is not responding.').waitFor({ timeout: 30000 });
    t('down: last loaded chats kept, with the notice', (await chatRow(page, 'Mae Mate').count()) === 1);
    await mock('/__mock/teams-fault', {});
  });

  await step('browser gate', async () => {
    const ff = await session(member.cookies, { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0' });
    await go(ff.page, '/chat');
    t('not Chrome: "Chat is not supported here"', (await ff.page.getByText('Chat is not supported here').count()) === 1);
    await ff.ctx.close();
  });

  /* ── who may look ───────────────────────────────────────────────────── */
  const a = await session(admin.cookies);
  shotPage = a.page;
  await step('admin connects', async () => {
    await go(a.page, '/chat');
    t('All users does not skip the Connect screen', (await heading(a.page)) === 'Connect Microsoft to use Chat');
    await a.page.getByRole('button', { name: 'Connect Microsoft' }).click();
    await pick(a.page, 'mate@mock.test');
    await a.page.waitForURL(/\/chat/, { timeout: 90000 });
    await a.page.waitForLoadState('networkidle');
    t('admin connected straight to Chat', (await chatRow(a.page, 'Olive Owner').count()) === 1);
  });

  await step('admin looks at the member', async () => {
    await go(a.page, `/calendar?as=${member.id}`);
    await a.page.getByText('This is look only').waitFor({ timeout: 30000 });
    await a.page.getByTestId('range').waitFor();
    await a.page.locator('[data-event="Private"]').first().waitFor({ timeout: 30000 });
    t('look only: private event shows as Private, no title', (await ev(a.page, 'Dentist appointment').count()) === 0);
    await ev(a.page, 'Private').first().click();
    t('look only: "This event is private."', (await a.page.getByText('This event is private.').count()) === 1);
    await a.page.keyboard.press('Escape');
    t('look only: New and Meet now off', (await a.page.getByRole('button', { name: 'Meet now' }).isDisabled()) && (await a.page.getByRole('button', { name: 'New' }).isDisabled()));
    await ev(a.page, 'Merchant kickoff').first().click();
    t('look only: no answering for them', (await a.page.getByRole('dialog').getByRole('button', { name: 'Accept' }).count()) === 0);
    await a.page.keyboard.press('Escape');

    await go(a.page, `/chat?as=${member.id}`);
    await chatRow(a.page, 'Mae Mate').waitFor({ timeout: 30000 });
    await chatRow(a.page, 'Mae Mate').click();
    await a.page.getByText('Yes, all done.').first().waitFor({ timeout: 30000 });
    t('look only: footer instead of a composer', (await a.page.getByText('Look only. Nothing can be sent from someone else’s chats.').count()) === 1 && (await a.page.locator('[contenteditable="true"]').count()) === 0);
    t('look only: no New, no favorites', (await a.page.getByTitle('New').count()) === 0 && (await a.page.getByRole('button', { name: /to Favorites$/ }).count()) === 0);
    const readBefore = (await world()).chats.find((c) => c.id === DIRECT).readAt['oid-owner'];
    await idle(a.page);
    t('looking does not mark their chat read', (await world()).chats.find((c) => c.id === DIRECT).readAt['oid-owner'] === readBefore);
  });

  await step('member may not look at the admin', async () => {
    shotPage = page;
    const adminId = admin.id;
    await go(page, `/chat?as=${adminId}`);
    await idle(page);
    t('Own only: refused, and none of their chats', (await chatRow(page, 'Olive Owner').count()) === 0 && (await page.locator('[role=status]').filter({ hasText: /not|only/i }).count()) >= 1);
    const api = await page.request.get(`${BASE}/api/msteams/chats?as=${adminId}`);
    t('Own only: the API refuses too', api.status() === 403 || api.status() === 404, String(api.status()));
    const cal = await page.request.get(`${BASE}/api/msteams/calendar?as=${adminId}&start=2026-11-01T00:00:00.000Z&end=2026-11-08T00:00:00.000Z&timeZone=UTC`);
    t('Own only: calendar API refuses', cal.status() === 403 || cal.status() === 404, String(cal.status()));
  });

  await step('hide my chat', async () => {
    shotPage = a.page;
    await go(a.page, '/email/settings');
    const chatSwitch = a.page.getByRole('switch', { name: /chat/i });
    if ((await chatSwitch.count()) === 0) {
      t('hide switches shown to an admin', false);
      return;
    }
    const settled = () => until(async () => await chatSwitch.first().isEnabled(), 90000);
    await chatSwitch.first().check();
    await settled();
    t('hide my chat: saved', (await q(`select hide_my_chat from mail_user_settings where user_id=$1`, [admin.id]))[0]?.hide_my_chat === true);
    await chatSwitch.first().uncheck();
    await settled();
    t('hide my chat: cleared', (await q(`select hide_my_chat from mail_user_settings where user_id=$1`, [admin.id]))[0]?.hide_my_chat === false);
    await go(page, '/email/settings');
    t('member: no hide switches', (await page.getByRole('switch', { name: /chat|calendar/i }).count()) === 0);
  });

  await step('reconnect state', async () => {
    holding = false;
    await new Promise((r) => setTimeout(r, 1600));
    await db.query(`update mail_identities set status='broken' where id=$1`, [memberIdentity]);
    await go(page, '/chat');
    await page.getByText('Microsoft stopped accepting owner@mock.test').waitFor({ timeout: 30000 });
    t('broken connection: Reconnect notice, last data kept', (await page.getByRole('button', { name: 'Reconnect' }).count()) === 1 && (await chatRow(page, 'Mae Mate').count()) === 1);
    await db.query(`update mail_identities set status='ok' where id=$1`, [memberIdentity]);
    holding = true;
  });
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  clearTimeout(watchdog);
  clearInterval(holder);
  holding = false;
  await browser.close().catch(() => {});
  // Remove everything the run created.
  for (const [id, seen] of seenBefore) await db.query(`update profiles set last_seen_at = $2 where id=$1`, [id, seen]).catch((e) => fail.push(`restore last_seen_at: ${e}`));
  for (const id of ids) {
    const was = settingsBefore.find((r) => r.user_id === id);
    if (was) await db.query(`update mail_user_settings set hide_my_chat=$2, hide_my_calendar=$3 where user_id=$1`, [id, was.hide_my_chat, was.hide_my_calendar]).catch(() => {});
    else await db.query(`delete from mail_user_settings where user_id=$1`, [id]).catch(() => {});
  }
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = any($1) and microsoft_user_id like 'oid-%'`, [[admin.id, member.id]]);
  await db.query(`delete from teams_pending_approvals where user_id = any($1) and not (user_id = any($2))`, [[admin.id, member.id], pendingBefore]);
  await db.query(`delete from teams_counts where user_id = any($1) and not (user_id = any($2))`, [ids, countsRowsBefore]);
  await cleanRate();
  const afterCounts = await counts();
  const drift = TABLES.filter((name) => afterCounts[name] !== before[name]);
  t('every mail_* and teams_* table back to its starting count', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${afterCounts[d]}`).join(', '));
  const afterOther = await otherCounts();
  t('records, activity and profiles untouched', JSON.stringify(afterOther) === JSON.stringify(beforeOther));
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
