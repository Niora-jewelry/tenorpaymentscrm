// Backs up one field's value on every record (plus the field's current
// choices) before a migration converts it. Run before any data conversion:
//
//   node --env-file=.env scripts/export-field-backup.mjs <field_key> <out.json>
//
// The file goes under backups/ (gitignored); send it to the client with the
// change note. Values only — no other record data.
import pg from 'pg';
import { writeFile } from 'node:fs/promises';

const [, , key, out] = process.argv;
if (!key || !out) {
  console.error('usage: node --env-file=.env scripts/export-field-backup.mjs <field_key> <out.json>');
  process.exit(1);
}
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows: field } = await db.query(`select id, key, label, type, notes_enabled from fields where key = $1`, [key]);
if (!field.length) throw new Error(`field ${key} not found`);
const { rows: choices } = await db.query(`select module_id, key, value, position from field_choices where field_id = $1 order by module_id nulls first, position`, [field[0].id]);
const { rows: records } = await db.query(
  `select r.id as record_id, r.deal_name, r.values -> $1 as value, r.deleted_at is not null as in_recycle_bin
     from records r where r.values ? $1 order by r.created_at`,
  [key],
);
await writeFile(out, JSON.stringify({ taken_at: new Date().toISOString(), field: field[0], choices, records }, null, 2));
console.log(`backed up ${key}: ${records.length} records, ${choices.length} choices → ${out}`);
await db.end();
