/**
 * Field Highlight Glows, end to end in a real browser, one check per line of the
 * spec's acceptance checklist, as an admin and as a member.
 *
 * No email and no vendor are involved: application and agreement states are rows the
 * run writes directly on its own probe record. Writes one probe record, its rows and
 * temporary settings on the member, and removes them at the end. Field edits leave
 * record_activity entries behind by design: that log is append-only and survives a
 * record being removed.
 *
 *   npx next dev -p 3221
 *   node --env-file=.env scripts/verify-field-glows.mjs
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
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
const seenBefore = new Map();
async function cookiesFor(email) {
  const [u] = await q(`select id, last_seen_at from profiles where email=$1`, [email]);
  seenBefore.set(u.id, u.last_seen_at);
  await db.query(`update profiles set last_seen_at = now() where id=$1`, [u.id]);
  // Test accounts only: their password stays this probe value from run to run.
  const PW = 'ZzProbe-2026!rteams';
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
const ONLY = process.env.VERIFY_ONLY ? new RegExp(process.env.VERIFY_ONLY, 'i') : null;
const step = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await fn();
  } catch (e) {
    const msg = String(e?.message ?? e).split('\n')[0].slice(0, 300);
    fail.push(`${name} threw: ${msg}`);
    console.log(`THREW ${name}: ${msg}`);
    if (lastPage) await shot(lastPage, `glow-fail-${name.replace(/[^a-z0-9]+/gi, '-')}`);
  }
};

// Fields are found by what they are configured as, never by assumption.
const fieldRows = await q(`
  select f.key, f.label, f.type::text, f.application_need, f.agreement_need, f.agreement_note_need, f.agreement_note_when,
         f.read_only, f.repeat_schema, t.key tab_key, s.key subtab_key
    from fields f join tabs t on t.id = f.tab_id left join subtabs s on s.id = f.subtab_id
   where f.archived_at is null`);
const TYPING = new Set(['text', 'long_text', 'email', 'url', 'phone', 'identifier']);
const pick = (test) => fieldRows.find((f) => !f.read_only && test(f));
const appRequired = pick((f) => f.application_need === 'required' && f.agreement_need === 'required' && f.type === 'text');
const appOptional = pick((f) => f.application_need === 'optional' && f.tab_key === appRequired?.tab_key && (f.subtab_key ?? null) === (appRequired?.subtab_key ?? null))
  ?? pick((f) => f.application_need === 'optional');
const neither = pick((f) => f.application_need === 'none' && f.agreement_need === 'none' && TYPING.has(f.type));
const agrRequired = pick((f) => f.agreement_need === 'required' && f.application_need === 'none');
const agrOptional = pick((f) => f.agreement_need === 'optional' && f.application_need === 'none');
const numberField = pick((f) => ['number', 'currency', 'percentage'].includes(f.type) && f.application_need === 'required')
  ?? pick((f) => ['number', 'currency', 'percentage'].includes(f.type) && f.agreement_need === 'required');
const addressField = pick((f) => f.type === 'address' && f.application_need !== 'none');
const splitField = pick((f) => f.type === 'percent_split' && (f.application_need !== 'none' || f.agreement_need !== 'none'));
const noteRequired = pick((f) => f.agreement_note_need === 'required');
const noteOptional = pick((f) => f.agreement_note_need === 'optional');
const ownerGroup = pick((f) => f.type === 'repeat_group' && (f.repeat_schema ?? []).some((m) => m.key === 'percentage') && f.agreement_need !== 'none')
  ?? fieldRows.find((f) => f.type === 'repeat_group' && (f.repeat_schema ?? []).some((m) => m.key === 'percentage'));
for (const [name, f] of Object.entries({ appRequired, appOptional, neither, agrRequired, agrOptional, addressField, splitField, noteRequired, noteOptional, ownerGroup })) {
  t(`seed: a field exists to test ${name}`, Boolean(f), f ? `${f.type}` : '');
}

const member = await cookiesFor(MEMBER);
const admin = await cookiesFor(ADMIN);
const SETTING = 'fields.highlights';
const permBefore = await q(`select * from permission_settings where owner_kind='user' and owner_id=$1 and key=$2`, [member.id, SETTING]);
const glowBefore = await q(`select * from user_field_glow_settings where user_id = any($1)`, [[member.id, admin.id]]);
const setSetting = async (value) => {
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1 and key=$2`, [member.id, SETTING]);
  if (value !== null) await db.query(`insert into permission_settings (owner_kind, owner_id, key, value) values ('user', $1, $2, $3)`, [member.id, SETTING, value]);
};

const modules = await q(`select id, slug from modules where kind='display' order by position`);
const contacts = modules.find((m) => m.slug === 'contacts') ?? modules[0];
const other = modules.find((m) => m.id !== contacts.id);
const tag = Math.random().toString(36).slice(2, 8);
const [probe] = await q(`insert into records (deal_name, creator_kind, creator_user_id, "values") values ($1, 'user', $2, $3::jsonb) returning id`, [`ZZ glow probe ${tag}`, admin.id, JSON.stringify({ team_members_assigned: [admin.id, member.id] })]);
await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3)`, [probe.id, contacts.id, admin.id]);
if (other) await q(`insert into record_modules (record_id, module_id, added_by) values ($1, $2, $3) on conflict do nothing`, [probe.id, other.id, admin.id]).catch(() => {});
await q(`insert into record_team_members (record_id, user_id) values ($1, $2), ($1, $3) on conflict do nothing`, [probe.id, admin.id, member.id]).catch(() => {});

const urlFor = (f, slug = contacts.slug, extra = '') =>
  `/${slug}?record=${probe.id}&tab=${f.tab_key}${f.subtab_key ? `&subtab=${f.subtab_key}` : ''}${extra}`;

const browser = await chromium.launch();
const errors = [];
let lastPage = null;
async function signIn(user) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies(user.cookies);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  return page;
}
const go = async (page, path) => {
  lastPage = page;
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.locator('[data-drawer-tabs]').waitFor({ timeout: 120000 });
};
const cell = (page, f) => page.locator(`[data-field="${f.key}"]`);
const glowOf = async (page, f) => (await cell(page, f).count()) ? cell(page, f).getAttribute('data-glow') : 'ABSENT';
const waitGlow = async (page, f, want) => {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if ((await glowOf(page, f)) === want) return true;
    await page.waitForTimeout(100);
  }
  return false;
};
async function type(page, f, text) {
  const box = cell(page, f);
  const input = box.locator('input, textarea').first();
  if (!(await input.count())) await box.locator('button').last().click();
  await input.waitFor({ timeout: 15000 });
  await input.fill(text);
  await input.blur();
}
// Only what this run set is taken back: the team field lives in `values` too, and wiping
// it would take the member off the record.
const setKeys = new Set();
const setValues = async (patch) => {
  Object.keys(patch).forEach((k) => setKeys.add(k));
  await db.query(`update records set "values" = "values" || $2::jsonb, updated_at = now() where id=$1`, [probe.id, JSON.stringify(patch)]);
};
const clearValues = async () => {
  await db.query(`update records set "values" = "values" - $2::text[], updated_at = now() where id=$1`, [probe.id, [...setKeys]]);
  setKeys.clear();
};

const app = async (status, extra = {}) => {
  await db.query(`delete from applications where record_id=$1`, [probe.id]);
  if (status === null) return;
  await db.query(
    `insert into applications (record_id, token_hash, token_sealed, token_iv, recipient, subject, expires_at, status, send_count)
     values ($1, $2, $3, $4, 'nobody@tapdash.test', 'probe', now() + interval '30 days', $5, $6)`,
    [probe.id, randomBytes(32), randomBytes(32), randomBytes(12), status, extra.sendCount ?? 1],
  );
};
const [stageKind] = await q(`select key from agreement_kinds where sets_glow_stage limit 1`);
const [otherKind] = await q(`select key from agreement_kinds where not sets_glow_stage limit 1`);
const agreement = async (status, kind = stageKind.key) => {
  await db.query(`delete from agreements where record_id=$1`, [probe.id]);
  if (status === null) return;
  await db.query(
    `insert into agreements (record_id, kind, status, expires_at, subject, message, requester_name, snapshot_sealed, snapshot_iv, signer_count, sent_by)
     values ($1, $2, $3, now() + interval '30 days', 'probe', 'probe', 'probe', $4, $5, 1, $6)`,
    [probe.id, kind, status, randomBytes(16), randomBytes(12), admin.id],
  );
};

const watchdog = setTimeout(() => { console.error('watchdog: giving up at 30 minutes'); process.exit(2); }, 30 * 60 * 1000);

try {
  const page = await signIn(member);
  const adminPage = await signIn(admin);

  await step('no application sent: orange and blue', async () => {
    await go(page, urlFor(appRequired));
    t('required application field glows light orange', (await glowOf(page, appRequired)) === 'application_required');
    t('optional application field glows light blue', (await glowOf(page, appOptional)) === 'application_optional', appOptional.key);
    await shot(page, 'glow-1-application');
  });

  await step('legend and tooltip', async () => {
    const legend = page.locator('[data-field-guide]');
    const words = await legend.innerText();
    t('Field guide shows the two active colours and what each means', /Field guide/.test(words) && /Required for application/.test(words) && /Optional for application/.test(words) && !/agreement/i.test(words));
    t('hovering says what it means in words', (await cell(page, appRequired).getAttribute('title')) === 'Required for application');
    await cell(page, appRequired).locator('span[title]').first().hover();
    t('the label says it too', /Required for application/.test((await cell(page, appRequired).locator('span[title]').first().getAttribute('title')) ?? ''));
    t('vocabulary: the legend does not say delete', !/delete/i.test(words));
  });

  await step('glow only while empty', async () => {
    const counter = () => page.locator('nav [data-tab-counter]').first().innerText();
    const before = await counter();
    await type(page, appRequired, `Probe ${tag}`);
    t('filling it removes the glow, with no reload', await waitGlow(page, appRequired, null));
    await page.waitForTimeout(300);
    t('the tab counter moves with it', (await counter()) !== before, `${before} → ${await counter()}`);
    await type(page, appRequired, '   ');
    t('only spaces counts as empty', await waitGlow(page, appRequired, 'application_required'));
    await type(page, appRequired, '');
    t('clearing it brings the glow back', await waitGlow(page, appRequired, 'application_required'));
    // A write of this run's own beside a save still in flight would lose the save.
    await page.getByText('All changes saved').first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(1500);
    const [saved] = await q(`select "values"->$2 v from records where id=$1`, [probe.id, appRequired.key]);
    t('and the cleared value is what was saved', saved.v === null || saved.v === '', JSON.stringify(saved.v));
  });

  await step('a value of 0', async () => {
    if (!numberField) return t('a value of 0 counts as filled', false, 'no required number field');
    await setValues({ [numberField.key]: 0 });
    await go(page, urlFor(numberField));
    const want = await glowOf(page, numberField);
    t('a value of 0 counts as filled', want === null, numberField.type);
    await clearValues();
  });

  await step('a field on neither form', async () => {
    await go(page, urlFor(neither));
    t('never glows', (await glowOf(page, neither)) === null, neither.type);
    t('still rendered: this proves the cell was found', (await cell(page, neither).count()) === 1);
  });

  await step('whole-row fields', async () => {
    await go(page, urlFor(addressField));
    t('Address: the glow wraps the whole row', (await glowOf(page, addressField)) !== null && (await cell(page, addressField).evaluate((el) => getComputedStyle(el).gridColumnEnd)) !== 'auto', addressField.key);
    await go(page, urlFor(splitField));
    const splitWant = splitField.application_need !== 'none' ? `application_${splitField.application_need}` : null;
    if (splitWant) t('Percentage = 100%: the glow wraps the whole row', (await glowOf(page, splitField)) === splitWant && (await cell(page, splitField).evaluate((el) => getComputedStyle(el).gridColumnEnd)) !== 'auto', splitField.key);
    await setValues({ [splitField.key]: { partly: 40 } });
    await go(page, urlFor(splitField));
    if (splitWant) t('a partly filled group keeps glowing', (await glowOf(page, splitField)) === splitWant);
    await clearValues();
  });

  await step('the application stage table', async () => {
    for (const status of ['sent', 'opened', 'submitted', 'pdf_uploaded', 'reviewed']) {
      await app(status);
      await go(page, urlFor(agrRequired));
      t(`application ${status}: red`, (await glowOf(page, agrRequired)) === 'agreement_required');
    }
    await go(page, urlFor(agrOptional));
    t('application reviewed: purple', (await glowOf(page, agrOptional)) === 'agreement_optional');
    await go(page, urlFor(appRequired));
    t('a field on both forms changes to the agreement colour', (await glowOf(page, appRequired)) === 'agreement_required');
    const legend = await page.locator('[data-field-guide]').innerText();
    t('legend follows: agreement colours only', /Required for agreement/.test(legend) && /Optional for agreement/.test(legend) && !/for application/.test(legend));
    await shot(page, 'glow-2-agreement');
    await app('sent', { sendCount: 2 });
    await go(page, urlFor(agrRequired));
    t('application resent: stays red', (await glowOf(page, agrRequired)) === 'agreement_required');
    for (const status of ['voided', 'expired']) {
      await app(status);
      await go(page, urlFor(appRequired));
      t(`application ${status}: back to orange`, (await glowOf(page, appRequired)) === 'application_required');
    }
    await app(null);
    await db.query(`insert into applications (record_id, token_hash, token_sealed, token_iv, recipient, subject, expires_at, status, created_at) values ($1, $2, $3, $4, 'nobody@tapdash.test', 'old', now(), 'sent', now() - interval '2 days'), ($1, $5, $6, $7, 'nobody@tapdash.test', 'new', now(), 'voided', now())`, [probe.id, randomBytes(32), randomBytes(32), randomBytes(12), randomBytes(32), randomBytes(32), randomBytes(12)]);
    await go(page, urlFor(appRequired));
    t('several applications: the most recent decides', (await glowOf(page, appRequired)) === 'application_required');
    await app('sent');
  });

  await step('Send Agreement stops every glow', async () => {
    await agreement('sent');
    await go(page, urlFor(agrRequired));
    t('agreement sent: no glows on the record', (await page.locator('[data-glow]').count()) === 0);
    t('agreement sent: no legend', (await page.locator('[data-field-guide]').count()) === 0);
    t('agreement sent: no tab counter', (await page.locator('[data-tab-counter]').count()) === 0);
    await agreement('voided');
    await go(page, urlFor(agrRequired));
    t('agreement voided: red and purple come back', (await glowOf(page, agrRequired)) === 'agreement_required');
    if (otherKind) {
      await agreement('sent', otherKind.key);
      await go(page, urlFor(agrRequired));
      t('the ACH agreement is not "the agreement": glows stay', (await glowOf(page, agrRequired)) === 'agreement_required');
    }
    await agreement(null);
  });

  await step('conditional fields', async () => {
    const yesKey = noteRequired.agreement_note_when?.in?.[0];
    await setValues({ [noteRequired.key]: yesKey });
    await go(page, urlFor(noteRequired));
    t('Bankruptcy Yes, no note: glows and says why', (await glowOf(page, noteRequired)) === 'agreement_required' && /add a note/.test((await cell(page, noteRequired).getAttribute('title')) ?? ''));
    await setValues({ [noteRequired.key]: 'no' });
    await go(page, urlFor(noteRequired));
    t('Bankruptcy No: no note asked for', (await glowOf(page, noteRequired)) === null);
    await clearValues();

    const noKey = noteOptional.agreement_note_when?.not_in?.[0] ?? 'no';
    await setValues({ [noteOptional.key]: noKey });
    await go(page, urlFor(noteOptional));
    t('Seasonal No: no note asked for', (await glowOf(page, noteOptional)) === null, noteOptional.type);
    await clearValues();

    await setValues({ [ownerGroup.key]: [
      { first: 'A', last: 'One', percentage: 30 },
      { first: 'B', last: 'Two', percentage: 15 },
      { first: 'C', last: 'Three', percentage: 10 },
      { first: 'D', last: 'Four', percentage: 5 },
    ] });
    await go(page, urlFor(ownerGroup));
    const rows = page.locator(`[id="field-${ownerGroup.key}"] .space-y-3 > div`);
    const glowsIn = (i) => rows.nth(i).locator('[data-glow]').count();
    const counts = [await glowsIn(0), await glowsIn(1), await glowsIn(2), await glowsIn(3)];
    t('signer detail glows for the three chosen by the rule, not the fourth', counts[0] > 0 && counts[1] > 0 && counts[2] > 0 && counts[3] === 0, counts.join(','));
    await shot(page, 'glow-3-signers');
    await clearValues();
    await app(null);
  });

  await step('only inside tabs and sub-tabs', async () => {
    await go(page, urlFor(appRequired));
    const all = await page.locator('[data-glow]').count();
    const inside = await page.locator('[data-drawer-tabs] [data-glow]').count();
    t('no glow in the header, Vital Info or list columns', all > 0 && all === inside, `${inside} of ${all}`);
  });

  await step('the same in every module', async () => {
    if (!other) return t('a second module exists', false);
    const read = async (slug) => {
      await go(page, urlFor(appRequired, slug));
      return page.locator('[data-glow]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-field')}:${e.getAttribute('data-glow')}`).sort());
    };
    const a = await read(contacts.slug);
    const b = await read(other.slug);
    const same = a.filter((x) => b.includes(x));
    t('the same field glows the same in another module', same.length > 0 && same.includes(`${appRequired.key}:application_required`), `${same.length} shared`);
  });

  await step('a glow does not move or resize the box', async () => {
    await go(page, urlFor(appRequired));
    const box = await cell(page, appRequired).boundingBox();
    await page.getByRole('button', { name: 'Hide highlights' }).click();
    await page.waitForTimeout(400);
    const plain = await cell(page, appRequired).boundingBox();
    const close = (a, b) => Math.abs(a - b) < 0.5;
    t('same size and position with and without', close(box.width, plain.width) && close(box.height, plain.height) && close(box.x, plain.x) && close(box.y, plain.y), JSON.stringify([box, plain]));
    await page.getByRole('button', { name: 'Show highlights' }).click();
    await page.waitForTimeout(400);
  });

  await step('the pre-send pulse', async () => {
    await go(page, urlFor(appRequired, contacts.slug, `&field=${appRequired.key}`));
    await page.waitForFunction((k) => document.querySelector(`[data-field="${k}"]`)?.getAttribute('data-pulse') === 'true', appRequired.key, { timeout: 15000 });
    const animating = await cell(page, appRequired).evaluate((el) => getComputedStyle(el).animationName);
    t('landing on a field pulses its glow', animating === 'glow-pulse', animating);

    // The send bar lives on Files, and asks before it opens anything.
    await page.goto(`${BASE}/${contacts.slug}?record=${probe.id}&tab=files`, { waitUntil: 'domcontentloaded', timeout: 300000 });
    await page.getByRole('region', { name: 'Send documents' }).getByRole('button', { name: /^Send$|Send application/ }).first().click();
    const link = page.getByRole('dialog').locator(`a[href*="field="]`).first();
    await link.waitFor({ timeout: 45000 });
    const href = await link.getAttribute('href');
    const key = new URL(href, BASE).searchParams.get('field');
    t('"Can\'t send yet" lists the field as a link', Boolean(key), key ?? '');
    await link.click();
    await page.waitForURL(/field=/, { timeout: 60000 });
    const landed = page.locator(`[id="field-${key}"]`);
    await landed.waitFor({ timeout: 60000 });
    await page.waitForFunction((k) => {
      const el = document.getElementById(`field-${k}`);
      return el && (el.getAttribute('data-pulse') === 'true' || el.querySelector('[data-pulse="true"]'));
    }, key, { timeout: 15000 });
    t('clicking it lands on the field and pulses its glow', true, key);
    await shot(page, 'glow-4-pulse');
  });

  await step('view only and locked fields glow too', async () => {
    const [viewOnly] = await q(`select f.key, t.key tab_key, s.key subtab_key from fields f join tabs t on t.id=f.tab_id left join subtabs s on s.id=f.subtab_id where f.archived_at is null and (f.read_only or f.type='auto') and (f.application_need <> 'none') limit 1`);
    if (!viewOnly) {
      console.log('note: no read-only field on the application list; the grid asks nothing about the grant');
      return;
    }
    await go(page, urlFor(viewOnly));
    t('a locked field glows', (await glowOf(page, viewOnly)) !== null, viewOnly.key);
  });

  await step('admin sees them too', async () => {
    await go(adminPage, urlFor(appRequired));
    t('admin: required application field glows', (await glowOf(adminPage, appRequired)) === 'application_required');
    await shot(adminPage, 'glow-5-admin');
  });

  await step('the personal switch', async () => {
    await go(page, urlFor(appRequired));
    await page.getByRole('button', { name: 'Hide highlights' }).click();
    t('hides this user\'s glows at once', await waitGlow(page, appRequired, null));
    await page.waitForTimeout(1200);
    await go(page, urlFor(appRequired));
    t('and stays hidden after a reload', (await page.locator('[data-glow]').count()) === 0 && (await page.getByRole('button', { name: 'Show highlights' }).count()) === 1);
    t('and says plainly that highlights are off for this person', (await page.getByText('Field highlights are turned off for you').count()) === 1);
    await go(adminPage, urlFor(appRequired));
    t('and never changes anyone else\'s view', (await glowOf(adminPage, appRequired)) === 'application_required');
    await page.getByRole('button', { name: 'Show highlights' }).click();
    t('can be turned back on', await waitGlow(page, appRequired, 'application_required'));
    await page.waitForTimeout(1200);
  });

  await step('the permission', async () => {
    await setSetting('no');
    await go(page, urlFor(appRequired));
    t('No: no glows', (await page.locator('[data-glow]').count()) === 0);
    t('No: no legend, so no switch to turn them on with', (await page.locator('[data-field-guide]').count()) === 0 && (await page.getByRole('button', { name: /highlights/ }).count()) === 0);
    t('No: no tooltips', (await cell(page, appRequired).getAttribute('title')) === null);
    t('No: the tab counter still counts', (await page.locator('[data-tab-counter]').count()) > 0);
    await setSetting(null);
    const [row] = await q(`select count(*)::int n from unnest(array['super_admin','admin','underwriter','accounting','customer_service','sales_agent']) u(t)`);
    t('six user types checked', row.n === 6);
    const templates = await q(`select pt.user_type, coalesce(ps.value, 'unset') v from permission_templates pt left join permission_settings ps on ps.owner_kind='template' and ps.owner_id=pt.id and ps.key=$1 where pt.user_type is not null`, [SETTING]);
    t('Yes by default for every user type', templates.length > 0 && templates.every((x) => x.v === 'yes'), templates.map((x) => `${x.user_type}:${x.v}`).join(' '));
  });

  await step('Configure → Permissions lists it', async () => {
    const fresh = await signIn(await cookiesFor(ADMIN));
    lastPage = fresh;
    const [tpl] = await q(`select id from permission_templates where user_type is not null limit 1`);
    await fresh.goto(`${BASE}/admin/templates/${tpl.id}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
    await fresh.getByText('See field highlights').first().waitFor({ timeout: 60000 });
    t('"See field highlights" is on the Permissions screen', true);
    await shot(fresh, 'glow-6-permissions');

    // The spec's first line: an admin controls required / optional / irrelevant.
    await fresh.goto(`${BASE}/admin/presets`, { waitUntil: 'load', timeout: 300000 });
    await fresh.getByRole('button', { name: /^Fields/ }).first().click();
    await fresh.getByRole('button', { name: /^Edit$/ }).first().click();
    const select = fresh.locator('select[name="applicationNeed"]').first();
    await select.waitFor({ timeout: 30000 });
    t('the field form offers Application and Agreement', (await fresh.locator('select[name="agreementNeed"]').count()) > 0);
    t('with required, optional and not on this form', (await select.locator('option').allInnerTexts()).join('|') === 'Required|Optional|Not on this form');
    await shot(fresh, 'glow-8-field-form');
  });
} catch (e) {
  fail.push(`threw: ${e.stack ?? e}`);
} finally {
  clearTimeout(watchdog);
  await browser.close().catch(() => {});
  await db.query(`delete from records where id=$1`, [probe.id]).catch((e) => fail.push(`remove probe: ${e}`));
  await db.query(`delete from permission_settings where owner_kind='user' and owner_id=$1 and key=$2`, [member.id, SETTING]).catch(() => {});
  for (const p of permBefore) {
    const cols = Object.keys(p);
    await db.query(`insert into permission_settings (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((c) => p[c])).catch((e) => fail.push(`restore setting: ${e}`));
  }
  await db.query(`delete from user_field_glow_settings where user_id = any($1)`, [[member.id, admin.id]]).catch(() => {});
  for (const g of glowBefore) await db.query(`insert into user_field_glow_settings (user_id, hidden) values ($1, $2)`, [g.user_id, g.hidden]).catch(() => {});
  for (const [id, seen] of seenBefore) await db.query(`update profiles set last_seen_at = $2 where id=$1`, [id, seen]).catch(() => {});
  const left = (await q(`select count(*)::int n from records where deal_name like 'ZZ glow probe%'`))[0].n;
  t('the probe record is gone', left === 0);
  t('no page errors / 5xx', errors.length === 0, [...new Set(errors)].join(' | ').slice(0, 600));
  await db.end();
}

console.log(`\nPASS ${pass.length}`);
console.log(`FAIL ${fail.length}`);
for (const f of fail) console.log('  ✗ ' + f);
process.exit(fail.length ? 1 : 0);
