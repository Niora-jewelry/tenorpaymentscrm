/**
 * The five Pricing fields added on 17 Oct 2026 (migration 9767), through a
 * real browser as an admin:
 *
 *   Processor-TD Merchant Pricing: Amex / VMD / Pin Debit Volume Buy Rate
 *   Adjustment (percentage). One Time Charges: Mav Gateway Setup, Mav
 *   Equipment (currency).
 *
 * Each must show in the right subtab, accept a value, save it to
 * records.values under its key, and leave a field-history entry. The
 * residuals rate sync must not react (it reads a fixed list of 16 keys).
 *
 * One probe record is created and hard-deleted at the end; counts compared.
 * (record_activity is append-only; the probe's rows stay, unreachable.)
 *
 *   npm run dev -- -p 3221
 *   node --env-file=.env scripts/verify-pricing-new-fields.mjs
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(ADMIN)) process.exit(1);

const FIELDS = [
  { key: 'td_amex_volume_buy_rate_adj', label: 'Amex Volume Buy Rate Adjustment', subtab: 'Processor-TD Merchant Pricing', input: '0.15' },
  { key: 'td_vmd_volume_buy_rate_adj', label: 'VMD Volume Buy Rate Adjustment', subtab: 'Processor-TD Merchant Pricing', input: '0.25' },
  { key: 'td_pin_debit_volume_buy_rate_adj', label: 'Pin Debit Volume Buy Rate Adjustment', subtab: 'Processor-TD Merchant Pricing', input: '0.35' },
  { key: 'otc_mav_gateway_setup', label: 'Mav Gateway Setup', subtab: 'One Time Charges', input: '125' },
  { key: 'otc_mav_equipment', label: 'Mav Equipment', subtab: 'One Time Charges', input: '349.99' },
];

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const [me] = await q(`select id from profiles where email=$1`, [ADMIN]);
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PW = 'ZzProbe-2026!page';
await svc.auth.admin.updateUserById(me.id, { password: PW });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email: ADMIN, password: PW });
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++)
  cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
else cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });

const snapshot = async () => ({
  records: (await q(`select count(*)::int n from records where deleted_at is null`))[0].n,
  rates: (await q(`select count(*)::int n from residual_merchant_rates`))[0].n,
  memberships: await q(`select m.slug, count(rm.record_id)::int n from modules m left join record_modules rm on rm.module_id=m.id group by m.slug order by m.slug`),
});
const before = await snapshot();

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);

// A display module whose drawer carries the Pricing tab.
const [home] = await q(
  `select m.id, m.slug from modules m join module_tab_order o on o.module_id = m.id join tabs t on t.id = o.tab_id
    where t.key = 'pricing' and m.kind = 'display' and not m.admin_only and not m.shows_open_cases order by m.position limit 1`);
const [probe] = await q(
  `insert into records (deal_name, creator_kind, creator_user_id, "values")
   values ('ZZ pricing-fields probe', 'user', $1, jsonb_build_object('team_members_assigned', jsonb_build_array($2::text)))
   returning id`, [me.id, me.id]);
await db.query(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, home.id, me.id]);

const valueOf = async (key) => (await q(`select values->>$2 v from records where id=$1`, [probe.id, key]))[0]?.v ?? null;
const until = async (cond, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 400)); } return cond(); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
await page.route('**://*.posthog.com/**', (r) => r.abort());

try {
  await page.goto(`${BASE}/${home.slug}?record=${probe.id}&tab=pricing`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /^Pricing/ }).first().click().catch(() => {});
  await page.waitForTimeout(800);

  for (const f of FIELDS) {
    await page.getByRole('button', { name: f.subtab, exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(700);
    const label = page.getByText(f.label, { exact: true }).first();
    const shown = (await label.count()) === 1 && (await label.isVisible());
    t(`"${f.label}" shows in ${f.subtab}`, shown);
    if (!shown) continue;
    // The value box itself, inside the cell that owns this label. The label
    // row also holds a small icon control, which is not the editor.
    const cell = page.locator('div').filter({ has: page.getByText(f.label, { exact: true }) }).filter({ hasText: 'Add value' }).last();
    await cell.getByText('Add value', { exact: true }).first().click();
    await page.waitForTimeout(400);
    const input = page.locator('input:focus');
    await input.fill(f.input);
    await input.press('Enter');
    const saved = await until(async () => (await valueOf(f.key)) !== null);
    const stored = await valueOf(f.key);
    t(`"${f.label}" saves`, saved && Number(stored) === Number(f.input), `typed ${f.input} → stored ${stored}`);
    await page.waitForTimeout(600);
  }

  // Reload: values still there, read back from the database.
  await page.reload({ waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /^Pricing/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Processor-TD Merchant Pricing', exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  const body = await page.locator('body').innerText();
  t('values are still shown after a reload', /0\.15/.test(body) && /0\.25/.test(body) && /0\.35/.test(body));

  const hist = await q(`select field_key from record_activity where record_id=$1 and kind='field'`, [probe.id]);
  const logged = FIELDS.filter((f) => hist.some((h) => h.field_key === f.key)).length;
  t('every save is in the field history', logged === FIELDS.length, `${logged}/${FIELDS.length}`);
  const rates = (await q(`select count(*)::int n from residual_merchant_rates`))[0].n;
  t('residuals rate sync did not react', rates === before.rates, `${before.rates} → ${rates}`);
  t('no page errors or 500s', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 220)}`);
  await page.screenshot({ path: 'D:/tmp-claude/pricing-fields-fail.png', fullPage: true }).catch(() => {});
} finally {
  try { await db.query(`delete from records where id=$1`, [probe.id]); } catch (e) { fail.push(`restore failed: ${e.message}`); }
  const after = await snapshot();
  const same = JSON.stringify(before) === JSON.stringify(after);
  console.log(same ? `restore: records ${after.records}, rates ${after.rates}, module counts — exactly as before` : `⚠ RESTORE MISMATCH\n${JSON.stringify(before)}\n${JSON.stringify(after)}`);
  if (!same) fail.push('restore mismatch');
  await browser.close();
  await db.end();
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed ===`);
process.exit(fail.length ? 1 : 0);
