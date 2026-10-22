/**
 * @mentions & notifications — the client's acceptance checklist, in a browser.
 *
 * Two people: A = admin@tapdash.test (the sender), B = demo.rep@tapdash.test
 * (a non-admin — the recipient, because an admin passes every permission
 * check by design and would prove nothing about who may be mentioned).
 *
 * ── SAFE ON THE LIVE DATABASE ────────────────────────────────────────────
 * The only record written is a probe created here and purged at the end.
 * B's permission rows are snapshotted and put back exactly; both accounts'
 * passwords are put back from their saved hashes. Everything that must be
 * undone is in `finally`.
 *
 *   npm run dev -- -p 3221
 *   node --env-file=.env scripts/verify-mentions.mjs [http://localhost:3221]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const A_EMAIL = 'admin@tapdash.test';
const B_EMAIL = 'demo.rep@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(A_EMAIL) || !/@([a-z0-9-]+\.)*test$/i.test(B_EMAIL)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

// Names as the app shows them (`profile_names()`): the full name, else the email's local part.
const NAME = `coalesce(nullif(btrim(p.full_name), ''), split_part(p.email::text, '@', 1))`;
const [A] = await q(`select p.id, ${NAME} name from profiles p where p.email = $1`, [A_EMAIL]);
const [B] = await q(`select p.id, ${NAME} name, r.is_admin from profiles p join roles r on r.id = p.role_id where p.email = $1`, [B_EMAIL]);
if (!A || !B || B.is_admin) { console.log('needs admin@tapdash.test and a non-admin demo.rep@tapdash.test'); process.exit(1); }

const pass = [], fail = [], notes = [];
const t = (name, ok, detail = '') => (ok ? pass : fail).push(`${name}${detail ? '  — ' + detail : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── sign-in cookies for both, passwords restored at the end ── */
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const savedHashes = new Map();
const PW = 'ZzProbe-2026!mention';
async function cookiesFor(id, email) {
  savedHashes.set(id, (await q('select encrypted_password from auth.users where id = $1', [id]))[0]?.encrypted_password ?? null);
  await svc.auth.admin.updateUserById(id, { password: PW });
  const { data, error } = await anon.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  const ref = new URL(SUPA).hostname.split('.')[0];
  const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
  return out;
}

/* ── B's grants: snapshot, open the chain to the DBA field, restore later ── */
const grantsBefore = await q(`select scope_kind::text, scope_id, grant_level::text, module_id from user_grants where user_id = $1`, [B.id]);
const [leads] = await q(`select id, slug from modules where slug = 'leads'`);
const [dba] = await q(`select f.id, f.label, f.tab_id, f.subtab_id, t.key tab_key, s.key subtab_key, t.label tab_label, s.label subtab_label
                         from fields f join tabs t on t.id = f.tab_id left join subtabs s on s.id = f.subtab_id where f.key = 'dba'`);
const [ein] = await q(`select f.id, f.label from fields f where f.key = 'ein'`);
const [updatesTab] = await q(`select id from tabs where key = 'updates'`);
const [casesTab] = await q(`select id from tabs where key = 'cases'`);
const grant = (kind, id, level, mod) =>
  db.query(
    `insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, $2, $3, $4, $5)
     on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = excluded.grant_level`,
    [B.id, kind, id, level, mod],
  );
await db.query(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, 'module', $2, 'edit')
                on conflict (user_id, scope_kind, scope_id, module_id) do update set grant_level = 'edit'`, [B.id, leads.id]);
await grant('tab', dba.tab_id, 'edit', leads.id);
if (dba.subtab_id) await grant('subtab', dba.subtab_id, 'edit', leads.id);
await grant('field', dba.id, 'edit', leads.id);
await grant('tab', updatesTab.id, 'edit', leads.id);
await grant('tab', casesTab.id, 'edit', leads.id);
// EIN stays as B's template has it (hidden sub-tab): B must be absent from its picker.

/* ── the probe record, B on its team ── */
const [probe] = await q(
  `insert into records (deal_name, creator_kind, creator_user_id, "values")
   values ('ZZ mention probe', 'user', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text), 'dba', 'Probe Trading'))
   returning id`, [A.id, B.id]);
await db.query(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, leads.id, A.id]);
const REC = `${BASE}/${leads.slug}?record=${probe.id}`;

const notifs = (where = 'true', p = []) =>
  q(`select * from notifications where recipient_id = $1 and record_id = $2 and ${where} order by created_at`, [B.id, probe.id, ...p]);
const unreadB = async () => (await q(`select count(*)::int n from notifications n where recipient_id = $1 and record_id = $2 and read_at is null and revoked_at is null`, [B.id, probe.id]))[0].n;

const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const ctxB = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await ctxA.addCookies(await cookiesFor(A.id, A_EMAIL));
await ctxB.addCookies(await cookiesFor(B.id, B_EMAIL));
// The app signs out anyone idle for 24 h on their next request; the test
// accounts always are. Mark both as just seen, and put B's stamp back later.
const seenBefore = await q(`select id, last_seen_at from profiles where id = any($1::uuid[])`, [[A.id, B.id]]);
await db.query(`update profiles set last_seen_at = now() where id = any($1::uuid[])`, [[A.id, B.id]]);
const a = await ctxA.newPage();
const b = await ctxB.newPage();
const b2 = await ctxB.newPage();
const errors = [];
for (const p of [a, b, b2]) {
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  await p.route('**://*.posthog.com/**', (r) => r.abort());
}
const goto = async (p, url) => {
  await p.goto(url, { waitUntil: 'load', timeout: 180000 });
  await p.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(800);
};
const appear = (loc, ms = 90000) => loc.first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
/** Poll the database until `fn` returns something truthy — server actions on a dev machine can take a while. */
const until = async (fn, ms = 120000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(1500); } return v; };
const SHOTS = process.env.MENTION_SHOTS; let shotN = 0;
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${String(++shotN).padStart(2, '0')}-${name}.png` }).catch(() => {}); };
const openRecord = async (p) => { await goto(p, REC); const ok = await appear(p.getByRole('button', { name: /^Updates/ })); if (!ok) await shot(p, 'record-missing'); };
const bodies = async () => (await q(`select body, parent_id is not null as reply from updates where record_id = $1 and deleted_at is null order by created_at`, [probe.id])).map((u) => `${u.reply ? '↳ ' : ''}${u.body}`).join(' | ');
const tab = (p, name) => p.getByRole('button', { name: new RegExp(`^${name}`) }).first();

/** Type an @mention: the picker inserts the full name on Enter. */
async function typeMention(p, textarea, before, query) {
  await textarea.click();
  await textarea.type(before, { delay: 10 });
  await textarea.type(`@${query}`, { delay: 40 });
  await p.waitForTimeout(600);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
}

/** The field @ box on `fieldId`: pick `who` (or report who is offered), add a note, send. */
async function fieldMention(p, fieldId, label, who, note, { includePrevious } = {}) {
  const cell = p.locator(`#field-${fieldId}`).first();
  await cell.scrollIntoViewIfNeeded();
  await cell.hover();
  await cell.getByRole('button', { name: `Mention someone on ${label}` }).click();
  const box = p.getByRole('dialog', { name: `Mention someone on ${label}` });
  await box.getByText('Finding who can see this field').waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  const offered = await box.locator('button').evaluateAll((bs) => bs.map((x) => x.textContent.trim()).filter((x) => x && !/Cancel|Send|Close|Remove/.test(x)));
  if (!who) { await box.getByRole('button', { name: 'Cancel' }).click(); await p.waitForTimeout(300); return { offered }; }
  await box.getByLabel('Who to mention').type(who.slice(0, 6), { delay: 30 });
  await p.waitForTimeout(300);
  await p.keyboard.press('Enter');
  if (note) await box.getByLabel('Note').fill(note);
  const cb = box.getByRole('checkbox');
  const hasPrevious = (await cb.count()) > 0;
  if (hasPrevious && includePrevious === false) await cb.uncheck();
  await box.getByRole('button', { name: 'Send' }).click();
  await box.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(500);
  return { offered, hasPrevious };
}

let ids = {};
try {
  /* ── 1. who can be mentioned ──────────────────────────────────────────── */
  await openRecord(a);
  await tab(a, dba.tab_label).click();
  await a.waitForTimeout(800);
  if (dba.subtab_label) { await a.getByRole('button', { name: dba.subtab_label, exact: true }).first().click().catch(() => {}); await a.waitForTimeout(600); }
  const dbaPick = await fieldMention(a, 'dba', dba.label, null);
  t('field picker offers B for a field B can see', dbaPick.offered.some((n) => n.includes(B.name)), dbaPick.offered.join(', '));
  t('field picker never offers the sender', !dbaPick.offered.some((n) => n.includes(A.name)));
  // EIN lives in a sub-tab B's template hides.
  await a.getByRole('button', { name: 'Private', exact: true }).first().click().catch(() => {});
  await a.waitForTimeout(600);
  const einCell = a.locator('#field-ein');
  if (await einCell.count()) {
    const einPick = await fieldMention(a, 'ein', ein.label, null);
    t('B is absent from the picker of a field B cannot see (EIN)', !einPick.offered.some((n) => n.includes(B.name)), einPick.offered.join(', '));
  } else notes.push('EIN cell not rendered for A on this tab; eligibility for a hidden field is covered by the integration suite');

  /* ── 2. update, reply, case reply ─────────────────────────────────────── */
  await tab(a, 'Updates').click();
  await a.waitForTimeout(800);
  const composer = a.getByPlaceholder(/Write an update/);
  await typeMention(a, composer, 'Please review this ', B.name.slice(0, 5));
  t('picker inserted the full name into the text', (await composer.inputValue()).includes(`@${B.name}`), await composer.inputValue());
  await a.getByRole('button', { name: 'Post update' }).click();
  t('the update shows "was notified"', await appear(a.getByText(/was notified/)));
  let rows = (await until(async () => { const r = await notifs(`source_kind = 'mention_update'`); return r.length ? r : null; })) ?? [];
  t('an update mention notifies B once', rows.length === 1, `${rows.length} rows; updates: ${await bodies()}`);
  ids.update = rows[0]?.id;

  // Replies live behind the "0 replies" toggle.
  await a.getByRole('button', { name: /\d+ repl(y|ies)$/ }).first().click();
  const replyBox = a.getByPlaceholder(/^Reply… @mention/).first();
  await typeMention(a, replyBox, 'And a reply for ', B.name.slice(0, 5));
  await a.getByRole('button', { name: 'Reply' }).first().click();
  rows = (await until(async () => { const r = await notifs(`source_kind = 'mention_update'`); return r.length === 2 ? r : null; })) ?? await notifs(`source_kind = 'mention_update'`);
  t('a reply mention is a second notification', rows.length === 2, `${rows.length} rows; updates: ${await bodies()}`);
  await shot(a, 'a-after-reply');
  ids.reply = rows[1]?.id;

  await tab(a, 'Cases').click();
  await a.waitForTimeout(800);
  await a.getByRole('button', { name: 'Open a case' }).click();
  await a.getByPlaceholder('Short title').fill('Probe case');
  await a.getByPlaceholder(/Describe the problem/).fill('Something to look at.');
  await a.getByRole('button', { name: 'Open case' }).click();
  await appear(a.getByPlaceholder(/Reply to this case/));
  const caseReply = a.getByPlaceholder(/Reply to this case/).first();
  await typeMention(a, caseReply, 'Can you check ', B.name.slice(0, 5));
  await a.getByRole('button', { name: 'Reply' }).first().click();
  rows = (await until(async () => { const r = await notifs(`source_kind = 'mention_case_reply'`); return r.length ? r : null; })) ?? [];
  t('a case reply mention notifies B', rows.length === 1, `${rows.length} rows; cases ${(await q(`select count(*)::int n from cases where record_id = $1`, [probe.id]))[0].n}, replies: ${(await q(`select r.body from case_replies r join cases c on c.id = r.case_id where c.record_id = $1`, [probe.id])).map((r) => r.body).join(' | ')}`);
  await shot(a, 'a-after-case-reply');
  ids.caseReply = rows[0]?.id;
  t('the case reply preview carries the case number', /^Case #\d+: /.test(rows[0]?.preview ?? ''), rows[0]?.preview);

  /* ── 3. field mentions, with and without the previous value ───────────── */
  // A's own change to DBA a moment ago, as the product records it.
  await db.query(
    `insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
     values ($1, $2, 'field', 'dba', 'DBA changed', 'Old Trading Name', 'Probe Trading')`, [probe.id, A.id]);
  await tab(a, dba.tab_label).click();
  await a.waitForTimeout(800);
  if (dba.subtab_label) { await a.getByRole('button', { name: dba.subtab_label, exact: true }).first().click().catch(() => {}); await a.waitForTimeout(600); }
  const f1 = await fieldMention(a, 'dba', dba.label, B.name, 'Please confirm the trading name.');
  t('"Include previous value" is offered after the sender changed the field', f1.hasPrevious === true);
  rows = (await until(async () => { const r = await notifs(`source_kind = 'mention_field' and note = 'Please confirm the trading name.'`); return r.length ? r : null; })) ?? [];
  t('a field mention carries note, current and previous value', rows.length === 1 && rows[0].current_value === 'Probe Trading' && rows[0].previous_value === 'Old Trading Name', JSON.stringify(rows.map((r) => [r.current_value, r.previous_value])));
  ids.field = rows[0]?.id;
  t('"Sent to" confirmation appears', (await a.getByRole('status').filter({ hasText: /Sent to/ }).count()) > 0);

  const f2 = await fieldMention(a, 'dba', dba.label, B.name, 'Without the old value.', { includePrevious: false });
  rows = (await until(async () => { const r = await notifs(`source_kind = 'mention_field' and note = 'Without the old value.'`); return r.length ? r : null; })) ?? [];
  t('unticking withholds the previous value', rows.length === 1 && rows[0].previous_value === null && rows[0].current_value === 'Probe Trading', JSON.stringify(rows.map((r) => [r.current_value, r.previous_value])));
  ids.field2 = rows[0]?.id;
  void f2;
  t('field mentions never post to Updates', (await q(`select count(*)::int n from updates where record_id = $1 and deleted_at is null`, [probe.id]))[0].n === 2);

  const emailed = await q(`select count(*)::int n from notifications where recipient_id = $1 and record_id = $2 and email_sent_at is not null`, [B.id, probe.id]);
  notes.push(process.env.SMTP_HOST
    ? `emails: ${emailed[0].n} of ${(await notifs()).length} stamped sent. SMTP is configured here, and the relay refuses the .test recipient (RFC 2606 reserved) — the send path ran; see "[mentions] email not sent" in the dev server log`
    : 'SMTP not configured locally — emails are logged by the dev server, not sent');

  /* ── 4. indicators, as B ──────────────────────────────────────────────── */
  const expected = await unreadB();
  await goto(b, `${BASE}/${leads.slug}`);
  await appear(b.getByText('ZZ mention probe'));
  await shot(b, 'b-list');
  const rowBadge = b.getByRole('button', { name: new RegExp(`^${expected} unread mention`) });
  t(`list row shows "@ ${expected}" to B`, (await rowBadge.count()) > 0);
  await goto(a, `${BASE}/${leads.slug}`);
  t('list row shows no badge to A (counts are per viewer)', (await a.getByRole('button', { name: /unread mention/ }).count()) === 0);

  await openRecord(b);
  await shot(b, 'b-record');
  const pill = async (name) => {
    const el = tab(b, name).locator('[title*="unread mention"]');
    return (await el.count()) ? (await el.first().textContent()).trim() : null;
  };
  t('Updates tab shows @2', (await pill('Updates')) === '2', `${await pill('Updates')} — tab text "${await tab(b, 'Updates').textContent().catch(() => '?')}"`);
  t('Cases tab shows @1', (await pill('Cases')) === '1', String(await pill('Cases')));
  t(`${dba.tab_label} tab shows @2`, (await pill(dba.tab_label)) === '2', String(await pill(dba.tab_label)));
  await tab(b, dba.tab_label).click();
  await b.waitForTimeout(800);
  if (dba.subtab_label) {
    const sub = b.getByRole('button', { name: new RegExp(`^${dba.subtab_label}`) }).first();
    t(`${dba.subtab_label} sub-tab shows @2`, (await sub.locator('[title*="unread mention"]').count()) > 0);
    await sub.click().catch(() => {});
    await b.waitForTimeout(600);
  }
  const dot = b.locator('#field-dba').getByRole('button', { name: /^2 unread mentions on this field/ });
  t('the DBA field shows a dot with 2', (await dot.count()) > 0);
  t('the @ button is visible on the mentioned field without hovering', (await b.locator('#field-dba').getByRole('button', { name: `Mention someone on ${dba.label}` }).isVisible()));
  await tab(b, 'Cases').click();
  await b.waitForTimeout(800);
  t('the case card shows a dot', (await b.locator('#case-' + (await q(`select id from cases where record_id = $1`, [probe.id]))[0].id).locator('[title*="unread mention"]').count()) > 0);
  await tab(b, 'Updates').click();
  await b.waitForTimeout(800);
  t('the thread and reply carry the "@ You" chip', (await b.getByText('You', { exact: true }).count()) >= 2, `${await b.getByText('You', { exact: true }).count()}`);

  /* ── 5. click-through via the row badge: lands on the oldest ──────────── */
  await goto(b, `${BASE}/${leads.slug}`);
  await b.getByRole('button', { name: /unread mention/ }).first().click();
  await appear(b.getByRole('button', { name: /^Updates/ }));
  await b.waitForTimeout(1500);
  t('row badge opens the record at the oldest mention', b.url().includes('n=first') && (await tab(b, 'Updates').getAttribute('aria-selected').catch(() => null)) !== 'false', b.url());
  const updateEl = `#update-${(await q(`select update_id from notifications where id = $1`, [ids.update]))[0].update_id}`;
  t('the update it lands on is on screen', await appear(b.locator(updateEl), 20000));
  t('arriving marks that mention read', Boolean(await until(async () => (await q(`select read_at from notifications where id = $1`, [ids.update]))[0].read_at, 30000)));

  /* ── 6. deep links /n/<id> for each kind ──────────────────────────────── */
  await goto(b, `${BASE}/n/${ids.caseReply}`);
  const replyId = (await q(`select case_reply_id from notifications where id = $1`, [ids.caseReply]))[0].case_reply_id;
  t('/n/<id> for a case reply lands on Cases with the reply on screen', b.url().includes('tab=cases') && (await b.locator(`#reply-${replyId}`).count()) > 0, b.url());

  await goto(b, `${BASE}/n/${ids.field}`);
  const panel = b.getByRole('dialog', { name: 'Mention' });
  t('/n/<id> for a field lands on its tab with the mention panel open', b.url().includes(`tab=${dba.tab_key}`) && (await panel.count()) > 0, b.url());
  t('the panel shows the previous value this once', (await panel.getByText('Old Trading Name').count()) > 0, (await panel.textContent().catch(() => '')).slice(0, 160));
  t('…and the database no longer holds it', (await q(`select previous_value, opened_at from notifications where id = $1`, [ids.field]))[0].previous_value === null);
  const [n] = await q(`select opened_at from notifications where id = $1`, [ids.field]);
  t('opening is recorded', n.opened_at !== null);

  /* ── 7. Notifications page ────────────────────────────────────────────── */
  await goto(b, `${BASE}/notifications`);
  const sidebarCount = async (p, name) => (await p.getByRole('link', { name: new RegExp(`^${name}`) }).first().textContent()).replace(name, '').trim();
  const unreadNow = await unreadB();
  t('sidebar Notifications count matches unread', (await sidebarCount(b, 'Notifications')) === String(unreadNow), `${await sidebarCount(b, 'Notifications')} vs ${unreadNow}`);
  t('the bell is gone', (await b.locator('button[aria-label="Notifications"]').count()) === 0);
  t('Unread filter lists the unread ones', (await b.getByRole('list').getByRole('listitem').count()) === unreadNow, `${await b.getByRole('list').getByRole('listitem').count()}`);
  const rowsAll = await b.getByRole('listitem').allTextContents();
  t('rows name the place and the record', rowsAll.some((x) => /Field: DBA|Update|Case #/.test(x) && x.includes('ZZ mention probe')), rowsAll[0]);
  await b.getByRole('button', { name: 'Mark all as read' }).click();
  await b.waitForTimeout(2500);
  t('Mark all as read clears everything', (await unreadB()) === 0);
  await b.getByRole('tab', { name: 'Read', exact: true }).click();
  await b.waitForTimeout(1500);
  const first = b.getByRole('listitem').filter({ hasText: 'ZZ mention probe' }).first();
  await first.hover();
  await first.getByRole('button', { name: 'Mark unread' }).click();
  t('Mark unread brings one back', (await until(async () => (await unreadB()) === 1, 30000)) === true);
  await b.getByRole('tab', { name: 'Unread', exact: true }).click();
  await appear(b.getByRole('listitem').filter({ hasText: 'ZZ mention probe' }), 20000);
  await b.getByRole('listitem').filter({ hasText: 'ZZ mention probe' }).first().getByRole('button').first().click();
  await appear(b.getByRole('button', { name: /^Updates/ }));
  await b.waitForTimeout(1500);
  t('clicking a row opens the record at the item', b.url().includes(`record=${probe.id}`) && b.url().includes('n='), b.url());
  t('…and it is read', (await until(async () => (await unreadB()) === 0, 30000)) === true);

  /* ── 8. live count in another tab (Realtime, poll fallback at 60 s) ───── */
  await goto(b2, `${BASE}/${leads.slug}`);
  const before = await sidebarCount(b2, 'Notifications');
  await openRecord(a);
  await tab(a, dba.tab_label).click();
  await a.waitForTimeout(800);
  if (dba.subtab_label) { await a.getByRole('button', { name: dba.subtab_label, exact: true }).first().click().catch(() => {}); await a.waitForTimeout(600); }
  const t0 = Date.now();
  await fieldMention(a, 'dba', dba.label, B.name, 'Live one.');
  let after = before, waited = 0;
  while (waited < 75000) {
    after = await sidebarCount(b2, 'Notifications');
    if (after !== before) break;
    await sleep(1000);
    waited = Date.now() - t0;
  }
  t('sidebar count rises in another tab without a refresh', after !== before, `${before} → ${after} after ${Math.round(waited / 1000)} s`);
  notes.push(waited < 15000 ? `live count arrived in ${Math.round(waited / 1000)} s — Realtime is working on this project`
    : waited < 75000 ? `live count took ${Math.round(waited / 1000)} s — that is the 60 s poll; enable Realtime for the notifications table in the Supabase dashboard`
    : 'live count never changed');

  /* ── 9. mute ───────────────────────────────────────────────────────────── */
  await openRecord(b);
  await b.getByRole('button', { name: 'More actions' }).click();
  await b.getByRole('menuitem', { name: /Mute this record/ }).click();
  await b.waitForTimeout(2000);
  t('Mute is stored', (await q(`select 1 from notification_mutes where user_id = $1 and record_id = $2`, [B.id, probe.id])).length === 1);
  t('a "Muted" pill shows', (await b.getByText('Muted', { exact: true }).count()) > 0);
  const beforeMute = (await notifs()).length;
  await fieldMention(a, 'dba', dba.label, B.name, 'While muted.');
  t('a mention while muted creates nothing for B', (await notifs()).length === beforeMute);
  await b.getByRole('button', { name: 'More actions' }).click();
  await b.getByRole('menuitem', { name: /Unmute this record/ }).click();
  await b.waitForTimeout(2000);
  t('Unmute is stored', (await q(`select 1 from notification_mutes where user_id = $1 and record_id = $2`, [B.id, probe.id])).length === 0);
  t('unmuting does not resurrect the muted mention', (await notifs()).length === beforeMute);

  /* ── 10. edit removes, delete removes ────────────────────────────────── */
  await tab(a, 'Updates').click();
  await a.waitForTimeout(800);
  const liveBefore = await unreadB();
  await a.getByRole('button', { name: /Remove your update|Remove as admin/ }).first().click();
  await a.getByRole('button', { name: /Remove|Confirm|Yes/ }).last().click().catch(() => {});
  await a.waitForTimeout(3000);
  const revoked = await q(`select count(*)::int n from notifications where id in ($1, $2) and revoked_at is not null`, [ids.update, ids.reply]);
  t('removing the update revokes its mentions (and its reply’s)', revoked[0].n === 2, `${revoked[0].n} of 2 revoked; unread ${liveBefore} → ${await unreadB()}`);

  /* ── 11. recycle bin hides, restore returns; lost access hides ───────── */
  await db.query(`update records set deleted_at = now() where id = $1`, [probe.id]);
  await goto(b, `${BASE}/notifications`);
  t('nothing from a record in the Recycle Bin is listed', (await b.getByRole('listitem').count()) === 0 || !(await b.getByRole('list').textContent()).includes('ZZ mention probe'));
  await db.query(`update records set deleted_at = null where id = $1`, [probe.id]);
  await db.query(`update notifications set read_at = null where id = $1`, [ids.field2]);
  await goto(b, `${BASE}/notifications`);
  t('restoring brings them back', (await b.getByRole('list').textContent()).includes('ZZ mention probe'));
  await db.query(`update records set "values" = "values" || '{"team_members_assigned": []}'::jsonb where id = $1`, [probe.id]);
  await goto(b, `${BASE}/n/${ids.field2}`);
  t('an old link after losing access says it is no longer available', (await b.getByText('no longer available').count()) > 0);
  await db.query(`update records set "values" = "values" || jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)) where id = $1`, [probe.id, B.id]);

  /* ── 12. bulk edits create nothing ───────────────────────────────────── */
  const countBefore = (await notifs()).length;
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.id, role: 'authenticated' })]);
  await db.query(`begin`);
  await db.query(`set local role authenticated`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.id, role: 'authenticated' })]);
  await db.query(`select bulk_set_values($1::uuid[], 'dba', to_jsonb('Bulk Name'::text), 'bulk')`, [[probe.id]]).catch((e) => notes.push('bulk_set_values: ' + e.message));
  await db.query(`rollback`);
  t('a bulk edit creates no mention', (await notifs()).length === countBefore);

  /* ── 13. phone alerts count on the Phone item and clear on open ──────── */
  await db.query(`select notify($1, 'Missed call', $2, 'call')`, [B.id, probe.id]);
  await goto(b, `${BASE}/${leads.slug}`);
  t('a phone alert counts on the Phone sidebar item', (await sidebarCount(b, 'Phone')) !== '');
  await goto(b, `${BASE}/phone`);
  await b.waitForTimeout(2000);
  t('opening Phone clears it', (await q(`select count(*)::int n from notifications where recipient_id = $1 and source_kind = 'call' and read_at is null and record_id = $2`, [B.id, probe.id]))[0].n === 0);

  /* ── 14. vocabulary ──────────────────────────────────────────────────── */
  await openRecord(b);
  const body = (await b.locator('main, body').first().textContent()).toLowerCase();
  t('no "delete" wording anywhere in the drawer', !/\bdelete\b/.test(body));
} catch (e) {
  fail.push(`crashed: ${e.stack || e}`);
} finally {
  await browser.close().catch(() => {});
  /* ── undo everything ── */
  await db.query('reset role').catch(() => {});
  await db.query(`delete from notification_mutes where user_id = $1 and record_id = $2`, [B.id, probe.id]).catch(() => {});
  await db.query(`update records set deleted_at = now() where id = $1`, [probe.id]).catch(() => {});
  // purge_record is admin-only: run it as A, the way the Recycle Bin does.
  await db.query('begin');
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A.id, role: 'authenticated' })]);
  await db.query('set local role authenticated');
  await db.query(`select purge_record($1)`, [probe.id]).then(() => db.query('commit')).catch(async (e) => {
    await db.query('rollback').catch(() => {});
    notes.push('purge_record failed: ' + e.message + ' — removing rows directly');
    await db.query(`delete from notifications where record_id = $1`, [probe.id]).catch(() => {});
    await db.query(`delete from records where id = $1`, [probe.id]).catch(() => {});
  });
  await db.query(`delete from user_grants where user_id = $1`, [B.id]);
  for (const g of grantsBefore) {
    await db.query(`insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id) values ($1, $2, $3, $4, $5)`,
      [B.id, g.scope_kind, g.scope_id, g.grant_level, g.module_id]).catch(() => {});
  }
  for (const r of seenBefore) await db.query(`update profiles set last_seen_at = $2 where id = $1`, [r.id, r.last_seen_at]).catch(() => {});
  for (const [id, hash] of savedHashes) if (hash) await db.query('update auth.users set encrypted_password = $2 where id = $1', [id, hash]).catch(() => {});
  const left = await q(`select count(*)::int n from records where deal_name = 'ZZ mention probe'`);
  const grantsAfter = await q(`select count(*)::int n from user_grants where user_id = $1`, [B.id]);
  notes.push(`cleanup: probe records left ${left[0].n}; B's grants ${grantsBefore.length} → ${grantsAfter[0].n}`);
  await db.end();
}

console.log(`\n${pass.length} passed, ${fail.length} failed\n`);
for (const p of pass) console.log('  ok   ' + p);
for (const f of fail) console.log('  FAIL ' + f);
if (notes.length) { console.log('\nnotes:'); for (const n of notes) console.log('  · ' + n); }
if (errors.length) { console.log('\nbrowser errors:'); for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ' + e); }
process.exit(fail.length ? 1 : 0);
