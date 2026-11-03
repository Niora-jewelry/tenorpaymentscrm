/**
 * One-time backup of everything the Field-Tab Review (client sheet, 3 Nov 2026)
 * removes or moves, taken before migration 9895. Read-only: nothing is changed.
 * Written to `backups/restructure-2026-11-03/` (gitignored: it holds merchant
 * data and never goes into the repository).
 *
 *   removed-values.csv   every record's value in each field the sheet removes
 *                        (Marketing, One Time Charges, Other Vendor Merchant
 *                        Payments, the old vendor costs), one row per record
 *   one-time-charges.csv the One Time Charges grid, one row per line
 *   backup.json          all of the above exactly as stored, plus the tabs,
 *                        sub-tabs, fields, grants, notes and saved field orders
 *                        the migration touches
 *   README.txt           what each file is
 *
 * Usage: node --env-file=.env scripts/export-restructure-backup.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import pg from 'pg';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

export const REMOVED = [
  'campaign', 'pitch', 'ad_campaign', 'date_lead_generated',
  'otc_mav_gateway_setup', 'otc_mav_equipment', 'one_time_charges',
  'ovmp_processor_provider', 'ovmp_monthly_pci_fee', 'ovmp_irs_annual_fee',
  'ovmp_gateway_provider', 'ovmp_gateway_monthly_fee', 'ovmp_gateway_auth_fee', 'ovmp_gateway_per_update',
  'ovmp_terminal_provider', 'ovmp_terminal_monthly_fee', 'ovmp_terminal_transaction_fee',
  'ovmp_internet_service_provider', 'ovmp_internet_monthly_cost',
  'ovmp_pos_provider', 'ovmp_pos_monthly_fee', 'ovmp_pos_auth_fee',
  'vtd_rewards_provider', 'vtd_rewards_volume_cost', 'vtd_other_provider', 'vtd_other_monthly_fee',
  'vtd_merchynt_monthly', 'vtd_tuzo_monthly', 'vtd_tuzo_volume', 'vtd_pos_plus_monthly', 'vtd_pos_volume',
  'vtd_support_agent', 'vtd_tapdash_direct',
];
const TABS = ['contact', 'overview', 'pricing', 'marketing', 'equipment', 'agreements', 'files', 'application'];

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
await db.query('begin read only');
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const fields = await q(`select f.*, t.key as tab_key, s.key as subtab_key from fields f join tabs t on t.id = f.tab_id left join subtabs s on s.id = f.subtab_id
                         where t.key = any($1) order by t.key, f.position`, [TABS]);
const labelOf = new Map(fields.map((f) => [f.key, f.label]));
const records = await q(`select id, deal_name, deleted_at, values from records order by deal_name`);
const removed = records
  .map((r) => ({ id: r.id, deal_name: r.deal_name, deleted_at: r.deleted_at, values: Object.fromEntries(REMOVED.filter((k) => k in (r.values ?? {})).map((k) => [k, r.values[k]])) }))
  .filter((r) => Object.keys(r.values).length);

const tabs = await q(`select * from tabs where key = any($1)`, [TABS]);
const tabIds = tabs.map((t) => t.id);
const subtabs = await q(`select * from subtabs where tab_id = any($1)`, [tabIds]);
const scopeIds = [...tabIds, ...subtabs.map((s) => s.id), ...fields.map((f) => f.id)].map(String);
const grants = {
  template: await q(`select * from template_grants where scope_id::text = any($1)`, [scopeIds]),
  user: await q(`select * from user_grants where scope_id::text = any($1)`, [scopeIds]),
  invite: await q(`select * from invite_grants where scope_id::text = any($1)`, [scopeIds]),
};
const notes = await q(`select * from notes where (scope_kind = 'tab' and split_part(scope_id, '/', 1) = any($1)) or (scope_kind = 'field' and scope_id = any($2))`,
  [tabIds.map(String), REMOVED]);
const fieldOrder = await q(`select * from user_field_order where tab_id = any($1)`, [tabIds]);
const moduleTabOrder = await q(`select * from module_tab_order where tab_id = any($1)`, [tabIds]);
const moduleSubtabOrder = await q(`select * from module_subtab_order where subtab_id = any($1)`, [subtabs.map((s) => s.id)]);
const columns = await q(`select mc.* from module_columns mc join fields f on f.id = mc.field_id where f.key = any($1)`, [REMOVED]);
const headerFields = await q(`select mh.* from module_header_fields mh join fields f on f.id = mh.field_id where f.key = any($1)`, [REMOVED]);
const choices = await q(`select c.* from field_choices c join fields f on f.id = c.field_id where f.key = any($1)`, [REMOVED]);
await db.query('rollback');
await db.end();

const date = '2026-11-03';
const dir = join('backups', `restructure-${date}`);
mkdirSync(dir, { recursive: true });

const cell = (v) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const used = REMOVED.filter((k) => removed.some((r) => k in r.values));
const csv = [
  ['Record', 'In Recycle Bin', ...used.map((k) => labelOf.get(k) ?? k)].map(cell).join(','),
  ...removed.map((r) => [r.deal_name, r.deleted_at ? 'yes' : '', ...used.map((k) => r.values[k])].map(cell).join(',')),
].join('\n');
writeFileSync(join(dir, 'removed-values.csv'), '﻿' + csv);

const grid = removed.flatMap((r) => (Array.isArray(r.values.one_time_charges) ? r.values.one_time_charges : []).map((line) => ({ deal_name: r.deal_name, ...line })));
const gridCols = [...new Set(grid.flatMap((l) => Object.keys(l)))];
writeFileSync(join(dir, 'one-time-charges.csv'), '﻿' + [gridCols.map(cell).join(','), ...grid.map((l) => gridCols.map((c) => cell(l[c])).join(','))].join('\n'));

writeFileSync(join(dir, 'backup.json'), JSON.stringify({
  exportedAt: new Date().toISOString(), removedKeys: REMOVED, removed, tabs, subtabs, fields, grants, notes, fieldOrder,
  moduleTabOrder, moduleSubtabOrder, columns, headerFields, choices,
}, null, 1));

writeFileSync(join(dir, 'README.txt'), `Backup taken ${date}, before the Field-Tab Review restructure (migration 20260819009895).

removed-values.csv   ${removed.length} records. Every value in a field the review removes: the Marketing tab,
                     One Time Charges, Other Vendor Merchant Payments, and the vendor costs dropped from
                     Other Costs. Other Vendor Merchant Payments and the Rewards / Other vendor costs were
                     also COPIED into the new Merchant Direct Relationships and Other Costs rows first.
one-time-charges.csv ${grid.length} lines of the One Time Charges grid.
backup.json          All of the above exactly as stored, plus the configuration the migration changes
                     (tabs, sub-tabs, fields, grants, notes, saved field orders, list columns, Vital Info).
`);

console.log(`records with removed values: ${removed.length}; grid lines: ${grid.length}; notes: ${notes.length}; grants: ${grants.template.length + grants.user.length + grants.invite.length}`);
console.log(`written to ${dir}`);
