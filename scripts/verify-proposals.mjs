/**
 * Proposals (client, "Proposal template Instructions", 3 Nov 2026), through a
 * real browser: the panel on the record, the send dialog, the preview, a sent
 * proposal in the CRM, and the merchant's own link — on a desktop and a phone
 * screen — with its one-click approval registered on the record. Also Void,
 * and links that no longer work.
 *
 * No email is sent: the two proposals are written straight into the table
 * with a known link, as `sendProposal` would after Outlook accepted the
 * message. The probe record (and with it the proposals and notifications) is
 * hard-deleted at the end and the counts compared. (record_activity is
 * append-only; the probe's few rows stay, pointing at an id no screen reaches.)
 *
 *   npm run dev -- -p 3221
 *   node --env-file=.env scripts/verify-proposals.mjs [base] [shots dir]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomBytes } from 'node:crypto';
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
  proposals: (await q(`select count(*)::int n from proposals`))[0].n,
});
const before = await snapshot();
const home = (await q(`select id, slug from modules where kind='display' and not admin_only and not shows_open_cases order by position limit 1`))[0];
const tabKey = (await q(`select proposals_tab_key() k`))[0].k;

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
const until = async (cond, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 500)); } return cond(); };

const tag = Math.random().toString(36).slice(2, 8);
const merchant = `ZZ Proposal Probe ${tag} LLC`;
const values = {
  legal_business_name: merchant,
  team_members_assigned: [me.id],
  relationship_manager: [me.id],
  contact: [{ name: 'Mia Probe', email: `zz-${tag}@client.test` }],
  prior_monthly_volume: '50000', prior_effective_rate: '2.95', tenor_effective_rate: '2.1',
  prior_monthly_transactions: '1200', prior_auth_fees: '0.15', tenor_auth_fees: '0.08',
  prior_monthly_fees: '89.95', tenor_monthly_fees: '25',
  pos_in_proposal: true,
  pos_description: 'Clover Station Duo at the counter, Clover Flex for tableside.',
  merchant_requirements: [{ Requirement: 'Kiosk ordering', Check: 'Yes' }, { Requirement: 'Gift cards', Check: '' }],
  tenor_features: [{ Feature: 'Phone-number customer lookup', Check: 'Yes' }],
  pos_detail_in_proposal: true,
  merchant_direct_relationships: [
    { Provider: 'Clover', Item: 'Station Duo', Amount: '2', 'Monthly fee': '32.16', 'Per item fee': '10', 'One time fee': '99', 'In proposal': 'Yes' },
    { Provider: 'Comcast', Item: 'Internet', Amount: '1', 'Monthly fee': '80', 'In proposal': '' },
  ],
};
const [probe] = await q(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, $3::jsonb) returning id`, [
  `ZZ proposal probe ${tag}`, me.id, JSON.stringify(values),
]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, home.id, me.id]);

// What `sendProposal` would freeze for these values (content.test.ts pins the arithmetic).
const content = {
  version: 1, merchantName: merchant, preparedOn: new Date().toISOString().slice(0, 10),
  savings: {
    description: 'Probe description: based on the statement we received.',
    rows: [
      { item: 'Effective Rate', volume: 50000, volumeKind: 'money', currentRate: 2.95, proposedRate: 2.1, rateKind: 'percent', currentCost: 1475, proposedCost: 1050, savings: 425 },
      { item: 'Transaction Fees', volume: 1200, volumeKind: 'count', currentRate: 0.15, proposedRate: 0.08, rateKind: 'money', currentCost: 180, proposedCost: 96, savings: 84 },
      { item: 'Monthly Fees', volume: null, volumeKind: null, currentRate: null, proposedRate: null, rateKind: null, currentCost: 89.95, proposedCost: 25, savings: 64.95 },
    ],
    totals: { currentCost: 1744.95, proposedCost: 1171, savings: 573.95 }, monthly: 573.95, annual: 6887.4, threeYear: 20662.2,
  },
  pos: { description: 'Clover Station Duo at the counter.', requirements: [{ text: 'Kiosk ordering', check: true }, { text: 'Gift cards', check: false }], features: [{ text: 'Phone-number customer lookup', check: true }] },
  detailedPos: { rows: [{ product: 'Station Duo', amount: 2, hardwareCost: 10, setupFee: 99, monthlyCost: 64.32 }] },
  closing: { email: ADMIN, phone: '(732) 479-3050', address: '902 East County Line Road, STE 101, Lakewood, NJ 08701', company: 'Tenor Payments' },
};
const pepper = Buffer.from(process.env.OTP_PEPPER, 'base64');
const sent = async () => {
  const token = randomBytes(32).toString('base64url');
  const hash = createHmac('sha256', pepper).update(token).digest();
  const [p] = await q(
    `insert into proposals (record_id, token_hash, content, recipient, subject, sent_by, expires_at)
     values ($1, $2, $3::jsonb, $4, 'Probe', $5, now() + interval '30 days') returning id, number`,
    [probe.id, hash, JSON.stringify(content), `zz-${tag}@client.test`, me.id],
  );
  return { ...p, token, label: `PRO-${String(p.number).padStart(6, '0')}` };
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies(cookies);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
const shot = async (name, pg2 = page) => SHOTS && pg2.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
const text = (pg2 = page) => pg2.evaluate(() => document.body.innerText);

let first, second;
try {
  // ── the panel ──────────────────────────────────────────────────────────
  await page.goto(`${BASE}/${home.slug}?record=${probe.id}&tab=${tabKey}`, { waitUntil: 'networkidle', timeout: 180000 });
  const panel = page.locator('section.rounded-xl', { has: page.getByRole('heading', { name: 'Proposals' }) });
  t('panel: Proposals on the Files tab', await until(() => panel.isVisible()));
  t('panel: Preview and Send proposal', (await panel.getByRole('link', { name: 'Preview' }).isVisible()) && (await panel.getByRole('button', { name: 'Send proposal' }).isVisible()));
  t('panel: sits with Send agreement on Files', await page.getByRole('heading', { name: /Agreements/ }).first().isVisible().catch(() => false));
  await shot('pr-panel-empty');

  // ── the send dialog ────────────────────────────────────────────────────
  await panel.getByRole('button', { name: 'Send proposal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send proposal' });
  t('dialog: opens with the proposal and its savings', await until(async () => (await dialog.innerText().catch(() => '')).includes('$573.95')));
  const dt = await dialog.innerText();
  t('dialog: names the merchant', dt.includes(`Proposal for ${merchant}`));
  t('dialog: To defaults to the first contact', (await dialog.locator('select').nth(1).inputValue()) === `zz-${tag}@client.test`);
  t('dialog: subject in Tenor’s name', (await dialog.locator('input').filter({ hasNot: page.locator('[type=email]') }).nth(1).inputValue()).includes('Tenor Payments'));
  t('dialog: has a Preview link', await dialog.getByRole('link', { name: 'Preview' }).isVisible());
  t('dialog: no blocking note with figures filled in', !dt.includes('has no figures'));
  await shot('pr-dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // ── the preview ────────────────────────────────────────────────────────
  await page.goto(`${BASE}/proposals/preview/${probe.id}?module=${home.slug}`, { waitUntil: 'networkidle', timeout: 180000 });
  const pv = await text();
  t('preview: says nothing has been sent', pv.includes('Nothing has been sent'));
  t('preview: cover names the Legal business name', pv.includes(merchant) && /PROPOSAL/i.test(pv));
  t('preview: savings rows and totals', ['Effective Rate', 'Transaction Fees', 'Monthly Fees', 'Monthly Totals', '$1,475.00', '$1,050.00', '$1,744.95', '$1,171.00'].every((s) => pv.includes(s)));
  t('preview: monthly / annual / 3-year', ['$573.95', '$6,887.40', '$20,662.20'].every((s) => pv.includes(s)) && /3-year savings/i.test(pv));
  t('preview: POS Architecture with check and X', /POS Architecture/i.test(pv) && pv.includes('Kiosk ordering') && pv.includes('Gift cards') && (await page.getByRole('img', { name: 'Not included' }).count()) === 1);
  t('preview: Detailed POS lists only the ticked row, Amount × Monthly fee', pv.includes('Station Duo') && pv.includes('$64.32') && !pv.includes('Internet'));
  t('preview: closing shows the relationship manager’s email', pv.includes(ADMIN.toUpperCase()));
  t('preview: approve button worded per client', pv.includes('CLICK HERE TO APPROVE PROPOSAL') || pv.includes('Click here to approve proposal'));
  // The proposal itself (the CRM around it is renamed in the rebrand step).
  const doc = await page.locator('h1', { hasText: merchant }).locator('xpath=ancestor::div[contains(@class,"max-w-[880px]")][1]').innerText();
  t('proposal: no TapDash, no “processing fees eliminated”', doc.includes('Monthly Totals') && !/tapdash/i.test(doc.replaceAll(ADMIN.toUpperCase(), '')) && !/processing fees eliminated/i.test(doc));
  t('preview: no “click here to view” buttons', !/view detailed analysis|view complete pricing|client portal/i.test(pv));
  await shot('pr-preview');

  // ── a sent proposal in the CRM ─────────────────────────────────────────
  first = await sent();
  await page.goto(`${BASE}/${home.slug}?record=${probe.id}&tab=${tabKey}`, { waitUntil: 'networkidle', timeout: 180000 });
  t('panel: lists the sent proposal as Sent', await until(async () => (await panel.innerText().catch(() => '')).includes(first.label) && (await panel.innerText()).includes('Sent')));
  t('panel: shows its monthly saving', (await panel.innerText()).includes('$573.95/mo'));
  await page.goto(`${BASE}/proposals/${first.id}`, { waitUntil: 'networkidle', timeout: 180000 });
  t('sent page: waiting for approval', (await text()).includes('Waiting for the merchant’s approval'));

  // ── the merchant's link, phone first ───────────────────────────────────
  const merchantCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await merchantCtx.newPage();
  m.on('pageerror', (e) => errors.push(String(e)));
  await m.goto(`${BASE}/proposal/${first.token}`, { waitUntil: 'networkidle', timeout: 180000 });
  const mt = await text(m);
  t('merchant: opens without a login', mt.includes(merchant) && !m.url().includes('/login'));
  t('merchant: phone fits the screen (no sideways scroll)', await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  t('merchant: phone shows the savings cards', mt.includes('$573.95') && mt.includes('$20,662.20'));
  await shot('pr-merchant-phone', m);
  t('merchant: first open marks it Viewed', await until(async () => (await q(`select status from proposals where id=$1`, [first.id]))[0].status === 'viewed', 15000));

  await m.getByRole('button', { name: /approve proposal/i }).click();
  t('merchant: approval confirmed on the page', await until(async () => (await text(m)).includes('Proposal approved'), 30000));
  const [row] = await q(`select status, approved_at, approved_ip from proposals where id=$1`, [first.id]);
  t('CRM registers the approval', row.status === 'approved' && row.approved_at !== null && Boolean(row.approved_ip));
  t('approval in the record’s history', (await q(`select 1 from record_activity where record_id=$1 and kind='proposal' and summary like $2`, [probe.id, `%${first.label} approved%`])).length === 1);
  t('the team is notified once', (await q(`select 1 from notifications where record_id=$1 and source_kind='proposal' and recipient_id=$2`, [probe.id, me.id])).length === 1);
  await shot('pr-merchant-approved', m);
  await m.reload({ waitUntil: 'networkidle' });
  t('merchant: reopening shows it approved, no button', (await text(m)).includes('Proposal approved') && !(await m.getByRole('button', { name: /approve proposal/i }).count()));

  // Desktop view of the same link.
  const wide = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await wide.goto(`${BASE}/proposal/${first.token}`, { waitUntil: 'networkidle', timeout: 180000 });
  t('merchant: desktop shows the table', await wide.locator('table').first().isVisible());
  await shot('pr-merchant-desktop', wide);

  // ── the CRM after approval ─────────────────────────────────────────────
  await page.goto(`${BASE}/${home.slug}?record=${probe.id}&tab=${tabKey}`, { waitUntil: 'networkidle', timeout: 180000 });
  t('panel: Approved, with the badge', await until(async () => (await panel.innerText().catch(() => '')).includes(`${first.label} approved`)));
  await page.goto(`${BASE}/notifications`, { waitUntil: 'networkidle', timeout: 180000 });
  t('notifications: listed as Proposal', await until(async () => (await text()).includes(`Proposal ${first.label} approved by the merchant.`)));
  await page.getByText(`Proposal ${first.label} approved by the merchant.`).first().click();
  t('notifications: opens the record on the proposals tab', await until(() => page.url().includes(`record=${probe.id}`) && page.url().includes(`tab=${tabKey}`), 60000), page.url());

  // ── void ───────────────────────────────────────────────────────────────
  second = await sent();
  await page.goto(`${BASE}/${home.slug}?record=${probe.id}&tab=${tabKey}`, { waitUntil: 'networkidle', timeout: 180000 });
  await until(async () => (await panel.innerText().catch(() => '')).includes(second.label));
  await page.getByRole('button', { name: `Actions for ${second.label}` }).click();
  await page.getByRole('menuitem', { name: 'Void' }).click();
  await page.getByRole('button', { name: 'Void proposal' }).click();
  t('void: recorded', await until(async () => (await q(`select status from proposals where id=$1`, [second.id]))[0].status === 'voided', 30000));
  await m.goto(`${BASE}/proposal/${second.token}`, { waitUntil: 'networkidle' });
  t('void: the merchant’s link says withdrawn', (await text(m)).includes('This proposal was withdrawn'));
  await m.goto(`${BASE}/proposal/${'A'.repeat(43)}`, { waitUntil: 'networkidle' });
  t('a made-up link says not valid', (await text(m)).includes('This link is not valid'));
  await m.goto(`${BASE}/proposals/${first.id}`, { waitUntil: 'networkidle' });
  t('the CRM copy needs a login', m.url().includes('/login'));

  t('no page errors or 5xx', errors.length === 0, errors.slice(0, 3).join(' || '));
} catch (e) {
  fail.push(`script stopped: ${String(e).slice(0, 300)}`);
  await shot('pr-fail');
} finally {
  try {
    await db.query(`delete from notifications where record_id=$1`, [probe.id]);
    await db.query(`delete from proposals where record_id=$1`, [probe.id]);
    await db.query(`delete from records where id=$1`, [probe.id]);
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
