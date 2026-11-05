/**
 * One-time backup of what migration 9916 removes from view: Other Costs, Merchant Direct
 * Relationships and Merchant Equipment List. Read-only: nothing is changed. The values stay
 * on the records anyway; this also keeps where each field lived, which the migration moves.
 *
 * Written to `backups/equipment-sections-<date>/` (gitignored: it holds merchant data and
 * never goes into the repository).
 *
 *   removed-values.csv   one row per record and field, for every value held
 *   grid-rows.csv        the two grids, one row per line
 *   backup.json          all of the above as stored, plus the sub-tabs, fields, grants, notes,
 *                        module order and saved field orders the migration touches
 *   README.txt           what each file is
 *
 * Usage: node --env-file=.env --env-file=.env.local scripts/export-equipment-sections-backup.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import pg from 'pg';

net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

const SUBTABS = ['vendor_to_td', 'other_vendor', 'equipment'];
const GRIDS = ['other_costs', 'merchant_direct_relationships'];

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
await db.query('begin read only');
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const subtabs = await q(`select * from subtabs where key = any($1)`, [SUBTABS]);
const ids = subtabs.map((s) => s.id);
const fields = await q(`select * from fields where subtab_id = any($1) order by subtab_id, position`, [ids]);
const keys = fields.map((f) => f.key);
const records = await q(
  `select r.id, r.deal_name, r.values from records r where r.values ?| $1 order by r.created_at`,
  [keys],
);
const related = {
  template_grants: await q(`select * from template_grants where scope_kind = 'subtab' and scope_id = any($1)`, [ids]),
  user_grants: await q(`select * from user_grants where scope_kind = 'subtab' and scope_id = any($1)`, [ids]),
  invite_grants: await q(`select * from invite_grants where scope_kind = 'subtab' and scope_id = any($1)`, [ids]),
  notes: await q(`select * from notes where scope_kind = 'tab' and scope_id in (select s.tab_id || '/' || s.id from subtabs s where s.id = any($1))`, [ids]),
  module_subtab_order: await q(`select * from module_subtab_order where subtab_id = any($1)`, [ids]),
  user_field_order: await q(`select * from user_field_order where subtab_id = any($1)`, [ids]),
};
await db.query('rollback');
await db.end();

const cell = (v) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const held = (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

const date = new Date().toISOString().slice(0, 10);
const dir = join('backups', `equipment-sections-${date}`);
mkdirSync(dir, { recursive: true });

const subtabLabel = new Map(subtabs.map((s) => [s.id, s.label]));
const valueRows = [['record_id', 'deal_name', 'section', 'field_key', 'field_label', 'value']];
for (const r of records) {
  for (const f of fields) {
    if (held(r.values[f.key])) valueRows.push([r.id, r.deal_name, subtabLabel.get(f.subtab_id), f.key, f.label, r.values[f.key]]);
  }
}
writeFileSync(join(dir, 'removed-values.csv'), `﻿${valueRows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`);

const gridLines = records.flatMap((r) =>
  GRIDS.flatMap((g) => (Array.isArray(r.values[g]) ? r.values[g] : []).map((line, i) => ({ record_id: r.id, deal_name: r.deal_name, grid: g, line: i + 1, ...line }))),
);
const gridCols = [...new Set(gridLines.flatMap((l) => Object.keys(l)))];
writeFileSync(join(dir, 'grid-rows.csv'), `﻿${[gridCols.map(cell).join(','), ...gridLines.map((l) => gridCols.map((c) => cell(l[c])).join(','))].join('\r\n')}\r\n`);

writeFileSync(join(dir, 'backup.json'), JSON.stringify({
  takenAt: new Date().toISOString(),
  subtabs,
  fields,
  related,
  values: records.map((r) => ({ id: r.id, deal_name: r.deal_name, values: Object.fromEntries(keys.filter((k) => k in r.values).map((k) => [k, r.values[k]])) })),
}, null, 2));

writeFileSync(join(dir, 'README.txt'), `Backup taken ${date}, before migration 20260819009916_old_equipment_sections_removed.

Other Costs, Merchant Direct Relationships and Merchant Equipment List were removed from view
in favour of Merchant Equipment Setup. The values were not deleted: they stay on each record.

removed-values.csv  one row per record and field, for every value held
grid-rows.csv       the Other costs and Merchant direct relationships grids, one row per line
backup.json         the same values as stored, plus the sub-tabs, fields, grants, notes, module
                    order and saved field orders the migration touched

This holds merchant data. Keep it out of the repository and out of email.
`);

console.log(`${records.length} records, ${fields.length} fields, ${gridLines.length} grid lines, ${valueRows.length - 1} values`);
console.log(`written to ${dir}`);
