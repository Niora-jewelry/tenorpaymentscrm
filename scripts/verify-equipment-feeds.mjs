/**
 * Merchant Equipment Setup feeds the proposal and the agreement (client, 5 Nov 2026: "proposal
 * will pull from here instead"). Checks the real pages, as an admin and as a member, because a
 * member is where hidden columns matter:
 *
 *   Detailed POS   lists the rows ticked Proposal, and nothing from the old grid
 *   Agreement      the equipment line names each provider once, and nothing from the old sections
 *   Hidden column  absent from the proposal, with a note saying something was left out
 *   Hidden provider  the agreement can't be previewed by someone who can't see its names
 *
 * Works before and after migration 9916. Sends nothing: only previews are opened. Everything it
 * creates is removed at the end and the counts compared.
 *
 *   next start -p 3221
 *   node --env-file=.env --env-file=.env.local scripts/verify-equipment-feeds.mjs [base]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import net from 'node:net';
import pg from 'pg';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const BASE = process.argv[2] || 'http://localhost:3221';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const MEMBER = 'itest-invited-1788686334823@tapdash.test';
for (const e of [ADMIN, MEMBER]) if (!/@([a-z0-9-]+\.)*test$/i.test(e)) process.exit(1);

const db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 3, keepAlive: true });
db.on('error', (e) => console.error('[pool] connection dropped, carrying on:', e.message));
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];
const savedHashes = new Map();
const seenBefore = new Map();
async function cookiesFor(email) {
  const [u] = await q(`select id, last_seen_at from profiles where email=$1`, [email]);
  seenBefore.set(u.id, u.last_seen_at);
  await db.query(`update profiles set last_seen_at = now() where id=$1`, [u.id]);
  savedHashes.set(u.id, (await q('select encrypted_password p from auth.users where id = $1', [u.id]))[0]?.p ?? null);
  const pw = `Zz-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}!`;
  await svc.auth.admin.updateUserById(u.id, { password: pw });
  await new Promise((r) => setTimeout(r, 1100));
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw });
  if (error) throw error;
  const v = `base64-${Buffer.from(JSON.stringify(data.session)).toString('base64url')}`;
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });
  return { id: u.id, cookies: out };
}

const pass = [];
const fail = [];
const t = (n, ok, d = '') => {
  (ok ? pass : fail).push(`${n}${d ? `  — ${d}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${d ? `  — ${d}` : ''}`);
};

const counts = async () => (await q(`select
  (select count(*)::int from equipment_rows) equipment_rows,
  (select count(*)::int from records) records,
  (select count(*)::int from proposals) proposals,
  (select count(*)::int from agreements) agreements`))[0];
const before = await counts();

const member = await cookiesFor(MEMBER);
const admin = await cookiesFor(ADMIN);

const [where] = await q(`select s.id subtab_id, s.tab_id from subtabs s where s.shows_equipment_setup`);
const fieldId = async (key) => (await q(`select id from fields where key=$1`, [key]))[0].id;
const contacts = (await q(`select id, slug from modules where slug='contacts'`))[0];
const providers = await q(`select id, name from equipment_providers where is_preset and name in ('NMI', 'Valor')`);
const provider = (name) => providers.find((p) => p.name === name).id;

// The member's temporary reach: every tab and sub-tab, so only what a step hides is hidden.
const allScopes = [
  ...(await q(`select id, 'tab' k from tabs`)),
  ...(await q(`select id, 'subtab' k from subtabs`)),
];
const fieldScopes = await Promise.all(['eq_provider', 'eq_monthly_fee'].map(fieldId));
const SETTINGS = ['agreements.send'];
const grantsBefore = await q(`select * from user_grants where user_id=$1`, [member.id]);
const settingsBefore = await q(`select * from permission_settings where owner_kind='user' and owner_id=$1 and key = any($2)`, [member.id, SETTINGS]);
const setGrant = async (kind, scopeId, level) => {
  await db.query(`delete from user_grants where user_id=$1 and scope_kind=$2 and scope_id=$3`, [member.id, kind, scopeId]);
  if (level) await db.query(`insert into user_grants (user_id, scope_kind, scope_id, grant_level) values ($1, $2, $3, $4)`, [member.id, kind, scopeId, level]);
};

const tag = Math.random().toString(36).slice(2, 8);
const merchant = `ZZ Feeds Probe ${tag} LLC`;
const values = {
  legal_business_name: merchant,
  // On the team, so the member can open the record.
  team_members_assigned: [admin.id, member.id],
  relationship_manager: [admin.id],
  prior_monthly_volume: '50000', prior_effective_rate: '2.95', tenor_effective_rate: '2.1',
  prior_monthly_transactions: '1200', prior_auth_fees: '0.15', tenor_auth_fees: '0.08',
  prior_monthly_fees: '89.95', tenor_monthly_fees: '25',
  pos_detail_in_proposal: true,
  // Old sections: still on the record, and must print nowhere.
  merchant_direct_relationships: [{ Provider: 'OldDirectCo', 'Provider type': 'POS', Item: 'OldGridItem', Amount: '1', 'Monthly fee': '7', 'In proposal': 'Yes' }],
  vtd_gateway_provider: 'OldCostsCo',
};
const [probe] = await q(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, $3::jsonb) returning id`, [`ZZ feeds probe ${tag}`, admin.id, JSON.stringify(values)]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, contacts.id, admin.id]);
await q(`insert into record_team_members (record_id, user_id) values ($1, $2), ($1, $3) on conflict do nothing`, [probe.id, admin.id, member.id]);
const row = (n, p, item, amount, monthly, perItem, oneTime, ticked) => q(
  `insert into equipment_rows (record_id, row_no, provider_id, item, item_amount, monthly_fee, per_item_fee, one_time_fee, proposal, created_by)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [probe.id, n, p, item, amount, monthly, perItem, oneTime, ticked, admin.id],
);
await row(1, provider('NMI'), 'Station Duo', 2, 32.16, 10, 99, true);
await row(2, provider('Valor'), 'Unticked Thing', 1, 80, null, null, false);
await row(3, provider('Valor'), null, 1, 5, null, null, true);
await row(4, provider('NMI'), 'Second NMI Item', null, null, null, null, false);

const browser = await chromium.launch();
const errors = [];
const session = async (cookies) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.addCookies(cookies);
  await ctx.route('**://*.posthog.com/**', (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page };
};
const proposal = async (page) => {
  await page.goto(`${BASE}/proposals/preview/${probe.id}?module=${contacts.slug}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForTimeout(500);
  return page.locator('body').innerText();
};
const agreementText = async (ctx) => {
  const res = await ctx.request.get(`${BASE}/api/agreements/preview/${probe.id}?kind=maverick_merchant`, { timeout: 180000 });
  if (res.status() !== 200) return { status: res.status(), text: await res.text() };
  const doc = await getDocument({ data: new Uint8Array(await res.body()), useSystemFonts: true, verbosity: 0 }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i += 1) text += `${(await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(' ')}\n`;
  return { status: 200, text };
};
const printsNames = (text) => /NMI, Valor/.test(text) && text.split('NMI').length === 2;
const printsOld = (text) => /OldDirectCo|OldGridItem|OldCostsCo/.test(text);

try {
  const a = await session(admin.cookies);

  // ── admin ────────────────────────────────────────────────────────────
  let pv = await proposal(a.page);
  t('admin: Detailed POS lists a ticked row, Amount × Monthly fee', pv.includes('Station Duo') && pv.includes('$64.32'));
  t('admin: hardware cost and setup fee come from the row', pv.includes('$10.00') && pv.includes('$99.00'));
  t('admin: a ticked row with no item shows its provider', pv.includes('Valor') && pv.includes('$5.00'));
  t('admin: an unticked row is left out', !pv.includes('Unticked Thing') && !pv.includes('Second NMI Item'));
  t('admin: nothing from the old grid', !printsOld(pv));
  t('admin: no "left out" note', !pv.includes('so they are left out'));

  let pdf = await agreementText(a.ctx);
  t('admin: agreement preview opens', pdf.status === 200, `${pdf.status}`);
  t('admin: equipment line names each provider once', printsNames(pdf.text), pdf.text.match(/.{0,30}NMI.{0,30}/)?.[0] ?? 'no NMI');
  t('admin: nothing from the old sections on the agreement', !printsOld(pdf.text));

  // Unticked page: rows are not printed at all.
  await db.query(`update records set "values" = "values" - 'pos_detail_in_proposal' where id=$1`, [probe.id]);
  pv = await proposal(a.page);
  t('admin: page not ticked means no Detailed POS', !pv.includes('Station Duo'));
  await db.query(`update records set "values" = "values" || '{"pos_detail_in_proposal": true}'::jsonb where id=$1`, [probe.id]);

  // ── member, seeing everything ────────────────────────────────────────
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1 and key = any($2)`, [member.id, SETTINGS]);
  await db.query(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, 'agreements.send', 'yes')`, [member.id]);
  // Some tabs refuse a grant, their own setting decides them: those stay as they are.
  for (const s of allScopes) await setGrant(s.k, s.id, 'edit').catch((e) => { if (!/no tab or sub-tab level/.test(e.message)) throw e; });
  const m = await session(member.cookies);

  pv = await proposal(m.page);
  t('member: Detailed POS lists the same row', pv.includes('Station Duo') && pv.includes('$64.32'));
  t('member: nothing from the old grid', !printsOld(pv));
  pdf = await agreementText(m.ctx);
  const baselineOpens = pdf.status === 200;
  t('member: agreement preview opens when everything is visible', baselineOpens, `${pdf.status} ${pdf.status === 200 ? '' : pdf.text.slice(0, 120)}`);
  t('member: equipment line names the providers', baselineOpens && printsNames(pdf.text));

  // ── member, a fee column hidden ──────────────────────────────────────
  await setGrant('field', fieldScopes[1], 'hidden');
  pv = await proposal(m.page);
  t('hidden fee: the row still shows', pv.includes('Station Duo'));
  t('hidden fee: its monthly cost does not', !pv.includes('$64.32') && !pv.includes('$5.00'));
  t('hidden fee: the sender is told something was left out', pv.includes('so they are left out'));
  await setGrant('field', fieldScopes[1], null);

  // ── member, the provider column hidden ───────────────────────────────
  await setGrant('field', fieldScopes[0], 'hidden');
  pv = await proposal(m.page);
  t('hidden provider: a row with an item still shows', pv.includes('Station Duo'));
  t('hidden provider: its name is not printed in Detailed POS', !pv.includes('Valor'));
  pdf = await agreementText(m.ctx);
  t('hidden provider: the agreement preview is refused', pdf.status === 403 && /section you can.t see/.test(pdf.text), `${pdf.status}`);
  t('hidden provider: no name reaches the response', !/NMI|Valor/.test(pdf.text));
  await setGrant('field', fieldScopes[0], null);

  // ── member, the whole sub-tab hidden ─────────────────────────────────
  await setGrant('subtab', where.subtab_id, 'hidden');
  pv = await proposal(m.page);
  t('hidden sub-tab: no equipment row in the proposal', !pv.includes('Station Duo') && !pv.includes('Valor'));
  t('hidden sub-tab: the sender is told', pv.includes('left out'));
  pdf = await agreementText(m.ctx);
  t('hidden sub-tab: the agreement preview is refused', pdf.status === 403, `${pdf.status}`);
  await setGrant('subtab', where.subtab_id, 'edit');

  t('no page errors', errors.length === 0, errors.join(' | ').slice(0, 400));
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
  console.log(String(e.stack ?? e).slice(0, 600));
} finally {
  await browser.close().catch(() => {});
  await db.query(`delete from notifications where record_id=$1`, [probe.id]).catch(() => {});
  // A record's delete cascades widely and can outlast the default statement timeout.
  const removal = await db.connect();
  try {
    await removal.query('begin');
    await removal.query(`set local statement_timeout = '280s'`);
    await removal.query(`delete from records where id=$1`, [probe.id]);
    await removal.query('commit');
  } catch (e) {
    await removal.query('rollback').catch(() => {});
    fail.push(`remove probe: ${e}`);
  } finally {
    removal.release();
  }
  await db.query(`delete from user_grants where user_id=$1`, [member.id]).catch((e) => fail.push(`clear grants: ${e}`));
  for (const g of grantsBefore) {
    const cols = Object.keys(g);
    await db.query(`insert into user_grants (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => g[c])).catch((e) => fail.push(`restore grant: ${e}`));
  }
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1 and key = any($2)`, [member.id, SETTINGS]).catch(() => {});
  for (const p of settingsBefore) {
    const cols = Object.keys(p);
    await db.query(`insert into permission_settings (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => p[c])).catch((e) => fail.push(`restore setting: ${e}`));
  }
  await db.query(`delete from rate_limit_counters where key like any($1)`, [[`agreement_preview:user:${member.id}`, `agreement_preview:user:${admin.id}`]]).catch(() => {});
  for (const [id, seen] of seenBefore) await db.query(`update profiles set last_seen_at = $2 where id=$1`, [id, seen]).catch(() => {});
  for (const [id, hash] of savedHashes) if (hash) await db.query('update auth.users set encrypted_password = $2 where id = $1', [id, hash]).catch(() => {});
  const after = await counts();
  const drift = Object.keys(before).filter((k) => after[k] !== before[k]);
  t('every count back to where it started', drift.length === 0, drift.map((d) => `${d} ${before[d]}→${after[d]}`).join(', '));
  await db.end();
}

console.log(`\nPASS ${pass.length}  FAIL ${fail.length}`);
for (const f of fail) console.log(`  ✗ ${f}`);
process.exit(fail.length ? 1 : 0);
