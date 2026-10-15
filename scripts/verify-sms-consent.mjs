/**
 * One click in the record drawer must write one row to `sms_consents`.
 *
 * That table has stood at zero rows since it was created, so nothing here has
 * ever been exercised against a browser. Carrier approval rests on it.
 *
 * Cleans up after itself: the row it creates is deleted at the end.
 *
 *   npm run dev -- -p 3221
 *   npm run verify:consent
 *
 * ── WHY IT WAITS FOR THE BADGE INSTEAD OF SLEEPING ───────────────────────
 * A fixed 2.5s pause reported "the badge never flips to Consented", which
 * reads exactly like a real defect: the rep clicks, nothing changes, so they
 * click again. It was the test being impatient — the click costs two server
 * round trips, the insert and the re-read, and in dev that is slower than the
 * guess. Waiting for the outcome says what happened; waiting for a duration
 * invents a bug for someone else to chase.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const EMAIL = 'admin@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(EMAIL)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const [me] = await q(`select id from profiles where email=$1`, [EMAIL]);
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PW = 'ZzProbe-2026!page';
await svc.auth.admin.updateUserById(me.id, { password: PW });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email: EMAIL, password: PW });
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++)
  cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
else cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });

/*
 * ── A NUMBER NOBODY HAS CONSENTED YET, ON A RECORD NO MODULE SHOWS ───────
 * This used to take "the record the one inbound text landed on". On 14 Oct a
 * real consent was recorded for that number on the live site, so the badge
 * rightly read "Consented" and there was nothing for this script to click.
 *
 * So it picks a record whose first contact phone (sync-enabled, so the
 * composer offers it) has no active consent, from the ARCHIVED records — the
 * client's demo data, shown in no module. Probing there means nothing this
 * does can appear on a screen staff are working from.
 */
const [rec] = await q(
  `select r.id, r.deal_name, r.values -> 'contact' -> 0 ->> 'phone' as e164
     from records r
    where r.deleted_at is null
      and not exists (select 1 from record_modules rm where rm.record_id = r.id)
      and r.values -> 'contact' -> 0 ->> 'phone' ~ '^\\+[1-9][0-9]{7,14}$'
      and not exists (select 1 from phone_messages m where m.record_id = r.id and m.deleted_at is null)
      and not exists (select 1 from sms_consents c
                       where c.e164 = r.values -> 'contact' -> 0 ->> 'phone' and c.revoked_at is null)
    order by r.created_at limit 1`,
);
if (!rec) { console.log('no archived record with an unconsented contact phone — nothing to probe'); process.exit(1); }
const startedAt = new Date();
/* Opened through the Records List, which shows every record regardless of
   module membership. This required a module and stopped running on 14 Oct,
   when the client archived the demo records — this one among them. */

const mine = () => q(`select count(*)::int n from sms_consents where e164 = $1 and recorded_by_id = $2 and created_at >= $3`, [rec.e164, me.id, startedAt]);
const before = (await mine())[0].n;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });

const pass = [], fail = [];
const t = (name, ok, detail = '') => (ok ? pass : fail).push(`${name}${detail ? '  — ' + detail : ''}`);

await page.goto(`${BASE}/records?record=${rec.id}`, { waitUntil: 'networkidle', timeout: 180000 });
await page.waitForTimeout(1200);

/*
 * Scoped to a tab strip, never the whole page: the drawer's "IN MODULES" row
 * is also a row of buttons, and clicking one of those changes the record's
 * module membership. A check that mutates what it checks is worse than none.
 */
const tab = async (name) => {
  const re = new RegExp('^\s*' + name);
  const deadline = Date.now() + 30000;
  for (;;) {
    const navs = page.locator('nav');
    for (let i = 0; i < (await navs.count()); i += 1) {
      const nav = navs.nth(i);
      if ((await nav.locator('button').count()) < 2) continue;
      const t = nav.locator('button').filter({ hasText: re }).first();
      if (await t.count()) { await t.click(); await page.waitForTimeout(2500); return true; }
    }
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(500);
  }
};

t('the Communication tab opened', await tab('Communication'));
{
  const navs = page.locator('nav');
  const labels = [];
  for (let i = 0; i < (await navs.count()); i += 1) labels.push('[' + (await navs.nth(i).allInnerTexts()).join(' / ').split('\n').join('|') + ']');
  console.log('   navs seen: ' + labels.join('  '));
}
/*
 * The subtab strip is not a <nav>, so it is matched by exact label instead.
 * Safe here, and only here: the drawer's "IN MODULES" row is the thing a
 * page-wide button match can hit by accident, and no module is called "Text"
 * — they are Leads, Deals, Contacts, Tickets, Residuals and Phone.
 */
const textTab = page.getByRole('button', { name: 'Text', exact: true }).first();
const opened = (await textTab.count()) > 0;
if (opened) { await textTab.click(); await page.waitForTimeout(3000); }
t('the Text subtab opened', opened);
await page.waitForTimeout(1500);

const body = await page.locator('body').innerText();
t('the drawer opened on a record', body.includes(rec.deal_name ?? ''), rec.deal_name);
t('the consent warning is shown where the text is written', /No consent on file/i.test(body));

const recordBtn = page.getByRole('button', { name: /Record consent|consent/i }).first();
if (await recordBtn.count()) {
  await recordBtn.click();
  await page.waitForTimeout(600);
  const withScript = await page.locator('body').innerText();
  t('the script to read aloud is shown before recording', /Before we continue/.test(withScript));

  const agreed = page.getByRole('button', { name: /They agreed on a call/i }).first();
  t('the one-click button is there', (await agreed.count()) > 0);
  if (await agreed.count()) {
    await agreed.click();
    /* Two server round trips follow the click — the insert, then the re-read
       that repaints the badge. In dev each is slow, so this waits for the
       outcome rather than guessing at a duration. */
    await page
      .locator('text=/Consented on a call/i')
      .first()
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    const after = await page.locator('body').innerText();
    t('the badge flips to "Consented"', /Consented on a call/i.test(after), after.match(/Consented[^\n]*/)?.[0] ?? '');
  }
} else {
  t('a control to record consent exists', false, 'no button found');
}

/*
 * ⚠ ONLY THIS RUN'S ROW. This read the newest consent in the whole table and
 * passed off a real one a person had recorded the day before — a pass that
 * proved nothing about the click. Number, author and start time pin it to
 * the row this script itself caused.
 */
const rows = await q(
  `select e164, source, left(consent_text, 48) as text, recorded_by_id is not null as has_author, created_at
     from sms_consents where e164 = $1 and recorded_by_id = $2 and created_at >= $3
    order by created_at desc limit 1`,
  [rec.e164, me.id, startedAt],
);
const after = (await mine())[0].n;
t('a row was written to sms_consents', after === before + 1, `${before} -> ${after}`);
if (rows[0]) {
  t('it stores the number, the source and who recorded it', Boolean(rows[0].e164 && rows[0].source && rows[0].has_author), JSON.stringify(rows[0]));
  t('it stores the exact words agreed to', /Before we continue/.test(rows[0].text ?? ''), rows[0].text);
}
t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);

/* Put the database back. */
/*
 * ⚠ ONLY THE PROBE'S OWN ROW. This deleted every consent created in the last
 * five minutes — harmless on a demo database, and on a live one it would
 * erase a real consent a rep happened to record during the run: the exact
 * evidence the carriers ask for. Number + author + start time, nothing wider.
 */
const removed = await db.query(
  `delete from sms_consents where e164 = $1 and recorded_by_id = $2 and created_at >= $3`,
  [rec.e164, me.id, startedAt],
);
console.log(`probe consent removed (${removed.rowCount} row); total sms_consents now`,
  (await q(`select count(*)::int n from sms_consents`))[0].n);

await browser.close();
await db.end();
process.exit(fail.length ? 1 : 0);
