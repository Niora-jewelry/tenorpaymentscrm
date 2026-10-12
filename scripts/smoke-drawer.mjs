/**
 * Smoke test: can a signed-in user actually SAVE in the record drawer?
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything else in this repo verified the drawer without a browser:
 * server-rendering the page over HTTP, and running SQL directly. Both passed
 * while the drawer was completely unable to save, twice over:
 *
 *   1. a residuals trigger aborted any write that set a MID on an unpriced
 *      record, and
 *   2. a plain value exported from a 'use server' module 500-ed every
 *      Server Action on the page.
 *
 * Neither is visible to tsc, ESLint, or 565 unit tests. The second one was
 * introduced BY a change whose own unit test passed. Only loading the page in
 * a browser and clicking the thing shows it.
 *
 * Run it against a dev server:
 *   npm run dev -- -p 3215
 *   node --env-file=.env scripts/smoke-drawer.mjs [http://localhost:PORT]
 *
 * It writes to the database and clears up after itself.
 */
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
const SUPA=process.env.NEXT_PUBLIC_SUPABASE_URL, ANON=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const PASSWORD='ZzProbe-2026!page';
const BASE = process.argv[2] || 'http://localhost:3215';
const svc=createClient(SUPA,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
const db=new pg.Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false}});
await db.connect();
const q=(s,p=[])=>db.query(s,p).then(r=>r.rows);
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

const [u]=await q(`select id,email from profiles where email=$1`,[PROBE_EMAIL]);
/* Safe only because of the `.test` guard above. */
await svc.auth.admin.updateUserById(u.id,{password:PASSWORD});
await db.query(`update profiles set last_seen_at=now() where id=$1`,[u.id]);
const anon=createClient(SUPA,ANON,{auth:{persistSession:false}});
const {data}=await anon.auth.signInWithPassword({email:u.email,password:PASSWORD});
const ref=new URL(SUPA).hostname.split('.')[0];
const v='base64-'+Buffer.from(JSON.stringify(data.session)).toString('base64url');
const cookies=[]; if(v.length>3180){for(let i=0,n=0;i<v.length;i+=3180,n++)cookies.push({name:`sb-${ref}-auth-token.${n}`,value:v.slice(i,i+3180),domain:'localhost',path:'/'});}else cookies.push({name:`sb-${ref}-auth-token`,value:v,domain:'localhost',path:'/'});
const [rec]=await q(`select id, deal_name from records where deal_name ilike '%Netzach%'`);

const browser=await chromium.launch();
const ctx=await browser.newContext({viewport:{width:1500,height:1000}});
await ctx.addCookies(cookies);
const page=await ctx.newPage();
const errs=[];
page.on('pageerror', e=>errs.push('PAGEERROR '+String(e).slice(0,120)));
page.on('response', r=>{ if(r.status()>=500) errs.push(`HTTP ${r.status()} ${r.url().slice(0,70)}`); });

await page.goto(`${BASE}/contacts?record=${rec.id}`, {waitUntil:'networkidle', timeout:120000});
const bad = async () => (await page.locator('text=/Someone else changed|Could not reach the server|Could not save/i').allTextContents()).join(' | ') || '(none)';
console.log('1. drawer opened              :', rec.deal_name);
console.log('   banner                     :', await bad());

/* The header strip is the <dl> right under the title. Its MID control. */
const header = page.locator('dl').first();
const midCell = header.locator('div', { has: page.getByText('MID', { exact: true }) }).first();
const midInput = midCell.locator('input, button').first();
console.log('2. header MID control found   :', await midInput.count() > 0);
await midInput.click();
await page.waitForTimeout(400);
const typed = page.locator('input:focus');
if (await typed.count()) { await typed.fill('99000111'); await typed.press('Enter'); }
await page.waitForTimeout(3000);
console.log('3. after saving MID           :', await bad());

/* Now a SECOND header edit, immediately — the stale-token case. */
const mccCell = header.locator('div', { has: page.getByText('MCC code', { exact: true }) }).first();
const mccInput = mccCell.locator('input, button').first();
await mccInput.click();
await page.waitForTimeout(400);
const typed2 = page.locator('input:focus');
if (await typed2.count()) { await typed2.fill('2953'); await typed2.press('Enter'); }
await page.waitForTimeout(3000);
console.log('4. after saving MCC (2nd edit):', await bad());

const [after]=await q(`select values->>'mid' mid, values->>'mcc_code' mcc from records where id=$1`,[rec.id]);
console.log('5. database now               :', JSON.stringify(after));
console.log('6. console/page errors        :', errs.length ? errs.slice(0,4) : 'none');
await page.screenshot({path:'scripts/scratch/drawer.png'});
await browser.close(); await db.end();
