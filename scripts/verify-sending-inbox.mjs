/**
 * Sending inbox (client, 3 Nov 2026), through a real browser: Presets, the three
 * send dialogs, an agreement sent through Outlook against SignWell's real test
 * mode, the signer's own link on a desktop and a phone, reminders, a corrected
 * signer, Void, the signed-copy download, and a member sending from the company
 * inbox with no Email access of their own.
 *
 * NO EMAIL CAN GO OUT. The company inbox here is a throwaway row with no sign-in
 * behind it, so every queued message is refused at the token step — which is
 * itself the path under test: a refused signer email must come back as that
 * signer's bounce. Signers are @example.com. The SignWell documents are test
 * mode, and voided or cancelled by the end.
 *
 * Everything it creates is removed and the counts compared, except record_activity
 * (append-only; the probe's rows stay, pointing at an id no screen reaches).
 *
 * The local server must be the one under test:
 *   npm run dev -- -p 3221
 *   node --env-file=.env scripts/verify-sending-inbox.mjs [base] [shots dir]
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import net from 'node:net';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
const BASE = process.argv[2] || 'http://localhost:3221';
const SHOTS = process.argv[3] || null;
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ADMIN = 'admin@tapdash.test';
const PW = 'ZzProbe-2026!page';

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);
const one = async (s, p = []) => (await q(s, p))[0];

const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const ref = new URL(SUPA).hostname.split('.')[0];

const me = await one(`select id from profiles where email=$1`, [ADMIN]);
const member = await one(
  `select p.id, p.email from profiles p join roles r on r.id = p.role_id
    where not r.is_admin and p.deleted_at is null and p.status='active' and p.email like '%@tapdash.test'
      and not exists (select 1 from mail_connections c where c.user_id = p.id and c.disconnected_at is null)
    order by p.email limit 1`,
);
const savedHashes = new Map();
async function cookiesFor(user) {
  if (!savedHashes.has(user.id)) savedHashes.set(user.id, (await one('select encrypted_password p from auth.users where id=$1', [user.id])).p);
  await svc.auth.admin.updateUserById(user.id, { password: PW });
  await q(`update profiles set last_seen_at = now() where id=$1`, [user.id]);
  const { data, error } = await anon.auth.signInWithPassword({ email: user.email, password: PW });
  if (error) throw error;
  const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
  const host = new URL(BASE).hostname;
  const out = [];
  if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++) out.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: host, path: '/' });
  else out.push({ name: `sb-${ref}-auth-token`, value: v, domain: host, path: '/' });
  return out;
}

const COUNTED = ['records', 'agreements', 'agreement_signers', 'agreement_files', 'applications', 'proposals', 'mail_identities', 'mail_mailboxes', 'mail_connections', 'mail_send_purposes'];
const snapshot = async () => {
  const out = {};
  for (const t of COUNTED) out[t] = (await one(`select count(*)::int n from ${t}`)).n;
  return out;
};
const before = await snapshot();
const purposesBefore = await q(`select purpose, mode, mailbox_id from mail_send_purposes`);
const home = await one(`select id, slug from modules where kind='display' and not admin_only and not shows_open_cases order by position limit 1`);
const tabKey = (await one(`select agreements_tab_key() k`)).k;

const pass = [], fail = [];
const t = (n, ok, d = '') => (ok ? pass : fail).push(`${n}${d ? '  — ' + d : ''}`);
const until = async (cond, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 500)); } return cond().catch(() => false); };

const tag = Math.random().toString(36).slice(2, 8);
const INBOX = `office-${tag}@zz.test`;
const merchant = `ZZ Inbox Probe ${tag} LLC`;
const addr = { street: '1 Main St', street2: '', city: 'Austin', state: 'TX', zip: '78701' };
const values = {
  legal_business_name: merchant, ein: '123456789', merchant_address: addr, dba: '', business_phone: '5125550100', business_email: `biz-${tag}@example.com`, merchant_website: 'https://example.com',
  avg_transaction: 120.5, max_transaction: '2,500', monthly_acq_volume: 50000, amex_monthly_volume: 5000, describe_product_service: 'Pizza', mcc_code: '5812',
  entity_type: 'llc', business_founded_date: '2019-11-15', building_type: 'shopping_center', building_ownership: 'leases', area_zoned: 'commercial', square_footage: '501_2500',
  bankruptcy: 'never', prior_processor: 'No', cc_termination: 'no', amex_esa: '', ebt_fns: '12345',
  sales_method: { in_person: 70, mail_phone: 10, ecommerce: 20 }, routing_number: '111000025', account_number: '987654321',
  refund_policy: '30 days', inventory: ['on_site'], third_party_shipping: 'no', recurring_subscription: 'yes',
  customer_type: { individual: 60, business: 30, gov: 10 }, customer_profile: { local: 100, national: 0, international: 0 },
  charge_to_service: '2_days', order_to_service: '2_5_days', when_charged: 'time_of_order', advertising_method: 'Google', seasonal: ['Jun', 'Jul'],
  pricing_model: 'ic', td_vmd_volume: 2.95, td_pin_debit_volume: 1.1, td_amex_volume: 3.5, td_ebt_volume: '', td_ebt_auth_fee: '', td_pin_debit_auth_fee: 0.1,
  td_vmd_auth_fee: 0.1, td_batch_fee: 0.25, td_vmd_transaction_fee: '', td_chargeback_fee: 25, td_avs_fee: 0.05, td_monthly_fee: 10, td_pci_fee: 9.95,
  vtd_gateway_provider: 'Authorize.net', td_gateway_provider_mav: 'authorize.NET',
  merchant_direct_relationships: [{ Provider: 'Clover', 'Provider type': 'POS', Item: 'Station Duo' }],
  owner_ownership: [
    { first: 'Jane', last: 'Probe', title: 'CEO', email: `jane-${tag}@example.com`, phone: '5125550101', percentage: 60, address: addr, dob: '1980-01-02' },
    { first: 'John', last: 'Probe', title: 'CFO', email: `john-${tag}@example.com`, phone: '5125550102', percentage: 40, address: addr, dob: '1981-02-03' },
  ],
  owner_private: [{ ssn: '123456789', dl_number: 'TX123', dl_expiry: '2030-05-06' }, { ssn: '987654321', dl_number: 'TX456', dl_expiry: '2031-05-06' }],
  contact: [{ name: 'Mia Probe', email: `mia-${tag}@example.com`, phone: '5125550103' }],
  team_members_assigned: [me.id, member.id],
  relationship_manager: [me.id],
  prior_monthly_volume: '50000', prior_effective_rate: '2.95', tenor_effective_rate: '2.1',
};
const probe = await one(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, $3::jsonb) returning id`, [`ZZ inbox probe ${tag}`, me.id, JSON.stringify(values)]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, home.id, me.id]);

// The throwaway company inbox: a connection row with no tokens behind it, never synced.
const identity = await one(`insert into mail_identities (user_id, microsoft_user_id, tenant_id, primary_email, display_name) values ($1, $2, 'zz', $3, 'Office Probe') returning id`, [me.id, `zz-${tag}`, INBOX]);
const mailbox = await one(`insert into mail_mailboxes (kind, address, display_name, sync_identity_id, sync_status) values ('personal', $1, 'Office Probe', $2, 'paused') returning id`, [INBOX, identity.id]);
await q(`insert into mail_connections (user_id, mailbox_id, identity_id) values ($1, $2, $3)`, [me.id, mailbox.id, identity.id]);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies(await cookiesFor({ id: me.id, email: ADMIN }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
const shot = async (name, pg2 = page) => SHOTS && pg2.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
const text = (pg2 = page) => pg2.evaluate(() => document.body.innerText);
const outbox = (ref) => q(`select id, crm_ref, status, body_html, subject, to_recipients, user_id, requested_by, last_error_code from mail_outbox where mailbox_id=$1 and crm_ref like $2 order by created_at`, [mailbox.id, ref]);
const tokenIn = (html) => (html.match(/\/sign\/([A-Za-z0-9_-]{43})/) ?? [])[1];
const openRecord = (pg2 = page, tab = tabKey) => pg2.goto(`${BASE}/${home.slug}?record=${probe.id}&tab=${tab}`, { waitUntil: 'networkidle', timeout: 180000 });
// The record's drawer is a dialog too; a send dialog is the one with a title.
const dialogOn = (pg2) => pg2.locator('[role="dialog"][aria-labelledby$="-title"]');

async function setPurpose(purpose, choice) {
  await page.goto(`${BASE}/admin/presets?section=sending-inbox`, { waitUntil: 'networkidle', timeout: 180000 });
  await page.locator(`#inbox-${purpose}`).selectOption(choice);
  await page.locator('li', { has: page.locator(`#inbox-${purpose}`) }).getByRole('button', { name: 'Save' }).click();
  return until(async () => (await page.locator('li', { has: page.locator(`#inbox-${purpose}`) }).getByText('Saved').isVisible()));
}

let agreement = null;
try {
  // ── Presets ─────────────────────────────────────────────────────────────
  await page.goto(`${BASE}/admin/presets?section=sending-inbox`, { waitUntil: 'networkidle', timeout: 180000 });
  const presets = await text();
  t('presets: the section is there', presets.includes('Sending inbox') && presets.includes('Applications') && presets.includes('Proposals') && presets.includes('Agreements'));
  const opts = await page.locator('#inbox-agreements option').allInnerTexts();
  t('presets: agreements offer SignWell, the sender’s own, and the connected inbox', opts.some((o) => o.includes('SignWell')) && opts.some((o) => o.includes('own mailbox')) && opts.some((o) => o.includes(INBOX)), opts.join(' | '));
  t('presets: applications do not offer SignWell', !(await page.locator('#inbox-applications option').allInnerTexts()).some((o) => o.includes('SignWell')));
  await shot('si-presets');
  for (const purpose of ['applications', 'proposals', 'agreements']) t(`presets: ${purpose} saved to the company inbox`, await setPurpose(purpose, `mailbox:${mailbox.id}`));
  const saved = await q(`select purpose, mode, mailbox_id, updated_by from mail_send_purposes`);
  t('presets: three rows, each the inbox, each by this admin', saved.length === 3 && saved.every((r) => r.mode === 'mailbox' && r.mailbox_id === mailbox.id && r.updated_by === me.id));

  // ── the agreement dialog ────────────────────────────────────────────────
  await openRecord();
  const panel = page.locator('section.rounded-xl', { has: page.getByRole('heading', { name: /Agreements/ }) });
  await until(() => panel.getByRole('button', { name: 'Send agreement' }).isVisible());
  const dialog = dialogOn(page);
  const openSend = async () => {
    await panel.getByRole('button', { name: 'Send agreement' }).click();
    await page.getByRole('button', { name: /Maverick merchant agreement/ }).first().click();
  };
  const actionsMenu = (name) => panel.getByRole('button', { name: /^Actions for AGR-/ }).first().click().then(() => page.getByRole('button', { name, exact: true }).click());
  await openSend();
  await until(() => dialog.getByRole('button', { name: /Send for signature/ }).isVisible().catch(() => false), 90000).catch(() => {});
  const dlg = await dialog.innerText();
  if (!/Send for signature/.test(dlg)) console.log('DIALOG SAYS:\n' + dlg.slice(0, 1500));
  t('dialog: From is the company inbox, locked', (await dialog.locator('input[readonly]').first().inputValue().catch(() => '')) === INBOX);
  t('dialog: says it is the company inbox', /Company inbox, set by your admin/.test(dlg));
  const message = await dialog.locator('textarea').inputValue().catch(() => '');
  t('dialog: the message keeps a place for each signer’s name', message.includes('{{signer_name}}'), message.slice(0, 60));
  await shot('si-agreement-dialog');
  await dialog.getByRole('button', { name: /Send for signature/ }).click();
  t('agreement: sent', await until(async () => !!(await one(`select id from agreements where record_id=$1`, [probe.id])) && !(await dialog.isVisible()), 120000), errors.slice(-1)[0] ?? (await dialog.innerText().catch(() => '')).slice(-200));

  agreement = await one(`select * from agreements where record_id=$1`, [probe.id]);
  t('agreement: goes through Outlook, from the inbox', agreement?.delivery === 'outlook' && agreement?.delivery_address === INBOX && agreement?.delivery_company === true);
  t('agreement: SignWell test mode, real document', agreement?.test_mode === true && !!agreement?.vendor_document_id);
  t('agreement: keeps the merchant’s name for the signer’s page', agreement?.merchant_name === merchant);
  const signers = await q(`select * from agreement_signers where agreement_id=$1 order by slot`, [agreement.id]);
  t('signers: two, each with their own link', signers.length === 2 && signers.every((s) => s.link_hash && s.link_sealed && s.link_iv) && !signers[0].link_hash.equals(signers[1].link_hash));
  const invites = await outbox('agreement_link:%');
  t('email: one to each signer', invites.length === 2 && invites.every((o) => o.subject === agreement.subject) && invites[0].to_recipients[0].address === `jane-${tag}@example.com` && invites[1].to_recipients[0].address === `john-${tag}@example.com`);
  t('email: each greets its own signer', /Hi Jane/.test(invites[0].body_html) && /Hi John/.test(invites[1].body_html) && !invites.some((o) => o.body_html.includes('{{')));
  const tokens = invites.map((o) => tokenIn(o.body_html));
  t('email: each carries its own link and the button', tokens[0] && tokens[1] && tokens[0] !== tokens[1] && invites.every((o) => /Review and sign/.test(o.body_html)));
  t('email: the link is the CRM’s, not SignWell’s', !invites.some((o) => /signwell\.com/i.test(o.body_html)));
  t('email: sent through the connector, the sender kept', invites.every((o) => o.user_id === me.id && o.requested_by === me.id));
  t('history: on the record’s email, without the links', await (async () => { const m = await one(`select from_identity, to_identity, body from messages where record_id=$1 and external_id=$2`, [probe.id, `agreement:${agreement.id}`]); return m?.from_identity === INBOX && !/\/sign\//.test(m?.body ?? '') && !(m?.body ?? '').includes('{{'); })());

  // No sign-in behind the inbox: Outlook "refuses", and that is a bounce for each signer.
  t('refused: the outbox rows failed', await until(async () => (await outbox('agreement_link:%')).every((o) => o.status === 'failed'), 60000), (await outbox('agreement_link:%')).map((o) => `${o.status}/${o.last_error_code}`).join(','));
  t('refused: each signer is bounced', await until(async () => (await q(`select status::text s from agreement_signers where agreement_id=$1`, [agreement.id])).every((r) => r.s === 'bounced'), 30000));
  t('refused: the sender is notified', await until(async () => (await one(`select count(*)::int n from notifications where agreement_id=$1 and recipient_id=$2`, [agreement.id, me.id])).n >= 2, 15000));

  await openRecord();
  const panelText = await panel.innerText();
  t('panel: names the inbox it went from', panelText.includes(`from ${INBOX}`));
  await shot('si-panel-sent');

  // ── the signer's page ───────────────────────────────────────────────────
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await phoneCtx.newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  const viewedBefore = (await one(`select count(*)::int n from agreement_events where agreement_id=$1 and event_type='document_viewed'`, [agreement.id])).n;
  await phone.goto(`${BASE}/sign/${tokens[0]}`, { waitUntil: 'networkidle', timeout: 120000 });
  const sp = await text(phone);
  t('signer page: no login, ready to sign', /ready for your signature/i.test(sp) && phone.url().includes('/sign/'));
  t('signer page: says who, what and until when', sp.includes('Jane Probe') && sp.includes(merchant) && /AGR-\d{6}/.test(sp) && /Sign by/i.test(sp));
  t('signer page: Tenor, never TapDash', !/tapdash/i.test(sp) && (await phone.locator('img[alt="Tenor Payments"]').isVisible()));
  t('signer page: fits a phone', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  t('signer page: contact is the inbox', sp.includes(INBOX));
  t('signer page: holds no sensitive value', !/123456789|987654321|123-45-6789/.test(await phone.content()));
  t('signer page: not indexed, no referrer', (await phone.locator('meta[name="robots"]').getAttribute('content')).includes('noindex') && (await phone.locator('meta[name="referrer"]').getAttribute('content')) === 'no-referrer');
  await shot('si-sign-phone', phone);
  t('signer page: opening it records nothing (mail scanners)', (await one(`select count(*)::int n from agreement_events where agreement_id=$1 and event_type='document_viewed'`, [agreement.id])).n === viewedBefore);

  const desk = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  await desk.goto(`${BASE}/sign/${tokens[0]}`, { waitUntil: 'networkidle', timeout: 120000 });
  await shot('si-sign-desktop', desk);
  await desk.getByRole('button', { name: 'Review and sign' }).click();
  t('review and sign: lands on this signer’s SignWell page', await until(async () => /signwell\.com\/docs\//.test(desk.url()), 60000), desk.url().slice(0, 60));
  await desk.waitForTimeout(3000);
  await shot('si-signwell', desk);

  await phone.goto(`${BASE}/sign/${'A'.repeat(43)}`, { waitUntil: 'networkidle', timeout: 60000 });
  t('a link that does not exist: says so', (await text(phone)).includes('This link is not valid'));
  const shortLink = await fetch(`${BASE}/sign/short`, { redirect: 'manual' });
  t('anything looser under /sign is private', shortLink.status === 307 && (shortLink.headers.get('location') ?? '').includes('/login'), `${shortLink.status}`);
  for (const fixed of ['complete', 'declined', 'invalid']) {
    await phone.goto(`${BASE}/sign/${fixed}`, { waitUntil: 'networkidle', timeout: 60000 });
    t(`/sign/${fixed}: public, branded`, await phone.locator('img[alt="Tenor Payments"]').isVisible());
  }
  await shot('si-sign-complete', phone);

  // ── reminders by hand ───────────────────────────────────────────────────
  await q(`update agreement_signers set status='sent', bounced_at=null where agreement_id=$1 and slot=1`, [agreement.id]);
  await openRecord();
  await actionsMenu('Send reminder now');
  t('reminder: queued, to the signer still waiting only', await until(async () => (await outbox('agreement_reminder:%')).length === 1, 30000));
  const [reminder] = await outbox('agreement_reminder:%');
  t('reminder: same link, says it is a reminder', tokenIn(reminder.body_html) === tokens[0] && reminder.subject.startsWith('Reminder: ') && reminder.to_recipients[0].address === `jane-${tag}@example.com`);
  t('reminder: by hand does not use up an automatic one', (await one(`select reminders_sent n, last_reminded_at l from agreement_signers where agreement_id=$1 and slot=1`, [agreement.id])).n === 0);

  // ── a corrected signer ──────────────────────────────────────────────────
  await until(async () => (await one(`select status::text s from agreement_signers where agreement_id=$1 and slot=2`, [agreement.id])).s === 'bounced', 5000);
  await q(`update records set "values" = jsonb_set("values", '{owner_ownership,1,email}', to_jsonb($2::text)) where id=$1`, [probe.id, `john2-${tag}@example.com`]);
  await openRecord();
  await panel.locator('li', { hasText: 'John Probe' }).getByRole('button', { name: 'Resend to this signer' }).last().click();
  t('resend: a new email to the corrected address', await until(async () => (await outbox('agreement_link:%')).length === 3, 60000), errors.slice(-1)[0]);
  const third = (await outbox('agreement_link:%'))[2];
  t('resend: the corrected address, a fresh link', third?.to_recipients[0].address === `john2-${tag}@example.com` && third && tokenIn(third.body_html) && tokenIn(third.body_html) !== tokens[1]);
  await phone.goto(`${BASE}/sign/${tokens[1]}`, { waitUntil: 'networkidle', timeout: 60000 });
  t('resend: the old link stops working', (await text(phone)).includes('This link is not valid'));
  await phone.goto(`${BASE}/sign/${third ? tokenIn(third.body_html) : 'none'}`, { waitUntil: 'networkidle', timeout: 60000 });
  t('resend: the new link works', /ready for your signature/i.test(await text(phone)));

  // ── Void ────────────────────────────────────────────────────────────────
  // Let every refused email come back first, or its bounce lands after this reset.
  await until(async () => (await outbox('agreement_%')).every((o) => o.status === 'failed'), 60000);
  await new Promise((r) => setTimeout(r, 3000));
  await q(`update agreement_signers set status='sent', bounced_at=null where agreement_id=$1`, [agreement.id]);
  await openRecord();
  await actionsMenu('Void');
  await page.getByRole('button', { name: 'Void agreement' }).click();
  t('void: the agreement is voided', await until(async () => (await one(`select status::text s from agreements where id=$1`, [agreement.id])).s === 'voided', 60000));
  t('void: each signer told it is withdrawn, nothing to click', await until(async () => { const n = await outbox('agreement_notice:%'); return n.length === 2 && n.every((o) => o.subject.startsWith('Withdrawn: ') && !o.body_html.includes('<a ')); }, 30000), JSON.stringify((await outbox('agreement_notice:%')).map((o) => [o.subject.slice(0, 12), o.body_html.includes('<a ')])));
  await phone.goto(`${BASE}/sign/${tokens[0]}`, { waitUntil: 'networkidle', timeout: 60000 });
  const voided = await text(phone);
  t('void: the signer’s page says withdrawn, and offers no signing', voided.includes('withdrawn') && !voided.includes('Review and sign'));
  await shot('si-sign-voided', phone);

  // ── the signed copy ─────────────────────────────────────────────────────
  await q(`update agreement_files set kind='completed' where agreement_id=$1 and kind='sent_copy'`, [agreement.id]);
  await q(`update agreements set status='completed', completed_at=now(), voided_at=null, download_status='stored' where id=$1`, [agreement.id]);
  await phone.goto(`${BASE}/sign/${tokens[0]}`, { waitUntil: 'networkidle', timeout: 60000 });
  t('completed: the page offers the copy', (await text(phone)).includes('Download your signed copy'));
  await shot('si-sign-completed', phone);
  const copy = await fetch(`${BASE}/sign/${tokens[0]}/copy`);
  const bytes = Buffer.from(await copy.arrayBuffer());
  t('copy: a real PDF, as a download, not cached', copy.status === 200 && bytes.subarray(0, 5).toString() === '%PDF-' && /attachment/.test(copy.headers.get('content-disposition') ?? '') && copy.headers.get('cache-control') === 'no-store', `${copy.status}`);
  const noCopy = await fetch(`${BASE}/sign/${'A'.repeat(43)}/copy`);
  t('copy: a wrong link gets nothing', noCopy.status === 404);
  await q(`update agreements set completed_at=now() - interval '31 days' where id=$1`, [agreement.id]);
  t('copy: after 30 days it is gone', (await fetch(`${BASE}/sign/${tokens[0]}/copy`)).status === 404);

  // ── a broken inbox: nothing can be sent, and it says why ────────────────
  await q(`update mail_connections set status='broken' where mailbox_id=$1`, [mailbox.id]);
  await openRecord();
  await openSend();
  await until(() => dialog.getByRole('button', { name: /Send for signature/ }).isVisible().catch(() => false), 60000);
  t('broken inbox: the dialog says so', /no working connection/.test(await dialog.innerText()));
  t('broken inbox: Send is off', await dialog.getByRole('button', { name: /Send for signature/ }).isDisabled());
  await shot('si-broken-inbox');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await q(`update mail_connections set status='ok' where mailbox_id=$1`, [mailbox.id]);

  // ── a member with no Email access of their own sends from the inbox ─────
  const memberCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await memberCtx.addCookies(await cookiesFor(member));
  const mp = await memberCtx.newPage();
  mp.on('pageerror', (e) => errors.push(String(e)));
  await openRecord(mp, (await one(`select applications_tab_key() k`)).k);
  const sendApp = mp.getByRole('button', { name: /Send application/ }).first();
  if (await until(() => sendApp.isVisible(), 20000)) {
    await sendApp.click();
    const appDialog = dialogOn(mp);
    await until(() => appDialog.locator('input[readonly]').first().isVisible(), 60000);
    t('member: the application’s From is the company inbox, locked', (await appDialog.locator('input[readonly]').first().inputValue()) === INBOX);
    t('member: not told to connect a mailbox', !/Connect your mailbox/.test(await appDialog.innerText()));
    await shot('si-member-application', mp);
    const sendBtn = appDialog.getByRole('button', { name: /^Send/ }).last();
    await sendBtn.click();
    t('member: the application goes', await until(async () => (await outbox('application:%')).length === 1, 90000), errors.slice(-1)[0]);
    const [appMail] = await outbox('application:%');
    t('member: sent through the connector, the member kept as the one who asked', appMail?.user_id === me.id && appMail?.requested_by === member.id);
    t('member: refused send is noted on the record', await until(async () => (await one(`select count(*)::int n from record_activity where record_id=$1 and summary like 'Application email%did not send%'`, [probe.id])).n === 1, 60000));
    t('member: and told in their own notices', await until(async () => (await one(`select count(*)::int n from mail_notices where user_id=$1 and mailbox_id=$2`, [member.id, mailbox.id])).n >= 1, 15000));
  } else {
    t('member: can see Send application (needs the tab’s edit permission)', false, 'button not visible');
  }
  await memberCtx.close();

  // ── the proposal dialog; then the other settings ────────────────────────
  await openRecord();
  const propBtn = page.getByRole('button', { name: 'Send proposal' }).first();
  if (await until(() => propBtn.isVisible(), 20000)) {
    await propBtn.click();
    const pd = dialogOn(page);
    await until(() => pd.locator('input[readonly]').first().isVisible(), 60000);
    t('proposal: From is the company inbox, locked', (await pd.locator('input[readonly]').first().inputValue()) === INBOX);
    await shot('si-proposal-dialog');
    await pd.getByRole('button', { name: 'Cancel' }).click();
  } else t('proposal: Send proposal is on the record', false);

  t('settings: agreements back to SignWell', await setPurpose('agreements', 'signwell'));
  await q(`delete from agreement_signers where agreement_id=$1`, [agreement.id]);
  await q(`update agreements set status='voided', voided_at=now() where id=$1`, [agreement.id]);
  await openRecord();
  await openSend();
  await until(() => dialog.getByRole('button', { name: /Send for signature/ }).isVisible().catch(() => false), 60000);
  const sw = await dialog.innerText();
  t('signwell mode: no From row, and SignWell named as sending', !/Company inbox/.test(sw) && /signing service sends it/.test(sw));
  t('signwell mode: the first signer’s name is already in the message', !(await dialog.locator('textarea').inputValue()).includes('{{signer_name}}'));
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  t('settings: agreements to the sender’s own mailbox', await setPurpose('agreements', 'own'));
  await openRecord();
  await openSend();
  await until(() => dialog.getByRole('button', { name: /Send for signature/ }).isVisible().catch(() => false), 60000);
  t('own mode: a From picker with the sender’s mailboxes', (await dialog.locator('select').first().locator('option').allInnerTexts()).some((o) => o.includes(INBOX)));
  await shot('si-own-mode');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  t('no crashes or 5xx in the browser', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  fail.push(`crashed: ${e instanceof Error ? e.message.slice(0, 400) : e}`);
  await shot('si-crash');
} finally {
  try {
    // A document still open at SignWell (a crash before Void) is cancelled.
    const docs = await q(`select vendor_document_id d, status::text s from agreements where record_id=$1 and vendor_document_id is not null`, [probe.id]);
    for (const d of docs) await fetch(`https://www.signwell.com/api/v1/documents/${d.d}`, { method: 'DELETE', headers: { 'X-Api-Key': process.env.SIGNWELL_API_KEY } }).catch(() => {});
    const files = await q(`select storage_path p from agreement_files where record_id=$1`, [probe.id]);
    if (files.length) await svc.storage.from('agreement-pdfs').remove(files.map((f) => f.p));
    const att = (await q(`select attachments a from mail_outbox where mailbox_id=$1`, [mailbox.id])).flatMap((r) => (r.a ?? []).map((x) => x.path));
    if (att.length) await svc.storage.from('mail-outbox').remove(att);
    await q(`delete from notifications where record_id=$1`, [probe.id]);
    await q(`delete from messages where record_id=$1`, [probe.id]);
    await q(`delete from updates where record_id=$1`, [probe.id]).catch(() => {});
    await q(`delete from mail_send_purposes where mailbox_id=$1 or purpose in ('applications','proposals','agreements')`, [mailbox.id]);
    for (const p of purposesBefore) await q(`insert into mail_send_purposes (purpose, mode, mailbox_id) values ($1,$2,$3)`, [p.purpose, p.mode, p.mailbox_id]);
    await q(`delete from mail_notices where mailbox_id=$1`, [mailbox.id]);
    await q(`delete from mail_outbox where mailbox_id=$1`, [mailbox.id]);
    await q(`delete from agreement_events where agreement_id in (select id from agreements where record_id=$1)`, [probe.id]);
    await q(`delete from agreements where record_id=$1`, [probe.id]);
    await q(`delete from applications where record_id=$1`, [probe.id]);
    await q(`delete from proposals where record_id=$1`, [probe.id]);
    await q(`delete from records where id=$1`, [probe.id]);
    await q(`delete from mail_connections where mailbox_id=$1`, [mailbox.id]);
    await q(`delete from mail_mailboxes where id=$1`, [mailbox.id]);
    await q(`delete from mail_identities where id=$1`, [identity.id]);
    for (const [id, hash] of savedHashes) await q(`update auth.users set encrypted_password=$2 where id=$1`, [id, hash]);
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
