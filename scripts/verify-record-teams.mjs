/**
 * Teams on a merchant record, end to end in a real browser, against the mock Microsoft
 * (`scripts/mail-mock-graph.mjs` + `scripts/mail-mock-teams.mjs`).
 *
 * A member and an admin connect different mock accounts, so the question this feature
 * lives or dies on can be tested for real: linking a chat to a record must not hand it
 * to everyone who can open the record. A chat is read only by people in it, or by a
 * holder of All users (look only), and Microsoft's own answer decides.
 *
 * Writes two probe records, the two test accounts' mock identities, and temporary
 * settings on the member, and removes them at the end. Every mail_* and teams_* table count is
 * compared. The probe's activity entries stay behind by design: record_activity is
 * append-only and survives a record being removed.
 *
 *   node scripts/mail-mock-graph.mjs
 *   MAIL_PROVIDER=mock MAIL_MOCK_BASE_URL=http://127.0.0.1:4555 MAIL_ALLOWED_TENANT_IDS=tid-tapdash \
 *   MAIL_REDIRECT_URI=http://localhost:3221/api/mail/oauth/callback npx next dev -p 3221
 *   node --env-file=.env scripts/verify-record-teams.mjs
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
const MEMBER = 'itest-invited-1788686334823@tapdash.test';
for (const e of [ADMIN, MEMBER]) if (!/@([a-z0-9-]+\.)*test$/i.test(e)) process.exit(1);

// A pool, not one client: a dropped connection is replaced, where a lone client takes the
// whole process down before `finally` can clean the shared database.
const db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 3, keepAlive: true });
db.on('error', (e) => console.error('[pool] connection dropped, carrying on:', e.message));
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const mock = async (path, body) => {
  const r = await fetch(`${MOCK}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const world = () => mock('/__mock/teams');

const TABLES = (await q(`select table_name t from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and (table_name like 'mail\\_%' or table_name like 'teams\\_%' or table_name = 'record_teams_links') order by 1`)).map((r) => r.t);
const counts = async () => {
  const out = {};
  for (const t of TABLES) out[t] = (await q(`select count(*)::int n from public.${t}`))[0].n;
  return out;
};
const before = await counts();
const recordsBefore = (await q(`select count(*)::int n from records`))[0].n;

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
const savedHashes = new Map();
const seenBefore = new Map();
async function cookiesFor(email) {
  const [u] = await q(`select id, last_seen_at from profiles where email=$1`, [email]);
  if (!seenBefore.has(u.id)) seenBefore.set(u.id, u.last_seen_at);
  await db.query(`update profiles set last_seen_at = now() where id=$1`, [u.id]);
  const PW = 'ZzProbe-2026!rteams';
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

const member = await cookiesFor(MEMBER);
const admin = await cookiesFor(ADMIN);
const ids = [member.id, admin.id];
const cleanRate = () => db.query(`delete from rate_limit_counters where key like any($1)`, [ids.flatMap((id) => [`teams%:user:${id}`, `mail_connect:user:${id}`, `mail_action:user:${id}`])]);
const countsRowsBefore = (await q(`select user_id from teams_counts where user_id = any($1)`, [ids])).map((r) => r.user_id);
const settingsBefore = await q(`select user_id, hide_my_chat, hide_my_calendar from mail_user_settings where user_id = any($1)`, [ids]);
const SETTINGS = ['chat.scope', 'communication.scope', 'team.sales_agent.see_open', 'action.team_view_open'];
const permsBefore = await q(`select * from permission_settings where owner_kind='user' and owner_id=$1 and key = any($2)`, [member.id, SETTINGS]);
await cleanRate();

// The sub-tab is found by its flag, as the app finds it.
const [where] = await q(`select s.id subtab_id, s.key subtab_key, s.coming_soon, t.id tab_id, t.key tab_key from subtabs s join tabs t on t.id = s.tab_id where s.shows_record_chats`);
t('migration: one sub-tab flagged, coming_soon left true for older builds', Boolean(where) && where.coming_soon === true);

const contacts = (await q(`select id, slug from modules where slug='contacts'`))[0];
const tag = Math.random().toString(36).slice(2, 8);
const NAME = `ZZ teams probe ${tag}`;
const [probe] = await q(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, $3::jsonb) returning id`, [NAME, admin.id, JSON.stringify({ legal_business_name: `${NAME} LLC`, team_members_assigned: [admin.id, member.id] })]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, contacts.id, admin.id]);
await q(`insert into record_team_members (record_id, user_id) values ($1, $2), ($1, $3) on conflict do nothing`, [probe.id, admin.id, member.id]).catch(() => {});
const recordUrl = (subtab = where.subtab_key) => `/${contacts.slug}?record=${probe.id}&tab=${where.tab_key}&subtab=${subtab}`;

/*
 * Communication has no tab or sub-tab level (a trigger refuses one), so View and Hidden
 * are produced the way they really arise. This record's team leaves the member out:
 * they cannot open it (Hidden) until its assignment is open and they may see open ones,
 * and then they can only read it until they take it (View).
 */
const NAME_B = `ZZ teams probe other ${tag}`;
const [probeB] = await q(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, $3::jsonb) returning id`, [NAME_B, admin.id, JSON.stringify({ legal_business_name: `${NAME_B} LLC`, team_members_assigned: [admin.id] })]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probeB.id, contacts.id, admin.id]);
const recordBUrl = `/${contacts.slug}?record=${probeB.id}&tab=${where.tab_key}&subtab=${where.subtab_key}`;
const setSetting = async (key, value) => {
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1 and key=$2`, [member.id, key]);
  if (value !== null) await db.query(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, $3)`, [member.id, key, value]);
};
await setSetting('communication.scope', 'own');
await setSetting('chat.scope', 'own');

let holding = true;
const holdMock = async () => {
  if (!holding) return;
  await db.query(`update mail_mailboxes set lease_until = now() + interval '1 hour', lease_owner = 'verify-record-teams', next_sync_at = now() + interval '1 hour' where address like '%@mock.test'`);
  await db.query(`update mail_identities set status = 'ok' where user_id = any($1) and microsoft_user_id like 'oid-%' and deleted_at is null and status in ('broken', 'degraded')`, [ids]);
  await db.query(`update mail_connections set status = 'ok' where user_id = any($1) and status in ('broken', 'degraded') and disconnected_at is null and mailbox_id in (select id from mail_mailboxes where address like '%@mock.test')`, [ids]);
};
const holder = setInterval(() => void holdMock().catch(() => {}), 1500);

await mock('/__mock/reset', {});
await mock('/__mock/teams-seed', {});
const SECRET = `Back office secret ${tag}`;
const backOffice = await mock('/__mock/teams-chat', { chatType: 'group', topic: `Back office ${tag}`, members: ['mate@mock.test', 'other@mock.test'], from: 'other@mock.test', html: `<p>${SECRET}</p>` });

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
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const connect = async (page, account) => {
  await go(page, '/chat');
  await page.getByRole('button', { name: 'Connect Microsoft' }).click();
  await page.waitForURL(/oauth2\/v2\.0\/authorize/, { timeout: 30000 });
  await page.click(`a[data-account="${account}"]`);
  await page.waitForURL(/\/chat/, { timeout: 90000 });
  await idle(page);
};
const linksFor = () => q(`select * from record_teams_links where record_id=$1 order by linked_at`, [probe.id]);
const api = (page) => page.request.get(`${BASE}/api/msteams/record-chats?record=${probe.id}`);
const composer = (page) => page.locator('[contenteditable="true"]').last();
const DIRECT = '19:direct-owner-mate@unq.gbl.spaces';
const DIRECT_TITLE = 'Olive Owner, Mae Mate';
const lastText = (w, chatId) => {
  const c = w.chats.find((x) => x.id === chatId);
  return c?.messages[c.messages.length - 1]?.content ?? '';
};
// Inside the dialog only: the cards behind it are list items with buttons too.
const pickInDialog = (page, text) => page.getByRole('dialog', { name: 'Link a chat' }).locator('li button', { hasText: text });
// The newest link opens first, so a particular chat has to be picked.
const openCard = (page, title) => page.getByRole('button', { name: new RegExp(title) }).first().click();

let memberIdentity = null;
let adminIdentity = null;

try {
  const m = await session(member.cookies);
  const a = await session(admin.cookies);
  const page = m.page;
  const adminPage = a.page;

  /*
   * `next dev` compiles a route the first time it is asked for, which can outlast a
   * step's timeout and read as a failure. So everything is asked for once up front,
   * and the times are printed: a route still slow after this is a real finding.
   */
  await step('warm up', async () => {
    for (const path of [recordUrl(), '/chat', '/admin/integrations']) {
      const started = Date.now();
      await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 300000 });
      console.log(`warm ${path.split('?')[0]} ${Date.now() - started} ms`);
    }
    for (const path of [`/api/msteams/record-chats?record=${probe.id}`, '/api/msteams/chats', `/api/msteams/chat-records?key=${encodeURIComponent('chat|x|y')}`, `/api/msteams/messages?key=${encodeURIComponent('chat|x|y')}`, '/api/msteams/counts']) {
      for (const round of ['cold', 'warm']) {
        const started = Date.now();
        const r = await page.request.get(`${BASE}${path}`, { timeout: 300000 });
        console.log(`${round} ${path.split('?')[0]} ${r.status()} ${Date.now() - started} ms`);
      }
    }
  });

  await step('before connecting', async () => {
    await go(page, recordUrl());
    await page.getByText('No chats linked yet').waitFor({ timeout: 30000 });
    // Asked only now: on an error page this would pass having proved nothing.
    t('member: the Teams sub-tab no longer says Coming soon', (await page.getByText('Coming soon', { exact: false }).count()) === 0);
    t('no account: told to connect, and where', (await page.getByRole('link', { name: 'Chat', exact: true }).filter({ hasText: 'Chat' }).count()) >= 1 && (await page.getByText('to read and link chats here').count()) === 1);
    t('no account: nothing to link with', (await page.getByRole('button', { name: 'Link a chat' }).count()) === 0);
    await shot(page, 'rt-1-no-account');
  });

  await step('admin approval, before anyone has been told to wait', async () => {
    await go(page, '/chat');
    await page.getByText('Microsoft says you need admin approval? Ask your admin').click();
    const text = await page.getByLabel('Request for your Microsoft admin').inputValue();
    t('Connect screen: the request for the admin is there, with the approval link', /adminconsent\?/.test(text) && text.includes('client_id='), text.slice(0, 60));
    await shot(page, 'rt-1b-connect-request');
  });

  await step('connect', async () => {
    await connect(page, 'owner@mock.test');
    await connect(adminPage, 'mate@mock.test');
    memberIdentity = (await q(`select id from mail_identities where user_id=$1 and microsoft_user_id='oid-owner' and deleted_at is null`, [member.id]))[0]?.id;
    adminIdentity = (await q(`select id from mail_identities where user_id=$1 and microsoft_user_id='oid-mate' and deleted_at is null`, [admin.id]))[0]?.id;
    t('both mock accounts connected', Boolean(memberIdentity && adminIdentity));
    await holdMock();
  });

  await step('member links a chat', async () => {
    await go(page, recordUrl());
    await page.getByRole('button', { name: 'Link a chat' }).click();
    await page.getByRole('heading', { name: 'Link a chat' }).waitFor();
    t('link dialog: says who will see what', (await page.getByText('Only people in the chat can read it.').count()) === 1);
    await pickInDialog(page, 'Mae Mate').first().waitFor({ timeout: 30000 });
    await shot(page, 'rt-2-link-dialog');
    await page.getByPlaceholder('Search your chats').fill('partner');
    t('link dialog: search narrows the list', (await pickInDialog(page, 'Mae Mate').count()) === 0 && (await pickInDialog(page, 'Partner onboarding').count()) === 1);
    await page.getByPlaceholder('Search your chats').fill('');
    await pickInDialog(page, 'Mae Mate').first().click();
    await page.getByRole('heading', { name: 'Link a chat' }).waitFor({ state: 'detached', timeout: 30000 });
    await page.getByText(DIRECT_TITLE).first().waitFor({ timeout: 30000 });

    const rows = await linksFor();
    t('stored once, without an account in it', rows.length === 1 && rows[0].ref_key === `chat|${DIRECT}` && rows[0].linked_identity_id === memberIdentity && rows[0].linked_by === member.id);
    t('stored name comes from Microsoft, and names everyone in the chat', rows[0]?.title === DIRECT_TITLE, rows[0]?.title);
    t('no message text stored on the link', !JSON.stringify(rows[0] ?? {}).includes('all done'));
    const act = await q(`select kind, summary, actor_id from record_activity where record_id=$1 and kind='teams'`, [probe.id]);
    t('history: linked entry, by the member', act.length === 1 && act[0].summary === 'Linked a Teams chat' && act[0].actor_id === member.id, act[0]?.summary);
    t('history: the chat\'s name stays out of it', !act[0]?.summary.includes('Mae Mate'));

    await page.getByText('Yes, all done.', { exact: false }).first().waitFor({ timeout: 30000 });
    t('the conversation opens under the card, with its messages', true);
    await shot(page, 'rt-3-linked');
  });

  await step('working in the chat from the record', async () => {
    const text = `From the record ${tag}`;
    await composer(page).click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    t('reply from the record reaches Microsoft', await until(async () => lastText(await world(), DIRECT).includes(text)), lastText(await world(), DIRECT).slice(0, 60));
    const bubble = page.getByText(text).last();
    await bubble.waitFor({ timeout: 20000 });
    await bubble.hover();
    await page.waitForTimeout(200);
    t('own message: Edit is offered on the record', (await page.getByRole('button', { name: 'Edit' }).count()) >= 1);
    t('vocabulary: no Delete button anywhere in the record', (await page.getByRole('button', { name: /delete/i }).count()) === 0);
    const words = (await page.locator('[role="dialog"]').first().innerText()).toLowerCase();
    t('vocabulary: the word "delete" is absent from the drawer', !words.includes('delet'));
  });

  await step('a message removed in Chat', async () => {
    await mock('/__mock/teams-message', { chatId: DIRECT, from: 'mate@mock.test', html: `<p>Removable ${tag}</p>` });
    const w = await world();
    const target = w.chats.find((c) => c.id === DIRECT).messages.find((x) => x.content.includes(`Removable ${tag}`));
    t('fixture: the message exists on Microsoft', Boolean(target));
    await mock('/__mock/teams-soft-delete', { chatId: DIRECT, messageId: target.id });
    await go(page, recordUrl());
    await page.getByText('Message removed').first().waitFor({ timeout: 30000 });
    t('on the record it reads "Message removed"', (await page.getByText('Message deleted').count()) === 0);
  });

  await step('a channel', async () => {
    await page.getByRole('button', { name: 'Link a chat' }).click();
    await pickInDialog(page, 'General').first().waitFor({ timeout: 30000 });
    t('link dialog: the chat already linked is not offered again', (await pickInDialog(page, 'Mae Mate').count()) === 0);
    await pickInDialog(page, 'General').first().click();
    await page.getByRole('heading', { name: 'Link a chat' }).waitFor({ state: 'detached', timeout: 30000 });
    await page.getByRole('button', { name: /General/ }).first().waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: /General/ }).first().click();
    await page.getByText('Welcome to the Sales team.').first().waitFor({ timeout: 30000 });
    const rows = await linksFor();
    const ch = rows.find((r) => r.conversation_kind === 'channel');
    t('channel stored with its team', ch?.team_name === 'Sales' && ch?.title === 'General' && ch?.ref_key.startsWith('channel|'), JSON.stringify({ team: ch?.team_name, title: ch?.title }));
  });

  await step('the admin, who is in the direct chat too', async () => {
    await go(adminPage, recordUrl());
    await openCard(adminPage, DIRECT_TITLE);
    await adminPage.getByText('Yes, all done.', { exact: false }).first().waitFor({ timeout: 30000 });
    const body = await (await api(adminPage)).json();
    const direct = body.links.find((l) => l.title === DIRECT_TITLE);
    t('admin: reads with their OWN account, not the linker\'s', direct?.access === 'member' && direct.chat.identityId === adminIdentity, direct?.access);
    t('admin: can reply there', (await composer(adminPage).count()) === 1);
  });

  await step('a chat the member is not in', async () => {
    await adminPage.getByRole('button', { name: 'Link a chat' }).click();
    await pickInDialog(adminPage, `Back office ${tag}`).first().waitFor({ timeout: 30000 });
    await pickInDialog(adminPage, `Back office ${tag}`).first().click();
    await adminPage.getByRole('heading', { name: 'Link a chat' }).waitFor({ state: 'detached', timeout: 30000 });
    await until(async () => (await linksFor()).some((r) => r.title === `Back office ${tag}`));

    await go(page, recordUrl());
    const ownRaw = await (await api(page)).text();
    t('Own only: not even the card of a chat they are not in', !ownRaw.includes(`Back office ${tag}`) && !ownRaw.includes(SECRET) && (await page.getByText(`Back office ${tag}`).count()) === 0);
    t('Own only: their own chats are still there', ownRaw.includes(DIRECT_TITLE));
    await shot(page, 'rt-4a-own-only');

    await setSetting('communication.scope', 'org');
    await go(page, recordUrl());
    await page.getByText(`Back office ${tag}`).first().waitFor({ timeout: 30000 });
    t('Whole org: sees the card, and why it cannot be read', (await page.getByText('Only people in this chat can read it.').count()) === 1);
    t('member: the message is not on the page', (await page.getByText(SECRET).count()) === 0 && !(await page.content()).includes(SECRET));
    const res = await api(page);
    const raw = await res.text();
    const body = JSON.parse(raw);
    const card = body.links.find((l) => l.title === `Back office ${tag}`);
    t('member: the API sends the card and nothing of the chat', card?.access === 'none' && card.chat === null && !raw.includes(SECRET), card?.access);
    t('member: the admin\'s account id is not sent', !raw.includes(adminIdentity));
    await shot(page, 'rt-4-not-in-chat');

    const viaAdmin = await page.request.get(`${BASE}/api/msteams/messages?key=${encodeURIComponent(`chat|${adminIdentity}|${backOffice.id}`)}`);
    const viaAdminText = await viaAdmin.text();
    t('forged key: the admin\'s account is refused', viaAdmin.status() >= 400 && !viaAdminText.includes(SECRET), String(viaAdmin.status()));
    const viaOwn = await page.request.get(`${BASE}/api/msteams/messages?key=${encodeURIComponent(`chat|${memberIdentity}|${backOffice.id}`)}`);
    const viaOwnText = await viaOwn.text();
    t('forged key: their own account gets nothing (Microsoft says no)', !viaOwnText.includes(SECRET), String(viaOwn.status()));
  });

  await step('All users is look only', async () => {
    await setSetting('chat.scope', 'all');
    await go(page, recordUrl());
    const body = await (await api(page)).json();
    const card = body.links.find((l) => l.title === `Back office ${tag}`);
    t('All users: read through the account that linked it', card?.access === 'look' && card.chat?.identityId === adminIdentity, card?.access);
    await page.getByRole('button', { name: new RegExp(`Back office ${tag}`) }).first().click();
    await page.getByText(SECRET).first().waitFor({ timeout: 30000 });
    t('All users: labelled look only', (await page.getByText('Look only, through', { exact: false }).count()) === 1);
    t('All users: no composer', (await page.locator('[contenteditable="true"]').count()) === 0);
    await shot(page, 'rt-5-look-only');

    await db.query(`insert into mail_user_settings (user_id, hide_my_chat) values ($1, true) on conflict (user_id) do update set hide_my_chat = true`, [admin.id]);
    const hidden = await (await api(page)).json();
    const after = hidden.links.find((l) => l.title === `Back office ${tag}`);
    t('the owner hid theirs: back to the card, whoever holds All users', after?.access === 'none' && after.chat === null, after?.access);
    await db.query(`update mail_user_settings set hide_my_chat = false where user_id=$1`, [admin.id]);
    await setSetting('chat.scope', 'own');
    const own = await (await api(page)).json();
    t('Own only again: back to the card', own.links.find((l) => l.title === `Back office ${tag}`)?.access === 'none');
  });

  await step('Microsoft is down', async () => {
    await mock('/__mock/teams-fault', { down: true });
    await go(page, recordUrl());
    await page.getByText('Microsoft did not answer.', { exact: false }).first().waitFor({ timeout: 30000 });
    t('outage: says so, instead of claiming the member is not in the chat', (await page.getByText('Microsoft did not answer.', { exact: false }).count()) >= 2);
    await shot(page, 'rt-6-outage');
    await setSetting('communication.scope', 'own');
    const short = await (await api(page)).json();
    t('outage, Own only: the list says it may be short', short.someUnavailable === true);
    await setSetting('communication.scope', 'org');
    await mock('/__mock/teams-fault', {});
    await holdMock();
  });

  await step('hidden: a record they cannot open', async () => {
    await db.query(`select record_teams_link($1, $2, $3, 'chat', $4, null, null, $5, 'oneOnOne', $6, null)`, [probeB.id, member.id, memberIdentity, DIRECT, `chat|${DIRECT}`, DIRECT_TITLE]);
    const res = await page.request.get(`${BASE}/api/msteams/record-chats?record=${probeB.id}`);
    t('hidden: the API refuses, even though the member made the link', res.status() === 404 && !(await res.text()).includes(DIRECT_TITLE), String(res.status()));
    await go(page, '/chat');
    await page.locator('button[data-chat="Mae Mate"]').click();
    await page.getByRole('link', { name: NAME, exact: true }).waitFor({ timeout: 30000 });
    t('hidden: no chip for it in Chat, not even a count', (await page.getByRole('link', { name: NAME_B }).count()) === 0);
    await page.getByRole('button', { name: 'Link to a record' }).click();
    await page.getByPlaceholder('Search by merchant name').fill(NAME_B);
    await page.getByText('No records you can link this to.').waitFor({ timeout: 30000 });
    t('hidden: not offered as somewhere to link', true);
    await page.keyboard.press('Escape');
  });

  await step('view only: an open assignment they have not taken', async () => {
    const [team] = await q(`select id from permission_templates where user_type='sales_agent'`);
    await db.query(`insert into record_team_assignments (record_id, team_id, assigned_by) values ($1, $2, $3)`, [probeB.id, team.id, admin.id]);
    await setSetting('team.sales_agent.see_open', 'yes');

    // In their list, but the drawer says "Take this record to open it".
    const listed = await page.request.get(`${BASE}/api/msteams/record-chats?record=${probeB.id}`);
    t('listed but not opened: the API refuses, as the drawer does', listed.status() === 404 && !(await listed.text()).includes(DIRECT_TITLE), String(listed.status()));
    const chips = await (await page.request.get(`${BASE}/api/msteams/chat-records?key=${encodeURIComponent(`chat|${memberIdentity}|${DIRECT}`)}`)).text();
    t('listed but not opened: no chip in Chat', !chips.includes(NAME_B));
    await go(page, recordBUrl);
    await page.getByText('Take this record to open it').waitFor({ timeout: 30000 });
    t('listed but not opened: the drawer agrees', (await page.getByText(DIRECT_TITLE).count()) === 0);

    await setSetting('action.team_view_open', 'yes');
    await go(page, recordBUrl);
    await page.getByText('Yes, all done.', { exact: false }).first().waitFor({ timeout: 30000 });
    t('view only: no Link', (await page.getByRole('button', { name: 'Link a chat' }).count()) === 0);
    t('view only: no Unlink', (await page.getByRole('button', { name: 'Unlink' }).count()) === 0);
    t('view only: no composer, and it says where to reply', (await page.locator('[contenteditable="true"]').count()) === 0 && (await page.getByText('To reply, open it in Chat.').count()) === 1);
    const viewBody = await (await page.request.get(`${BASE}/api/msteams/record-chats?record=${probeB.id}`)).json();
    t('view only: the API says so too', viewBody.canEdit === false && viewBody.links[0]?.access === 'member');
    await shot(page, 'rt-7-view-only');
  });

  await step('from the Chat module', async () => {
    await go(page, '/chat');
    await page.locator('button[data-chat="Mae Mate"]').click();
    const chip = page.getByRole('link', { name: NAME });
    await chip.waitFor({ timeout: 30000 });
    t('Chat: the record shows under the header', true);
    await shot(page, 'rt-8-chat-chip');
    await chip.click();
    await page.waitForURL(new RegExp(`record=${probe.id}`), { timeout: 60000 });
    await openCard(page, DIRECT_TITLE);
    await page.getByText('Yes, all done.', { exact: false }).first().waitFor({ timeout: 45000 });
    t('Chat: the chip opens the record on its Teams sub-tab', page.url().includes(`subtab=${where.subtab_key}`), page.url().slice(0, 140));

    await go(page, '/chat');
    await page.locator('button[data-chat="Partner onboarding"]').click();
    await page.getByRole('button', { name: 'Link to a record' }).click();
    await page.getByPlaceholder('Search by merchant name').fill(NAME);
    const row = page.locator('li', { hasText: NAME }).getByRole('button', { name: 'Link' });
    await row.waitFor({ timeout: 30000 });
    await shot(page, 'rt-9-record-picker');
    await row.click();
    await page.getByRole('link', { name: NAME }).waitFor({ timeout: 30000 });
    t('Chat: links a chat to a record', (await linksFor()).some((r) => r.title === 'Partner onboarding'));
    await page.getByRole('button', { name: 'Link to a record' }).click();
    await page.getByPlaceholder('Search by merchant name').fill(NAME);
    await page.getByText('No records you can link this to.').waitFor({ timeout: 30000 });
    t('Chat: a record it is already on is not offered', true);

    await page.getByPlaceholder('Search by merchant name').fill(NAME_B);
    await page.getByText('No records you can link this to.').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);
    await idle(page);
    t('Chat: a record they can only read is not offered', (await page.locator('li', { hasText: NAME_B }).getByRole('button', { name: 'Link' }).count()) === 0);
    await page.keyboard.press('Escape');
  });

  await step('unlink', async () => {
    await go(page, recordUrl());
    const before = (await world()).chats.find((c) => c.id === DIRECT).messages.length;
    const card = page.locator('li', { hasText: DIRECT_TITLE });
    await card.getByRole('button', { name: 'Unlink' }).click();
    await page.getByText('The chat stays in Teams', { exact: false }).waitFor();
    await shot(page, 'rt-10-unlink');
    await page.getByRole('button', { name: 'Unlink', exact: true }).last().click();
    await until(async () => !(await linksFor()).some((r) => r.title === DIRECT_TITLE));
    t('unlink: off the record', !(await linksFor()).some((r) => r.title === DIRECT_TITLE));
    t('unlink: nothing changed in Teams', (await world()).chats.find((c) => c.id === DIRECT).messages.length === before);
    t('unlink: logged', (await q(`select 1 from record_activity where record_id=$1 and kind='teams' and summary = 'Unlinked a Teams chat' and actor_id=$2`, [probe.id, member.id])).length === 1);
    await page.getByText(DIRECT_TITLE).first().waitFor({ state: 'detached', timeout: 30000 });
    t('unlink: the card goes without a reload', true);
    await go(page, '/chat');
    t('unlink: the chat is still in the Chat module', (await page.locator('button[data-chat="Mae Mate"]').count()) === 1);
  });

  await step('the rest of Communication is unchanged', async () => {
    await go(page, recordUrl('email'));
    t('Email sub-tab: not the chats panel', (await page.getByText('linked chat', { exact: false }).count()) === 0 && (await page.getByText('No chats linked yet').count()) === 0);
    await go(page, recordUrl('phone'));
    t('Phone sub-tab: not the chats panel', (await page.getByText('linked chat', { exact: false }).count()) === 0);
  });

  await step('integrations page', async () => {
    await go(adminPage, '/admin/integrations');
    const row = adminPage.locator('li, tr, article, div').filter({ hasText: 'Teams on records' }).last();
    const text = await row.innerText();
    t('Integrations: no longer "Coming soon" or "Kept for later"', !/coming soon|kept for later/i.test(text), text.slice(0, 160));
    await shot(adminPage, 'rt-11-integrations');
  });
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  clearTimeout(watchdog);
  clearInterval(holder);
  holding = false;
  await browser.close().catch(() => {});
  await mock('/__mock/teams-fault', {}).catch(() => {});
  // Remove everything the run created.
  await db.query(`delete from records where id = any($1::uuid[])`, [[probe.id, probeB.id]]).catch((e) => fail.push(`remove probes: ${e}`));
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1 and key = any($2)`, [member.id, SETTINGS]).catch(() => {});
  for (const p of permsBefore) {
    const cols = Object.keys(p);
    await db.query(`insert into permission_settings (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => p[c])).catch((e) => fail.push(`restore setting: ${e}`));
  }
  for (const [id, seen] of seenBefore) await db.query(`update profiles set last_seen_at = $2 where id=$1`, [id, seen]).catch((e) => fail.push(`restore last_seen_at: ${e}`));
  for (const id of ids) {
    const was = settingsBefore.find((r) => r.user_id === id);
    if (was) await db.query(`update mail_user_settings set hide_my_chat=$2, hide_my_calendar=$3 where user_id=$1`, [id, was.hide_my_chat, was.hide_my_calendar]).catch(() => {});
    else await db.query(`delete from mail_user_settings where user_id=$1`, [id]).catch(() => {});
  }
  await db.query(`delete from mail_mailboxes where address like '%@mock.test'`);
  await db.query(`delete from mail_identities where user_id = any($1) and microsoft_user_id like 'oid-%'`, [ids]);
  await db.query(`delete from teams_counts where user_id = any($1) and not (user_id = any($2))`, [ids, countsRowsBefore]);
  await cleanRate();
  const after = await counts();
  const drift = TABLES.filter((name) => after[name] !== before[name]);
  t('every mail_*, teams_* and link table back to its starting count', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${after[d]}`).join(', '));
  const recordsAfter = (await q(`select count(*)::int n from records where deal_name like 'ZZ teams probe%'`))[0].n;
  t('the probe record is gone', recordsAfter === 0, `records ${recordsBefore} at start`);
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
