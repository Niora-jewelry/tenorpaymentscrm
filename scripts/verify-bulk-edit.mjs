/**
 * Bulk edit, driven through the real screen.
 *
 * It had no test of any kind. Asked about directly by the client on 15 Oct
 * ("Did you add bulk edit function right?"), so this proves it rather than
 * asserting it: tick two rows in the Records List → Edit → pick a field →
 * "Apply to 2 records" → both rows hold the value in the database.
 *
 * Probes only ARCHIVED records — the client's demo data, shown in no module —
 * so nothing staff are working on is touched. Each record's `values` is
 * snapshotted first and written back exactly afterwards, and the restore is
 * checked by hash.
 *
 *   npm run dev -- -p 3221
 *   npm run verify:bulk
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const EMAIL = 'admin@tapdash.test';
/* Signs in and resets this account's password — so never a real person. */
if (!/@([a-z0-9-]+\.)*test$/i.test(EMAIL)) process.exit(1);
const PROBE = 'ZZ bulk-edit probe';

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

/* Two archived records with distinct, unambiguous names. */
const probes = await q(
  `select r.id, r.deal_name, r.values::text as original, md5(r.values::text) as h
     from records r
    where r.deleted_at is null
      and not exists (select 1 from record_modules rm where rm.record_id = r.id)
      and r.deal_name ~ '^[A-Za-z]'
      and (select count(*) from records x where x.deal_name = r.deal_name and x.deleted_at is null) = 1
    order by r.created_at limit 2`);
if (probes.length < 2) { console.log('need two archived records to probe'); process.exit(1); }

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

let fieldLabel = null, fieldKey = null;
try {
  await page.goto(`${BASE}/records`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(2000);

  for (const p of probes) await page.getByLabel(`Select ${p.deal_name}`, { exact: true }).check();
  t('two rows can be ticked', true, probes.map((p) => p.deal_name).join(' + '));

  /*
   * ⚠ THE EDIT IN THE BULK BAR, NOT THE FIRST "Edit" ON THE PAGE.
   * A page-wide match hit a cell's inline-edit control on the first row and
   * opened the text box on a real merchant's Legal business name. Nothing was
   * saved — checked in record_activity — but the bar is now found by what
   * only it contains: the selection count.
   */
  const bar = page.locator('div').filter({ hasText: /records? selected/ }).filter({ hasText: 'Restore to module' }).last();
  await bar.getByText('Edit', { exact: true }).click();
  await page.waitForTimeout(600);
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  // The dialog's markup is <label>Field</label><select>…, then <label>Set to</label><input>.
  const fieldSelect = page.locator('label:text-is("Field") + select').first();
  const options = await fieldSelect.locator('option').allInnerTexts();
  fieldLabel = ['Merchant industry', 'Merchant website', 'Legal business name'].find((l) => options.includes(l)) ?? null;
  t('the dialog offers a plain text field to set', Boolean(fieldLabel), fieldLabel ?? `offered: ${options.slice(0, 8).join(', ')}`);
  if (fieldLabel) {
    [{ key: fieldKey }] = await q(`select key from fields where label = $1`, [fieldLabel]);
    await fieldSelect.selectOption({ label: fieldLabel });
    await page.locator('label:text-is("Set to") + input').first().fill(PROBE);
    await page.getByRole('button', { name: 'Apply to 2 records' }).click();
    await page.waitForTimeout(4000);

    const after = await q(`select id, values->>$2 as v from records where id = any($1)`, [probes.map((p) => p.id), fieldKey]);
    t('both records hold the new value', after.length === 2 && after.every((r) => r.v === PROBE),
      after.map((r) => `“${r.v}”`).join(', '));
    const [other] = await q(
      `select count(*)::int n from records where values->>$1 = $2 and not (id = any($3))`, [fieldKey, PROBE, probes.map((p) => p.id)]);
    t('and no other record was touched', other.n === 0, `${other.n} other record(s) hold the probe`);
  }
  t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 200)}`);
} finally {
  /* Exactly as they were. */
  for (const p of probes) await db.query(`update records set values = $2::jsonb where id = $1`, [p.id, p.original]);
  const back = await q(`select id, md5(values::text) h from records where id = any($1)`, [probes.map((p) => p.id)]);
  const exact = back.every((b) => probes.find((p) => p.id === b.id).h === b.h);
  console.log(`restore: ${exact ? 'both records byte-identical to before' : '⚠ RESTORE MISMATCH'}`);
  if (!exact) fail.push('restore mismatch');
  await browser.close();
  await db.end();
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
process.exit(fail.length ? 1 : 0);
