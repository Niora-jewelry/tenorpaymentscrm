/**
 * Every bug the client reported, re-checked in a real browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each of these was reported by Izzy after the CRM was handed to him, and
 * every one of them had passed a round of verification that never submitted a
 * form. This drives the actual UI as his own account and asserts on the
 * database afterwards, so "fixed" means the thing he did now works, not that
 * the page renders.
 *
 * It writes to the database and restores what it touched at the end.
 *
 *   npm run dev -- -p 3220
 *   node --env-file=.env scripts/verify-client-reports.mjs [http://localhost:3220]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD = 'ZzProbe-2026!page';
const BASE = process.argv[2] || 'http://localhost:3220';

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? ' PASS' : '*FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ── sign in as the client ───────────────────────────────────────────── */
/**
 * ⚠️ THIS SCRIPT SIGNS IN, SO IT MUST NEVER POINT AT A REAL PERSON.
 *
 * It used to use `izzy@tapdash.co` — the client's own account — and it did
 * not merely sign in as him: it called `auth.admin.updateUserById` to SET HIS
 * PASSWORD on every run, so each run locked him out of the account he had
 * been given. It also wrote every action into the activity log under his
 * name, which made his own audit trail untrue and, when a membership change
 * had to be explained, impossible to attribute.
 *
 * It uses a seeded test account now, and refuses to start against anything
 * that is not obviously one. The check is deliberately crude and in the way:
 * an address ending `.test` cannot be delivered to (RFC 2606 reserves it), so
 * it cannot belong to a person.
 */
const PROBE_EMAIL = 'admin@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(PROBE_EMAIL)) {
  console.log(`Refusing to run: ${PROBE_EMAIL} is not a .test account, and this script resets the password of whoever it signs in as.`);
  process.exit(1);
}

const [u] = await q(`select id,email from profiles where email=$1`, [PROBE_EMAIL]);
/* Safe only because of the `.test` guard above. */
await svc.auth.admin.updateUserById(u.id, { password: PASSWORD });
await db.query(`update profiles set last_seen_at=now() where id=$1`, [u.id]);
const anon = createClient(SUPA, ANON, { auth: { persistSession: false } });
const { data, error: signInErr } = await anon.auth.signInWithPassword({ email: u.email, password: PASSWORD });
if (signInErr) { console.log('SIGN IN FAILED:', signInErr.message); process.exit(1); }
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) {
  for (let i = 0, n = 0; i < v.length; i += 3180, n++) {
    cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  }
} else {
  cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
}

const [rec] = await q(`select id, deal_name from records where deal_name ilike '%Netzach%'`);

/* Everything this script touches must be put back, and a side effect it did
   not intend must FAIL the run rather than pass unnoticed — see the note on
   `tab` below for why that is not hypothetical. */
const membershipsBefore = (await q(
  `select m.slug || ':' || r.deal_name as pair
     from record_modules rm
     join records r on r.id = rm.record_id
     join modules m on m.id = rm.module_id
    order by 1`)).map((x) => x.pair).join('|');
const originalName = rec.deal_name;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();

const serverErrors = [];
page.on('pageerror', (e) => serverErrors.push('pageerror: ' + String(e).slice(0, 90)));
page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`HTTP ${r.status()} ${r.url().split('?')[0].slice(-45)}`); });

const banner = async () =>
  (await page.locator('text=/Someone else changed|Could not reach the server|Could not save/i').allTextContents()).join(' | ');

const openDrawer = async () => {
  await page.goto(`${BASE}/contacts?record=${rec.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(800);
};

/*
 * ⚠️ SCOPED TO THE TAB STRIP, AND MATCHED EXACTLY.
 *
 * This was `page.locator('button', { hasText: /^Contact/ })` across the whole
 * page. The drawer's "IN MODULES" row is also a row of buttons, and its
 * Contacts chip starts with "Contact" — so asking for the Contact TAB clicked
 * the module chip instead and toggled the record's membership of Contacts.
 * Two records were silently added to a module nobody asked to put them in,
 * and the only reason it surfaced is that the server log recorded
 * `toggleMembershipAction`.
 *
 * A verification script that mutates what it is verifying is worse than no
 * script. The tabs live inside the drawer's `<nav>`; the module chips do not.
 */
const tab = async (name) => {
  /*
   * Pick the nav that actually holds this tab, rather than guessing at its
   * position. `.last()` was wrong as soon as a tab with SUBTABS was opened:
   * the subtab strip is a nav too, and it became the last one, so every
   * later lookup searched the wrong row and silently found nothing.
   *
   * A tab strip has several buttons; a subtab strip for the tab we just
   * opened may have one or two. Requiring four rules the small ones out
   * without naming any tab.
   */
  /* A PREFIX match. `` cannot work here: the strip renders the count straight
     after the label ("Overview6 of 14", "Cases0"), so the next character is a
     word character and the boundary never matches. Scoping to the tab nav is
     what makes a loose prefix safe — the module chips are not in it. */
  const re = new RegExp('^\s*' + name);
  /* The drawer streams in behind a Suspense boundary, so the strip is not
     on the page the moment `networkidle` fires. A test that fails for being
     early reads as a regression, which is worse than no test. */
  const deadline = Date.now() + 30000;
  for (;;) {
  const navs = page.locator('nav');
  for (let i = 0; i < (await navs.count()); i += 1) {
    const nav = navs.nth(i);
    if ((await nav.locator('button').count()) < 4) continue;
    const t = nav.locator('button').filter({ hasText: re }).first();
    if (await t.count()) {
      await t.click();
      await page.waitForTimeout(3500);
      return true;
    }
  }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(500);
  }
  return false;
};

const header = async () => (await page.locator('dl').first().innerText()).replace(/\n+/g, ' | ');

console.log(`\n=== Re-checking every client report, as ${u.email} ===\n`);
await openDrawer();

/*
 * ⚠️ THE HEADER IS EXERCISED FIRST, ON THE TAB THE DRAWER OPENS ON.
 *
 * These checks used to run after the Contact tab had been opened, and the
 * click on the MID control then timed out — the tab below had changed the
 * layout under it. Ordering them first is both more reliable and closer to
 * what somebody actually does: the header strip is the first thing in the
 * drawer, and it is edited before anyone goes looking through the tabs.
 */
/* ── 2 + 3. MID saves, and a second header edit does not conflict ────── */
const headerCell = (label) =>
  page.locator('dl').first().locator('div').filter({ has: page.getByText(label, { exact: true }) }).first();

const typeHeader = async (label, value) => {
  const ctl = headerCell(label).locator('input, button').first();
  if (!(await ctl.count())) return false;
  await ctl.click();
  await page.waitForTimeout(400);
  const f = page.locator('input:focus');
  if (!(await f.count())) return false;
  await f.fill(value);
  await f.press('Enter');
  await page.waitForTimeout(3000);
  return true;
};

const didMid = await typeHeader('MID', '99000111');
const bannerAfterMid = await banner();
check('2. MID saves from the header', didMid && !bannerAfterMid, bannerAfterMid || 'no error banner');

const didMcc = await typeHeader('MCC code', '2953');
const bannerAfterMcc = await banner();
check('3. a SECOND header edit does not false-conflict', didMcc && !bannerAfterMcc, bannerAfterMcc || 'no conflict banner');

const [saved] = await q(`select values->>'mid' mid, values->>'mcc_code' mcc from records where id=$1`, [rec.id]);
check('3b. both reached the database', saved.mid === '99000111' && saved.mcc === '2953', JSON.stringify(saved));


/* A fresh drawer for the tab-based checks below, so nothing above has
   left the page scrolled or a control mid-edit. */
await openDrawer();

/* ── 1. "Contacts 91" and the vanished contact ───────────────────────── */
await tab('Contact');
const contactTxt = await page.locator('body').innerText();
const countMatch = contactTxt.match(/CONTACTS\s+(\d+)/i);
const shown = countMatch ? Number(countMatch[1]) : null;
const [dbContacts] = await q(
  `select jsonb_typeof(values->'contact') t,
          coalesce(jsonb_array_length(values->'contact'),0) n
     from records where id=$1`, [rec.id]);
check('1. Contacts count is sane (not 91)', shown !== null && shown < 10, `tab shows ${shown}, db array length ${dbContacts.n}`);
check('1b. contact stored as an array, not text', dbContacts.t === 'array', `jsonb_typeof = ${dbContacts.t}`);
/*
 * ⚠ ASKS THE DATABASE WHO THE CONTACT IS, RATHER THAN NAMING HIM.
 *
 * This read `/Yitzchok Cohen/` — the name Izzy had typed when he reported
 * that a contact he entered did not appear. It passed for weeks and then
 * failed, not because anything regressed but because the record was edited
 * on the live site and the contact is now someone else. A check that fails
 * when real people do their jobs teaches everyone to ignore it, and it cost
 * an investigation to find that nothing was wrong.
 *
 * What the report was actually about is unchanged: whatever the database
 * holds as the first contact has to be on the screen.
 */
const [dbFirstContact] = await q(
  `select values->'contact'->0->>'name' as name from records where id=$1`, [rec.id]);
check(
  '1c. the contact in the database is the one on the screen',
  Boolean(dbFirstContact?.name) && contactTxt.includes(dbFirstContact.name),
  dbFirstContact?.name ?? 'no contact stored on the record',
);

let contactsToTrimTo = null;
let pricingToRestore = null;
/* ── 1d. ADDING a contact must not re-corrupt it ─────────────────────── */
/* The original damage happened on WRITE, so checking the repaired data is
   not enough — the path that broke it has to be driven again. */
{
  const before = dbContacts.n;
  const addBtn = page.locator('button', { hasText: /Add contact/i }).first();
  if (await addBtn.count()) {
    await addBtn.click();
    await page.waitForTimeout(3500);
    const [after] = await q(
      `select jsonb_typeof(values->'contact') t,
              coalesce(jsonb_array_length(values->'contact'),0) n
         from records where id=$1`, [rec.id]);
    check('1d. adding a contact keeps it an array',
      after.t === 'array' && after.n === before + 1,
      `type ${after.t}, length ${before} -> ${after.n}`);
    /*
     * ⚠️ TRIMMED AT THE END, NOT HERE.
     *
     * Writing to `records` behind the open page bumps `updated_at`, which is
     * the compare-and-swap token the browser is still holding. The very next
     * header edit then loses a conflict this script caused itself — which is
     * exactly what happened: MID and MCC reported no error and never reached
     * the database. A verification run must not race the thing it is
     * verifying.
     */
    contactsToTrimTo = before;
  } else {
    check('1d. adding a contact keeps it an array', false, 'no "Add contact" control found');
  }
}

/* ── 4. Record creator ───────────────────────────────────────────────── */
/* A fresh drawer again: adding a contact above triggered a revalidation,
   which re-renders the page and can drop the open tab back to the default. */
await openDrawer();
const onOverview = await tab('Overview');
check('4a. the Overview tab opened', onOverview, onOverview ? '' : 'tab not found in the strip');
const ovTxt = await page.locator('body').innerText();
const creatorBlock = (ovTxt.match(/RECORD CREATOR[\s\S]{0,80}/i) || [''])[0];
check('4. Record creator names the creator', /Izzy/i.test(creatorBlock), creatorBlock.replace(/\n+/g, ' / ').slice(0, 60));

/* ── 5. Pricing model reaches the header strip ───────────────────────── */
const h = await header();
const pm = (h.match(/Pricing Model \| ([^|]*)/) || [, '(absent)'])[1].trim();
const [dbPm] = await q(`select values->>'pricing_model' pm from records where id=$1`, [rec.id]);
check('5. Pricing Model shows in the header', pm.length > 0 && pm !== '—', `header "${pm}", db "${dbPm.pm}"`);

/* ── 5b. ...AND IT FOLLOWS AN EDIT MADE IN THE GRID, WITH NO RELOAD ───── */
/*
 * This is what the client actually reported. Check 5 only proves the header
 * DISPLAYS the stored value — it would pass with the two surfaces completely
 * disconnected, which is exactly what they were: the header keyed the shared
 * store by the field's UUID while the grid keyed it by the field's KEY, so
 * neither ever saw the other. The unit test passed throughout, because it
 * used one key consistently.
 *
 * Both controls are click-to-edit: the cell holds a button showing the value,
 * and a <select> appears once it is clicked.
 */
{
  const [pmBefore] = await q(`select values->>'pricing_model' pm from records where id=$1`, [rec.id]);
  const label = (k) => (k === 'dp' ? 'DP' : k === 'ic' ? 'IC+' : k === 'fr' ? 'FR' : '');

  const tagged = await page.evaluate((cur) => {
    const all = Array.prototype.slice.call(document.querySelectorAll('*'));
    const labs = all.filter((e) => e.children.length === 0 && /^\s*Pricing Model\s*$/i.test(e.textContent || ''));
    if (labs.length < 2) return false;                 // [0] header strip, [last] grid card
    let n = labs[labs.length - 1];
    for (let k = 0; k < 7 && n.parentElement; k += 1) {
      n = n.parentElement;
      const btns = Array.prototype.slice.call(n.querySelectorAll('button'));
      const val = btns.find((b) => (b.textContent || '').trim() === cur);
      if (val) { val.setAttribute('data-probe', 'grid-pm'); return true; }
    }
    return false;
  }, label(pmBefore.pm));

  if (!tagged) {
    check('5b. a grid edit reaches the header strip', false, 'could not find the grid Pricing Model control');
  } else {
    await page.locator('[data-probe="grid-pm"]').click();
    await page.waitForTimeout(1200);
    const sel = page.locator('select').filter({ has: page.locator('option', { hasText: 'IC+' }) }).first();
    const opts = (await sel.locator('option').allInnerTexts()).map((x) => x.trim()).filter(Boolean);
    const target = opts.find((o) => o !== '—' && o !== label(pmBefore.pm));
    await sel.selectOption({ label: target });
    await page.waitForTimeout(4500);

    const h = (await page.locator('dl').first().innerText()).replace(/\n+/g, ' | ');
    const headerNow = (h.match(/Pricing Model \| ([^|]*)/) || [, '(absent)'])[1].trim();
    const [pmAfter] = await q(`select values->>'pricing_model' pm from records where id=$1`, [rec.id]);

    check('5b. a grid edit reaches the header strip', headerNow === target,
      `grid set ${target}, header shows ${headerNow}, db ${pmAfter.pm}`);

    /* Put it back through the UI so the record keeps a consistent token. */
    pricingToRestore = pmBefore.pm;
  }
}

/* ── 6. Deal name: drawer, dashboard and database agree ──────────────── */
const [nameRow] = await q(
  `select deal_name, values ? 'deal_name' shadow from records where id=$1`, [rec.id]);
check('6. no shadow copy of Deal Name', nameRow.shadow === false, `column "${nameRow.deal_name}"`);
const [drift] = await q(
  `select count(*)::int n from records
    where deleted_at is null and (values->>'deal_name') is distinct from deal_name
      and values ? 'deal_name'`);
check('6b. no record disagrees with itself', drift.n === 0, `${drift.n} diverged`);
const titleShown = await page.locator('h1, h2').filter({ hasText: originalName }).count();
check('6c. drawer title is the column value', titleShown > 0, originalName);

/* ── 7. Cases handling note — present, saves, persists ───────────────── */
await openDrawer();
const onCases = await tab('Cases');
check('7a. the Cases tab opened', onCases, onCases ? '' : 'tab not found in the strip');
let caseTxt = await page.locator('body').innerText();
const noteControl = /How to deal with this merchant|how this merchant.s tickets should be handled/i.test(caseTxt);
check('7. Cases handling-note control exists', noteControl, 'top of the Cases tab');

if (noteControl) {
  const add = page.locator('button', { hasText: /Add how this merchant|Edit$/ }).first();
  if (await add.count()) {
    await add.click();
    await page.waitForTimeout(600);
    const ta = page.locator('textarea').first();
    if (await ta.count()) {
      await ta.fill('Call Yitzchok on the mobile before replying.');
      const save = page.locator('button', { hasText: /^Save/ }).first();
      await save.click();
      await page.waitForTimeout(3500);
      const [note] = await q(`select body from case_handling_notes where record_id=$1`, [rec.id]);
      check('7b. the note saves', Boolean(note), note ? note.body.slice(0, 45) : 'nothing in the database');
      caseTxt = await page.locator('body').innerText();
      check('7c. and shows on the tab', /Call Yitzchok on the mobile/i.test(caseTxt), '');
    } else {
      check('7b. the note saves', false, 'no textarea appeared');
    }
  } else {
    check('7b. the note saves', false, 'no add/edit control found');
  }
}

/* ── earlier reports, still fixed? ───────────────────────────────────── */
await page.goto(`${BASE}/leads`, { waitUntil: 'networkidle', timeout: 120000 });
/* `networkidle` is not "painted" — the table arrives with the RSC payload a
   moment later, and reading immediately saw a page with no column headers. */
await page.waitForTimeout(2500);
const leadsTxt = await page.locator('body').innerText();
check('8. pipeline column on the dashboard', /Lead Pipeline Status/i.test(leadsTxt), '');
check('9. "Other files" subtab is gone', !/Other files/i.test(leadsTxt), '');

await page.goto(`${BASE}/deals`, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForTimeout(1200);
const dealsHtml = await page.content();
check('10. pipeline step is clickable in the table', dealsHtml.includes('Change the pipeline step'), '');
check('11. Current Status is a dropdown too', dealsHtml.includes('Change Current Status'), '');

/* ── 14. A SAVED FILTER ON A FIELD VALUE STILL LOADS THE PAGE ─────────── */
/*
 * This is the bug that took the Leads page down entirely ("This page didn't
 * load", reference ...@E394), and nothing here covered it: the filter lives
 * in `user_filters` PER USER, and the account this script signs in as has
 * none, so the filtering path was never executed.
 *
 * `records.values` is not selectable by a signed-in user, and PostgreSQL
 * requires SELECT privilege on every column named in a WHERE clause — so a
 * filter on any field value was refused outright until the `records_filterable`
 * view. A page that renders with no filter proves nothing about that.
 *
 * The filter is written for the probe account, exercised, and removed.
 */
{
  const [leadsMod] = await q(`select id from modules where slug='leads'`);
  const [pipeField] = await q(
    `select f.key from pipelines p
       join fields f on f.id = p.status_field_id
      where p.module_id = $1 limit 1`, [leadsMod.id]);

  if (!pipeField) {
    check('14. a saved filter still loads the page', false, 'no pipeline status field on leads');
  } else {
    const filter = JSON.stringify([{ kind: 'present', fieldId: pipeField.key }]);
    await db.query(
      `insert into user_filters (user_id, module_id, filters, updated_at)
       values ($1,$2,$3::jsonb, now())
       on conflict (user_id, module_id) do update set filters = excluded.filters`,
      [u.id, leadsMod.id, filter]);

    const before500 = serverErrors.length;
    await page.goto(`${BASE}/leads`, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();
    const crashed = /didn.t load|Something went wrong/i.test(body);
    check('14. a saved filter on a field value still loads the page',
      !crashed && serverErrors.length === before500,
      crashed ? 'error boundary rendered' : 'no crash, no 500');

    /* And it must actually FILTER, not be silently dropped — the older bug in
       the same code path, where the query came back unfiltered and the table
       narrowed only the page it had already been given. */
    const shownNow = (body.match(/Page 1 of \d+\s*·?\s*/i) ? null : null);
    const [onPipeline] = await q(
      `select count(*)::int n from records r
         join record_modules rm on rm.record_id = r.id
        where rm.module_id = $1 and r.deleted_at is null
          and r.values ? $2`, [leadsMod.id, pipeField.key]);
    const [allLeads] = await q(
      `select count(*)::int n from records r
         join record_modules rm on rm.record_id = r.id
        where rm.module_id = $1 and r.deleted_at is null`, [leadsMod.id]);
    check('14b. the filter is applied by the database',
      onPipeline.n < allLeads.n,
      `${onPipeline.n} of ${allLeads.n} leads are on a pipeline — a filter that matched everything would prove nothing`);

    await db.query(`delete from user_filters where user_id=$1 and module_id=$2`, [u.id, leadsMod.id]);
    void shownNow;
  }
}

/* ── 15. AN EXPIRED INVITE CAN BE CANCELLED ───────────────────────────── */
/*
 * `revokeInvite` matched `status = 'pending'` only, so a lapsed invite could
 * be renewed and never cancelled. Checked on the real screen, because the
 * button's visibility was the other half of that fix.
 *
 * ⚠️ IT SEEDS ITS OWN EXPIRED INVITE.
 *
 * The first version of this check looked for an existing one and reported
 * "no expired invite to check" as a PASS. There happened to be none — eleven
 * had been cleared on the live site, using this very feature — so the check
 * was green while proving nothing. A test that passes when it could not run
 * is worse than one that fails, because it is counted.
 *
 * Seeding makes it deterministic and leaves nothing behind: the row is
 * created `expired`, looked at, and deleted, and the address is a `.test`
 * one that cannot belong to a person.
 */
{
  const probeEmail = `zz-expired-probe-${Date.now()}@tapdash.test`;
  const [role] = await q(`select id from roles order by is_admin, name limit 1`);
  await db.query(
    `insert into invites (email, invited_by, role_id, status, expires_at)
     values ($1, $2, $3, 'expired', now() - interval '7 days')`,
    [probeEmail, u.id, role.id]);

  try {
    await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle', timeout: 120000 });
    await page.waitForTimeout(3000);

    const row = page.locator('tr').filter({ hasText: probeEmail }).first();
    const onScreen = (await row.count()) > 0;
    check('15a. an expired invite is listed as actionable', onScreen,
      onScreen ? probeEmail : 'the seeded invite did not appear on the Users screen');

    if (onScreen) {
      const rowText = await row.innerText();
      const hasCancel = (await row.locator('button').filter({ hasText: /^\s*Cancel/ }).count()) > 0;
      const hasRenew = (await row.locator('button').filter({ hasText: /^\s*Renew/ }).count()) > 0;
      check('15. an expired invite offers Cancel, not only Renew', hasCancel,
        `Cancel=${hasCancel} Renew=${hasRenew} — row reads "${rowText.replace(/\n+/g, ' ').slice(0, 60)}"`);
    } else {
      check('15. an expired invite offers Cancel, not only Renew', false, 'row not found');
    }
  } finally {
    await db.query(`delete from invites where email = $1`, [probeEmail]);
  }
}

/* ── 16. AN ADMIN ROW MUST NOT CLAIM A TEMPLATE APPLIES ───────────────── */
/*
 * A Super Admin bypasses every module, tab, subtab and field permission, so a
 * template or personal override attached to them is not in force. The Users
 * table rendered "Template: P2 (edited)" on exactly such a row, which is the
 * same confusion the client already reported from the other side — he set a
 * field to View while inviting and saw Edit in the result.
 *
 * Still on the Users screen from check 15.
 */
{
  const admins = await q(
    `select p.email,
            (select count(*)::int from user_grants g where g.user_id = p.id) overrides,
            (select count(*)::int from user_templates ut where ut.user_id = p.id) templates
       from profiles p join roles r on r.id = p.role_id
      where r.is_admin and p.deleted_at is null`);
  const shouldWarn = admins.filter((a) => a.overrides > 0 || a.templates > 0);

  let wrong = [];
  for (const a of shouldWarn) {
    const row = page.locator('tr').filter({ hasText: a.email }).first();
    if (!(await row.count())) continue;
    const txt = (await row.innerText()).replace(/\s+/g, ' ');
    if (/Template:/i.test(txt) || /Custom/.test(txt)) wrong.push(a.email);
  }
  check('16. no admin row claims a template or override applies',
    wrong.length === 0,
    wrong.length ? wrong.join(', ') : `${shouldWarn.length} admin row(s) checked`);
}

check('12. no 500s or page errors anywhere', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '));

/* ── restore what the probe touched ──────────────────────────────────── */
if (contactsToTrimTo !== null) {
  await db.query(
    `update records set values = jsonb_set(values, '{contact}',
       coalesce((select jsonb_agg(e order by i)
                   from jsonb_array_elements(values->'contact') with ordinality t(e, i)
                  where i <= $2), '[]'::jsonb))
      where id = $1`, [rec.id, contactsToTrimTo]);
}
if (pricingToRestore !== null) {
  await db.query(`update records set values = jsonb_set(values,'{pricing_model}', to_jsonb($2::text)) where id=$1`, [rec.id, pricingToRestore]);
}
await db.query(`update records set values = values - 'mid' - 'mcc_code' where id=$1`, [rec.id]);
await db.query(`delete from case_handling_notes where record_id=$1`, [rec.id]);
await db.query(`update records set deal_name=$2 where id=$1`, [rec.id, originalName]);

const membershipsAfter = (await q(
  `select m.slug || ':' || r.deal_name as pair
     from record_modules rm
     join records r on r.id = rm.record_id
     join modules m on m.id = rm.module_id
    order by 1`)).map((x) => x.pair).join('|');
check('13. this script changed no module memberships',
  membershipsBefore === membershipsAfter,
  membershipsBefore === membershipsAfter ? '' : 'the run itself mutated data');

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) console.log('STILL BROKEN:\n' + failed.map((f) => '  - ' + f.name + (f.detail ? ' — ' + f.detail : '')).join('\n'));

await browser.close();
await db.end();
process.exit(failed.length ? 1 : 0);
