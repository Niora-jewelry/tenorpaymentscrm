/**
 * Seeds a handful of realistic Leads records into the real database, so the
 * dashboard has something to look at without waiting for real merchants.
 * Uses the actual data-layer functions (set_record_memberships), not a raw
 * bypass, so memberships/team-member sync trigger fire exactly as they
 * would for a record created through the app.
 *
 * Safe to re-run: skips any deal name that already exists (the same unique
 * index the app itself relies on).
 *
 * Usage:
 *   SUPABASE_DB_URL="postgresql://..." node scripts/seed-demo-records.mjs
 */
import pg from 'pg';

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error('Set SUPABASE_DB_URL first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows: admins } = await client.query(
  `select p.id from profiles p join roles r on r.id = p.role_id where r.slug = 'super_admin' limit 1`,
);
if (!admins.length) {
  console.error('No super_admin profile found — sign up the first admin before seeding.');
  process.exit(1);
}
const creatorId = admins[0].id;

const { rows: mods } = await client.query(`select id, slug from modules`);
const moduleId = (slug) => mods.find((m) => m.slug === slug).id;

const RECORDS = [
  {
    dealName: "Joe's Pizza",
    values: {
      legal_business_name: "Joe's Pizza LLC",
      mid: '482910573',
      current_status: 'working',
      merchant_industry: 'Restaurant',
      monthly_acq_volume: 12450000,
      campaign: 'q3_restaurant_push',
      pitch: 'cash_discount',
      prior_processor: 'Square',
      date_lead_generated: '2026-06-12',
      last_outreach: '2026-08-18',
      last_merchant_response: '2026-08-19',
    },
  },
  {
    dealName: 'Bella Cafe',
    values: {
      legal_business_name: 'Bella Cafe Inc',
      mid: '392847561',
      current_status: 'qualified',
      merchant_industry: 'Coffee shop',
      monthly_acq_volume: 8820000,
      campaign: 'ecom_outbound',
      pitch: 'next_day_funding',
      prior_processor: 'Clover',
      date_lead_generated: '2026-07-02',
      last_outreach: '2026-08-15',
    },
  },
  {
    dealName: 'Metro Mart',
    values: {
      legal_business_name: 'Metro Mart Holdings',
      mid: '110284736',
      current_status: 'proposal_sent',
      merchant_industry: 'Grocery',
      monthly_acq_volume: 24010000,
      campaign: 'referral_partner_drive',
      pitch: 'rate_savings',
      prior_processor: 'Worldpay',
      date_lead_generated: '2026-05-28',
      last_outreach: '2026-08-19',
      last_merchant_response: '2026-08-13',
    },
  },
  {
    dealName: 'Summit Auto Repair',
    values: {
      legal_business_name: 'Summit Auto Repair Co',
      mid: '758392014',
      current_status: 'new_lead',
      merchant_industry: 'Automotive',
      monthly_acq_volume: 5340000,
      campaign: 'pos_upgrade',
      pitch: 'pos_upgrade',
      prior_processor: 'None',
      date_lead_generated: '2026-08-10',
    },
  },
  {
    dealName: 'Peak Fitness Club',
    values: {
      legal_business_name: 'Peak Fitness Club LLC',
      mid: '634710298',
      current_status: 'closed',
      merchant_industry: 'Fitness',
      monthly_acq_volume: 18760000,
      campaign: 'renewal_winback',
      pitch: 'rate_savings',
      prior_processor: 'Stripe',
      date_lead_generated: '2026-04-15',
      last_outreach: '2026-07-30',
      last_merchant_response: '2026-08-01',
    },
  },
];

let created = 0;
for (const rec of RECORDS) {
  const { rows: existing } = await client.query(
    `select id from records where lower(btrim(deal_name)) = lower(btrim($1)) and deleted_at is null`,
    [rec.dealName],
  );
  if (existing.length) {
    console.log(`  skip "${rec.dealName}" — already exists`);
    continue;
  }

  const { rows } = await client.query(
    `insert into records (deal_name, values, creator_kind, creator_user_id) values ($1, $2, 'user', $3) returning id`,
    [rec.dealName, JSON.stringify(rec.values), creatorId],
  );
  const recordId = rows[0].id;

  // Direct insert, not the set_record_memberships() RPC: that function gates
  // on record_visible(), which resolves auth.uid() — null on this plain
  // service connection, so it would refuse. Fine for seed data; the app's
  // own create-record path still goes through the real RPC.
  await client.query(
    `insert into record_modules (record_id, module_id) values ($1, $2) on conflict do nothing`,
    [recordId, moduleId('leads')],
  );

  console.log(`  created "${rec.dealName}" (${recordId})`);
  created += 1;
}

console.log(`\n${created} record(s) created, ${RECORDS.length - created} skipped (already present).`);
await client.end();
