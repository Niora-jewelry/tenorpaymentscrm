/**
 * Does the PostHog wiring actually do anything — and nothing at all without a key?
 *
 * Every request to a posthog.com host is ABORTED by the browser before it
 * leaves this machine, so this proves the wiring without sending one byte of
 * this database to an external service. Run it BOTH ways — "it does nothing
 * without a key" is half the requirement, and the half that is easy to break
 * by accident.
 *
 *   # off: nothing initialises, nothing is sent, no posthog host in the CSP
 *   npm run dev -- -p 3221
 *   node --env-file=.env scripts/verify-posthog.mjs http://localhost:3221
 *
 *   # on: the recorder is fetched and the api host is called
 *   NEXT_PUBLIC_POSTHOG_KEY=phc_probe_not_a_real_key npm run dev -- -p 3221
 *   node --env-file=.env scripts/verify-posthog.mjs http://localhost:3221 keyed
 *
 * Next 16 refuses a second `next dev` in the same directory, so the two runs
 * take turns on one port rather than running side by side.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const BASE = process.argv[2] || 'http://localhost:3220';
const EXPECT_ON = process.argv[3] === 'keyed';
const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PROBE_EMAIL = 'admin@tapdash.test';
if (!/@([a-z0-9-]+\.)*test$/i.test(PROBE_EMAIL)) process.exit(1);

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows } = await db.query(`select id,email from profiles where email=$1`, [PROBE_EMAIL]);
const svc = createClient(SUPA, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PASSWORD = 'ZzProbe-2026!page';
await svc.auth.admin.updateUserById(rows[0].id, { password: PASSWORD });
const anon = createClient(SUPA, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email: PROBE_EMAIL, password: PASSWORD });
const ref = new URL(SUPA).hostname.split('.')[0];
const v = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies = [];
if (v.length > 3180) for (let i = 0, n = 0; i < v.length; i += 3180, n++)
  cookies.push({ name: `sb-${ref}-auth-token.${n}`, value: v.slice(i, i + 3180), domain: 'localhost', path: '/' });
else cookies.push({ name: `sb-${ref}-auth-token`, value: v, domain: 'localhost', path: '/' });

const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addCookies(cookies);
const page = await ctx.newPage();

/* Nothing reaches PostHog. Every attempt is recorded and refused. */
const attempted = [];
await page.route('**://*.posthog.com/**', (route) => {
  attempted.push(route.request().url());
  route.abort();
});

/*
 * ⚠ WHY `/decide` IS ANSWERED LOCALLY RATHER THAN BLOCKED.
 *
 * The session recorder is not in the bundle. posthog-js asks `/decide`
 * whether recording is on for this project and only then fetches
 * `recorder.js` from the assets host — so blocking `/decide` means the
 * recorder is never requested, and the one thing this script exists to prove
 * (that the ASSETS host is reachable under our CSP) can never happen.
 *
 * This hands back the smallest reply that turns recording on. It is a canned
 * local response: the real PostHog is still never contacted, and the
 * recorder fetch it provokes is aborted by the rule above like everything
 * else. Registered after that rule because Playwright tries the most
 * recently added route first.
 */
await page.route('**://*.posthog.com/decide/**', (route) => {
  attempted.push(route.request().url());
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      config: { enable_collect_everything: true },
      featureFlags: {},
      supportedCompression: ['gzip-js'],
      sessionRecording: { endpoint: '/s/' },
      captureNetworkTelemetry: false,
    }),
  });
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });

const res = await page.goto(`${BASE}/leads`, { waitUntil: 'domcontentloaded' });
const csp = res.headers()['content-security-policy-report-only'] || res.headers()['content-security-policy'] || '';
await page.waitForTimeout(4000);
// A client navigation, to exercise PostHogPageviews.
await page.goto(`${BASE}/deals`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

/*
 * `window.posthog.__loaded` is NOT the probe to use. The npm module is a
 * module-scoped singleton; whether it is also hung on `window` is an
 * implementation detail of posthog-js, and it reads false here even when init
 * has plainly run. What init actually DOES is the evidence: it fetches the
 * recorder from the assets host and posts to the API host.
 */
const paths = [...new Set(attempted.map((u) => new URL(u).host + new URL(u).pathname))];
for (const p of paths) console.log('   attempted: ' + p);
const askedForRecorder = attempted.some((u) => /assets\.i\.posthog\.com\/static\//.test(u));
const askedTheApi = attempted.some((u) => /\/\/us\.i\.posthog\.com\//.test(u));
const rows2 = await page.locator('table tbody tr').count();

const pass = [];
const fail = [];
const t = (name, ok, detail) => (ok ? pass : fail).push(`${name}${detail ? '  — ' + detail : ''}`);

t('the app still renders rows behind the provider', rows2 > 0, `${rows2} rows`);
t('no page errors and no 500s', errors.length === 0, errors.slice(0, 3).join(' | '));

if (EXPECT_ON) {
  t('posthog initialised — it fetched the session recorder', askedForRecorder);
  t('and talked to the api host', askedTheApi);
  t('it tried to reach PostHog (and was blocked here)', attempted.length > 0, `${attempted.length} request(s): ${[...new Set(attempted.map((u) => new URL(u).host))].join(', ')}`);
  t('CSP names the api host', /\/\/us\.i\.posthog\.com/.test(csp));
  t('CSP names the assets host', /\/\/us-assets\.i\.posthog\.com/.test(csp));
} else {
  t('posthog did NOT initialise — no recorder, no api call', attempted.length === 0);
  t('nothing was sent anywhere near PostHog', attempted.length === 0, attempted.join(', '));
  t('CSP does not mention posthog', !/posthog/.test(csp));
}

for (const p of pass) console.log(' PASS  ' + p);
for (const f of fail) console.log('*FAIL  ' + f);
console.log(`\n=== ${pass.length}/${pass.length + fail.length} passed (${EXPECT_ON ? 'key present' : 'no key'}) ===`);
await browser.close();
await db.end();
process.exit(fail.length ? 1 : 0);
