/**
 * Normalise every stored phone number to E.164.
 *
 * ── WHY THIS HAS TO EXIST ────────────────────────────────────────────────
 * `resolve_record_by_phone()` compares strings. Twilio always sends
 * `+19733704989`; the seeded data holds `(222) 597-1406`. Until those agree,
 * every inbound call and text attaches to no record — and it fails SILENTLY,
 * looking exactly like "that number isn't in the CRM" rather than like a bug.
 *
 * Donny hit this in the old CRM. His notes say the enrichment paths were fixed
 * to normalise on write and that a backfill was never needed there only because
 * that database held nothing but freshly-created leads. This one holds seeded
 * demo data the client is testing against, so the write-path fix alone is not
 * enough.
 *
 * ── WHAT IT TOUCHES ──────────────────────────────────────────────────────
 * Both shapes the resolver understands, and ONLY phone-typed fields:
 *   • top-level fields with `type = 'phone'`
 *   • phone sub-fields inside repeat groups (contact, owner, affiliate …)
 *
 * It rewrites nothing else in `values`, and a value already in E.164 is left
 * exactly as it is, so the script is safe to run twice. A value it cannot parse
 * is REPORTED AND LEFT ALONE — mangling a number nobody can recover is worse
 * than leaving one that does not match.
 *
 * ── DISPLAY ──────────────────────────────────────────────────────────────
 * Storing E.164 does not mean showing it. `formatPhoneDisplay()` in
 * `src/lib/phone/normalize.ts` renders `+12225971406` back as
 * `(222) 597-1406`, so the screens look the same as before.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-phone-e164.mjs          # report only
 *   node --env-file=.env scripts/backfill-phone-e164.mjs --apply  # write
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

/** Mirrors `normalizePhone` in src/lib/phone/normalize.ts. Kept in step by hand
 *  because a script must not import server-only application code. */
function toE164(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const { rows: topLevel } = await client.query(
  `select key from fields where type = 'phone' and repeat_group_key is null and archived_at is null`,
);
const { rows: groups } = await client.query(
  `select repeat_group_key, repeat_schema
     from fields
    where type = 'repeat_group' and repeat_group_key is not null and archived_at is null`,
);

// group key -> the phone sub-keys inside it
const groupPhoneKeys = new Map();
for (const g of groups) {
  const schema = Array.isArray(g.repeat_schema) ? g.repeat_schema : [];
  const keys = schema.filter((s) => s?.type === 'phone').map((s) => s.key);
  if (keys.length) groupPhoneKeys.set(g.repeat_group_key, keys);
}

console.log('Phone fields considered:');
console.log('  top-level:', topLevel.map((f) => f.key).join(', ') || '(none)');
for (const [g, keys] of groupPhoneKeys) console.log(`  ${g}[]:`, keys.join(', '));

const { rows: records } = await client.query(
  `select id, deal_name, values from records where deleted_at is null`,
);

let changedRecords = 0;
let changedValues = 0;
const unparseable = [];

for (const record of records) {
  const values = record.values ?? {};
  let dirty = false;

  for (const field of topLevel) {
    const current = values[field.key];
    if (typeof current !== 'string' || !current.trim()) continue;
    const normalized = toE164(current);
    if (!normalized) {
      unparseable.push({ record: record.deal_name, path: field.key, value: current });
      continue;
    }
    if (normalized !== current) {
      values[field.key] = normalized;
      dirty = true;
      changedValues += 1;
    }
  }

  for (const [groupKey, subKeys] of groupPhoneKeys) {
    const instances = values[groupKey];
    if (!Array.isArray(instances)) continue;
    for (const instance of instances) {
      if (!instance || typeof instance !== 'object') continue;
      for (const subKey of subKeys) {
        const current = instance[subKey];
        if (typeof current !== 'string' || !current.trim()) continue;
        const normalized = toE164(current);
        if (!normalized) {
          unparseable.push({ record: record.deal_name, path: `${groupKey}[].${subKey}`, value: current });
          continue;
        }
        if (normalized !== current) {
          instance[subKey] = normalized;
          dirty = true;
          changedValues += 1;
        }
      }
    }
  }

  if (dirty) {
    changedRecords += 1;
    if (APPLY) {
      // `values` only — never touches updated_at, so this backfill cannot
      // invalidate a compare-and-swap token somebody is holding mid-edit.
      await client.query(`update records set values = $2 where id = $1`, [record.id, values]);
    }
  }
}

console.log();
console.log(`${changedValues} value(s) across ${changedRecords} record(s) ${APPLY ? 'REWRITTEN' : 'would change'}.`);

if (unparseable.length) {
  console.log(`\n⚠ ${unparseable.length} value(s) could not be parsed and were LEFT UNCHANGED:`);
  for (const u of unparseable.slice(0, 20)) {
    console.log(`   ${u.record} · ${u.path} = ${JSON.stringify(u.value)}`);
  }
  if (unparseable.length > 20) console.log(`   … and ${unparseable.length - 20} more`);
}

if (!APPLY) console.log('\nDry run. Re-run with --apply to write.');

await client.end();
