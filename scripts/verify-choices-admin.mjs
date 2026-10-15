/**
 * Izzy's two requests of 14 Oct 2026, driven through the real screens.
 *
 *   "How can I change the choices here? … I want it to be editable in the
 *    admin panel."        — Admin → Presets → Choices, on Current Status.
 *   "Please remove amount of digits restriction on the MID field."
 *
 * What it proves, as an admin, in a browser:
 *   1. an option ADDED in Presets appears in the Leads table's status menu
 *   2. a RENAME there reaches the same menu, under the same key
 *   3. an option nobody holds can be REMOVED, and is gone from the database
 *   4. an option records DO hold is refused, with the count, and stays
 *   5. MID takes a value that is neither 8 nor 9 digits, and saves it
 *
 * It writes, and puts everything back: the probe option is removed (by the
 * screen, or by SQL in `finally` if the screen failed), and MID is restored to
 * what it was. It never selects the probe option on a record, so no record
 * ever holds it.
 *
 *   npm run dev -- -p 3221
 *   npm run verify:choices
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const EMAIL = 'admin@tapdash.test';
/* Signs in and resets this account's password — so never a real person. */
if (!/@([a-z0-9-]+\.)*test$/i.test(EMAIL)) process.exit(1);

const PROBE = 'QA Probe Option';
const PROBE_RENAMED = 'QA Probe Renamed';

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

const [field] = await q(`select id from fields where key = 'current_status'`);
/*
 * ⚠ THE MODULE IS CHOSEN FROM THE DATA, NOT NAMED.
 * This first targeted Leads. On 14 Oct the client archived the 50 demo
 * records and began entering real merchants, which left Leads, Deals and
 * Tickets empty — so the Leads table had no status pill to open, and three
 * checks failed for a reason that had nothing to do with what they test. Pick
 * the display module that has the most live records AND its own Current
 * Status list, so the menu check always has a row to click.
 */
const [target] = await q(
  `select m.id, m.slug, m.label, count(*)::int n
     from record_modules rm
     join records r on r.id = rm.record_id and r.deleted_at is null
     join modules m on m.id = rm.module_id
    where m.slug <> 'records'
      and exists (select 1 from field_choices c where c.field_id = $1 and c.module_id = m.id)
    group by m.id, m.slug, m.label order by n desc limit 1`,
  [field.id],
);
if (!target) { console.log('No display module has both records and its own Current Status list — nothing to drive.'); process.exit(1); }
const leads = target; // the scope under test; named for history, chosen above
console.log(`Exercising ${target.label} (${target.n} live record${target.n === 1 ? '' : 's'}).`);
const probeRows = () =>
  q(`select key::text, value from field_choices where field_id = $1 and module_id = $2 and value in ($3, $4)`, [
    field.id, leads.id, PROBE, PROBE_RENAMED,
  ]);

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? ' PASS' : '*FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

/*
 * Everything below is looked up INSIDE the Choices section. All six Presets
 * sections stay mounted with only one shown, so a page-wide "Save" or "Leads"
 * can resolve to a control in another section — and the sidebar has a Leads
 * entry of its own. Same lesson as the module-chip mis-click recorded in
 * verify-client-reports: scope first, then match.
 */
const choices = () => page.locator('section').filter({ has: page.locator('#choices-field') }).first();

/** Presets → Choices → Current Status → the target module. */
const openLeadsStatusList = async () => {
  await page.goto(`${BASE}/admin/presets`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(800);
  // The tab's text is the label plus a count pill ("Choices14"), so a prefix.
  await page.locator('nav[aria-label="Preset sections"] button', { hasText: /^\s*Choices/ }).first().click();
  await page.waitForTimeout(800);
  const select = page.locator('#choices-field');
  const optionValue = await select.locator('option', { hasText: /^Current Status/ }).first().getAttribute('value');
  await select.selectOption(optionValue);
  await page.waitForTimeout(400);
  await choices().getByRole('button', { name: new RegExp('^' + target.label) }).first().click();
  await page.waitForTimeout(600);
};


/** Index of the probe's label input, read from each input's live value. */
const probeIndex = async () => {
  const inputs = choices().locator('input[aria-label^="Option "][aria-label$=" label"]');
  const n = await inputs.count();
  for (let i = 0; i < n; i += 1) if ((await inputs.nth(i).inputValue()) === PROBE) return i;
  throw new Error(`no option labelled ${PROBE} in the editor`);
};

/** The labels the target module's table offers in its Current Status menu. */
const leadsMenuOptions = async () => {
  await page.goto(`${BASE}/${target.slug}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(2500);
  const pill = page.locator('[title="Change Current Status"]').first();
  if (!(await pill.count())) return null;
  await pill.click();
  await page.waitForTimeout(700);
  const menu = page.locator('[role="menu"]').first();
  const txt = (await menu.count()) ? await menu.innerText() : '';
  await page.keyboard.press('Escape');
  return txt;
};

let midRecord = null;
let midBefore = null;

try {
  /* ── 1. add ─────────────────────────────────────────────────────────── */
  await openLeadsStatusList();
  await choices().getByRole('button', { name: 'Add option' }).click();
  const labels = choices().locator('input[aria-label^="Option "][aria-label$=" label"]');
  await labels.last().fill(PROBE);
  await choices().getByRole('button', { name: /^Save$/ }).click();
  await page.locator('text=/Saved —/').first().waitFor({ timeout: 30000 }).catch(() => {});
  const [added] = await probeRows();
  check('1a. an option added in Presets is stored', Boolean(added), added ? `key ${added.key}` : 'not in field_choices');

  const menu1 = await leadsMenuOptions();
  check(`1b. and the ${target.label} table offers it`, Boolean(menu1?.includes(PROBE)), menu1 === null ? 'no status pill found' : '');

  /* ── 2. rename ──────────────────────────────────────────────────────── */
  await openLeadsStatusList();
  await choices().locator('input[aria-label^="Option "][aria-label$=" label"]').nth(await probeIndex()).fill(PROBE_RENAMED);
  await choices().getByRole('button', { name: /^Save$/ }).click();
  await page.locator('text=/Saved —/').first().waitFor({ timeout: 30000 }).catch(() => {});
  const [renamed] = await probeRows();
  check('2a. a rename keeps the key', Boolean(renamed && added && renamed.key === added.key && renamed.value === PROBE_RENAMED),
    renamed ? `${renamed.key} → “${renamed.value}”` : 'gone');
  const menu2 = await leadsMenuOptions();
  check('2b. and the table shows the new name', Boolean(menu2?.includes(PROBE_RENAMED) && !menu2.includes(PROBE + '\n')), '');

  /* ── 3. remove an option nobody holds ───────────────────────────────── */
  await openLeadsStatusList();
  await choices().getByRole('button', { name: `Remove ${PROBE_RENAMED}` }).click();
  await choices().getByRole('button', { name: /^Remove$/ }).click();
  await page.locator('text=/Removed “/').first().waitFor({ timeout: 30000 }).catch(() => {});
  check('3a. the screen says it was removed', /Removed “QA Probe Renamed”/.test(await page.locator('body').innerText()));
  check('3b. and it is gone from the database', (await probeRows()).length === 0);
  const menu3 = await leadsMenuOptions();
  check(`3c. and from the ${target.label} table`, menu3 !== null && !menu3.includes(PROBE_RENAMED));

  /* ── 4. an option records hold is refused ───────────────────────────── */
  /*
   * The SHARED list, because that is the one records demonstrably hold today:
   * the Records List resolves every record against it. Counted exactly as the
   * database function counts — any record, Recycle Bin included — so the
   * number the screen prints can be asserted, not just its presence.
   */
  const [held] = await q(
    `select c.key::text, c.value,
            (select count(*)::int from records r where (r.values -> 'current_status') ? c.key::text) n
       from field_choices c
      where c.field_id = $1 and c.module_id is null
      order by n desc limit 1`,
    [field.id],
  );
  if (!held || held.n === 0) {
    check('4. an in-use option is refused', false, 'no shared option is held by any record — nothing to try');
  } else {
    await openLeadsStatusList();
    await choices().getByRole('button', { name: /^All modules/ }).first().click();
    await page.waitForTimeout(600);
    await choices().getByRole('button', { name: `Remove ${held.value}` }).click();
    await choices().getByRole('button', { name: /^Remove$/ }).click();
    await page.locator('text=/Move them to another option first/').first().waitFor({ timeout: 30000 }).catch(() => {});
    const txt = await page.locator('body').innerText();
    check('4a. removing an option records hold is refused, with the count',
      txt.includes(`${held.n} record`) && /Move them to another option first/.test(txt),
      `“${held.value}”, ${held.n} record(s)`);
    const [still] = await q(`select 1 from field_choices where field_id=$1 and module_id is null and key=$2`, [field.id, held.key]);
    check('4b. and the option is still there', Boolean(still));
  }

  /* ── 5. MID takes any length ────────────────────────────────────────── */
  [midRecord] = await q(`select id, values->>'mid' as mid from records where deal_name ilike '%Netzach%'`);
  midBefore = midRecord.mid;
  const [mf] = await q(`select digits, hint from fields where key='mid'`);
  check('5a. MID has no digit-count rule', mf.digits === null, `hint: “${mf.hint}”`);

  const [inLeads] = await q(
    `select m.slug from record_modules rm join modules m on m.id=rm.module_id where rm.record_id=$1 limit 1`,
    [midRecord.id],
  );
  await page.goto(`${BASE}/${inLeads.slug}?record=${midRecord.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(2000);
  /* The same header-cell locator `verify-client-reports` has proven: the
     header strip is the first <dl> in the drawer, a cell is the div holding
     the exact label. */
  const midCell = page.locator('dl').first().locator('div').filter({ has: page.getByText('MID', { exact: true }) }).first();
  const midCtl = midCell.locator('input, button').first();
  if (await midCtl.count()) {
    await midCtl.click();
    await page.waitForTimeout(400);
    const input = page.locator('input:focus');
    await input.fill('12345');
    await input.press('Enter');
    await page.waitForTimeout(3500);
    const [after] = await q(`select values->>'mid' mid from records where id=$1`, [midRecord.id]);
    check('5b. a five-digit MID saves', after.mid === '12345', `db now “${after.mid}”`);
  } else {
    check('5b. a five-digit MID saves', false, 'could not find the MID control in the header');
  }

  check('6. no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  /* Put everything back, whatever happened above. */
  const left = await probeRows();
  for (const r of left) {
    await db.query(`delete from field_choices where field_id=$1 and module_id=$2 and key=$3`, [field.id, leads.id, r.key]);
  }
  if (midRecord) {
    /*
     * ⚠ NOT `jsonb_set(values, '{mid}', to_jsonb($2))` WHEN THERE WAS NO MID.
     * `to_jsonb(NULL)` is NULL, and jsonb_set with a NULL value returns NULL —
     * the whole `values` column, every field on a real client's record, would
     * be replaced by nothing. A record that had no MID gets the key removed.
     */
    if (midBefore === null || midBefore === undefined) {
      await db.query(`update records set values = values - 'mid' where id=$1`, [midRecord.id]);
    } else {
      await db.query(`update records set values = jsonb_set(values, '{mid}', to_jsonb($2::text)) where id=$1`, [
        midRecord.id, midBefore,
      ]);
    }
  }
  console.log(`\ncleanup: probe options left ${left.length} (removed), MID restored to “${midBefore}”`);
  await browser.close();
  await db.end();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
process.exit(failed.length ? 1 : 0);
