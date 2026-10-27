/**
 * One-time backup of everything the UI/UX Redesign spec removes, for Izzy.
 *
 * The spec (§5 and Decisions): "Removed fields and tabs — permanently deleted,
 * data included. Export a backup to Izzy first." This writes that export —
 * read-only, nothing is changed — to `backups/izzy-<date>/` (gitignored: it
 * holds merchant data and never goes into the repository).
 *
 *   contact-affiliate-fields.csv  Affiliate business name / main email / main
 *                                 phone from the Contact tab's top line, with
 *                                 the Affiliates section as it stood
 *   other-tab-entries.csv         every Label / Information row of the Other tab
 *   field-mentions-on-removed.csv notifications that pointed at a removed field
 *   backup.json                   all of the above, exactly as stored
 *   README.txt                    what each file is
 *
 * Usage: node --env-file=.env scripts/export-izzy-backup.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const REMOVED_CONTACT_FIELDS = ['affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone'];

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
await db.query('begin read only');
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);

const contact = await q(
  `select r.id, r.deal_name,
          r.values->>'affiliate_business_name' as affiliate_business_name,
          r.values->>'affiliate_main_email'    as affiliate_main_email,
          r.values->>'affiliate_main_phone'    as affiliate_main_phone,
          r.values->'affiliate'                as affiliates_section,
          r.deleted_at
     from records r
    where coalesce(r.values->>'affiliate_business_name', '') <> ''
       or coalesce(r.values->>'affiliate_main_email', '') <> ''
       or coalesce(r.values->>'affiliate_main_phone', '') <> ''
    order by r.deal_name`,
);

const other = await q(
  `select e.id, e.record_id, r.deal_name, e.label, e.value, e.position,
          p.email as created_by, e.created_at, e.deleted_at
     from record_custom_entries e
     join records r on r.id = e.record_id
     left join profiles p on p.id = e.created_by
    order by r.deal_name, e.position`,
);

const mentions = await q(
  `select n.id, n.record_id, r.deal_name, n.field_key, n.note, n.created_at
     from notifications n
     left join records r on r.id = n.record_id
    where n.field_key::text = any($1)`,
  [REMOVED_CONTACT_FIELDS],
);

await db.query('rollback');
await db.end();

const csv = (rows, cols) => {
  const cell = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
};

const day = new Date().toISOString().slice(0, 10);
const dir = join('backups', `izzy-${day}`);
mkdirSync(dir, { recursive: true });

writeFileSync(join(dir, 'contact-affiliate-fields.csv'), csv(contact, ['id', 'deal_name', 'affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone', 'affiliates_section', 'deleted_at']));
writeFileSync(join(dir, 'other-tab-entries.csv'), csv(other, ['id', 'record_id', 'deal_name', 'label', 'value', 'position', 'created_by', 'created_at', 'deleted_at']));
writeFileSync(join(dir, 'field-mentions-on-removed.csv'), csv(mentions, ['id', 'record_id', 'deal_name', 'field_key', 'note', 'created_at']));
writeFileSync(join(dir, 'backup.json'), JSON.stringify({ exportedAt: new Date().toISOString(), contactAffiliateFields: contact, otherTabEntries: other, fieldMentionsOnRemovedFields: mentions }, null, 2));
writeFileSync(join(dir, 'README.txt'), [
  `TapDash CRM — backup of data removed by the UI/UX redesign (${day})`,
  '',
  `contact-affiliate-fields.csv   ${contact.length} records. The Contact tab's top-line Affiliate business name,`,
  '                               Affiliate main email and Affiliate main phone. These values were COPIED into the',
  '                               Affiliates section before the three top-line fields were removed.',
  `other-tab-entries.csv          ${other.length} rows. The Other tab (Label / Information) on each record. Deleted.`,
  `field-mentions-on-removed.csv  ${mentions.length} @mentions that pointed at one of the removed fields.`,
  'backup.json                    Everything above, exactly as stored.',
  '',
  'Instantly: the CRM held no Instantly messages (0 rows), so there is nothing to back up for it.',
  'Text and Call recordings: not deleted — they moved under Communication > Phone.',
  '',
].join('\r\n'));

console.log(`backup written to ${dir}: ${contact.length} contact rows, ${other.length} Other-tab rows, ${mentions.length} mentions`);
