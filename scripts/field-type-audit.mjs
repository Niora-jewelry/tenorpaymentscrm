/**
 * UI/UX Redesign spec §4, "Developer task: field-type audit" — every field on
 * every tab with its tab, name, current type and target type from the spec's
 * list of 17, flagging every field that does not fit. Read-only.
 *
 * Usage: node --env-file=.env scripts/field-type-audit.mjs > docs/FIELD-TYPE-AUDIT.md
 */
import pg from 'pg';

/* Stored type → the spec's name for it. */
const TARGET = {
  text: 'Text', long_text: 'Long text', percentage: 'Percentage', currency: 'Currency',
  dropdown: 'Dropdown', multi_select: 'Multiple picker', percent_split: 'Percentage = 100%',
  email: 'Email', phone: 'Phone', address: 'Address', team_member: 'Team picker', date: 'Date',
  number: 'Number', url: 'Website', status: 'Status', file: 'Files', auto: 'Auto-populated (locked)',
};
/* Stored types that are a spec type under another name — fit, with a note. */
const NOTED = {
  identifier: ['Text', 'Text restricted to digits, so leading zeros survive (spec: MCC/MID "should be Text restricted to digits, not Number").'],
  months: ['Multiple picker', 'A Multiple picker whose options are the twelve months plus "No" (the spec\'s own example, Seasonal).'],
};
/* Outside the 17 — reported, not converted, and why. */
const OUTSIDE = {
  repeat_group: 'Not a field: a repeating section (Contacts, Affiliates, Owners) of ordinary fields, each of which is one of the 17.',
  grid: 'A table with its own typed columns (One Time Charges). Kept: no type in the 17 holds rows.',
  checkbox: 'Converted to Dropdown (Yes / No) by migration 9804.',
  datetime: 'Unused. Not offered for new fields.',
};

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
await db.query('begin read only');
const rows = (await db.query(`
  select t.label as tab, t.position as tpos, coalesce(s.label, '') as subtab, coalesce(s.position, 0) as spos,
         f.label, f.key, f.type::text as type, f.read_only, f.is_system, f.notes_enabled, f.auto_source,
         f.repeat_schema, f.position
    from fields f
    join tabs t on t.id = f.tab_id
    left join subtabs s on s.id = f.subtab_id
   where f.archived_at is null
   order by t.position, spos, f.position`)).rows;
await db.query('rollback');
await db.end();

const out = [];
const flags = [];
out.push('# Field-type audit', '');
out.push(`Generated ${new Date().toISOString().slice(0, 10)} from the live configuration by \`scripts/field-type-audit.mjs\`.`, '');
out.push('UI/UX Redesign spec §4: every data field must be one of 17 types. Notes fields and the Updates, Cases, Files, Logins and Statements tabs are excluded.', '');
out.push('| Tab | Sub-tab | Field | Current type | Target type | Fits |', '|---|---|---|---|---|---|');
for (const r of rows) {
  let target; let fits;
  if (TARGET[r.type]) { target = TARGET[r.type]; fits = 'Yes'; }
  else if (NOTED[r.type]) { target = NOTED[r.type][0]; fits = 'Yes (renamed)'; flags.push([r, NOTED[r.type][1]]); }
  else { target = '—'; fits = '**No**'; flags.push([r, OUTSIDE[r.type] ?? 'Unknown type.']); }
  const extra = [r.auto_source ? `source: ${r.auto_source}` : '', r.notes_enabled ? 'has notes' : ''].filter(Boolean).join(', ');
  out.push(`| ${r.tab} | ${r.subtab} | ${r.label}${extra ? ` (${extra})` : ''} | ${r.type} | ${target} | ${fits} |`);
  if (r.type === 'repeat_group' && Array.isArray(r.repeat_schema)) {
    for (const m of r.repeat_schema) {
      const t = TARGET[m.type] ?? NOTED[m.type]?.[0] ?? '—';
      out.push(`| ${r.tab} | ${r.subtab} | ↳ ${r.label} → ${m.label} | ${m.type} | ${t} | ${TARGET[m.type] || NOTED[m.type] ? 'Yes' : '**No**'} |`);
    }
  }
}
out.push('', '## Flagged', '');
for (const [r, why] of flags) out.push(`- **${r.label}** (${r.tab}${r.subtab ? ' → ' + r.subtab : ''}, \`${r.type}\`): ${why}`);
out.push('', '## Inconsistencies the spec listed, and what was done', '');
out.push('- **Two dropdown styles** — fixed: every Dropdown is the same select control, empty or filled; Status alone is a coloured pill.');
out.push('- **Two date styles** — fixed: one display format ("13 Jun 2025"), the picker opens on click and saves on pick.');
out.push('- **IDs with leading zeros** — MID and MCC code are Text restricted to digits (`identifier`), never Number.');
out.push('- **Field-level notes icon** — kept; "Allow notes" is an admin setting per field.');
out.push('- **System / read-only fields** — Record creator is Auto-populated (locked) and now actually shows who created the record (it was blank on every record).');
out.push('- **Truncated labels** — fixed: labels wrap to a second line; box height stays fixed.');
console.log(out.join('\n'));
