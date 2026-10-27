/**
 * Fills the database with realistic demo content, so a client opening the CRM
 * sees a working system rather than empty tabs.
 *
 * ── WHAT IT TOUCHES ──────────────────────────────────────────────────────
 * Every field on every record, plus every tab that has content of its own:
 * notes, updates and replies, cases with managers/replies/attachments, logins,
 * files, statements, communication messages, custom entries, pipeline
 * assignments, and a pair of realistic permission templates.
 *
 * ── SAFE TO RE-RUN ───────────────────────────────────────────────────────
 * Every insert is guarded by an existence check or an ON CONFLICT, and field
 * values are generated deterministically from the record's own name — so a
 * second run produces the same content and changes nothing. It never deletes.
 *
 * ── WHY IT WRITES `values` DIRECTLY ──────────────────────────────────────
 * `set_record_values` takes a compare-and-swap token and resolves the actor
 * through `auth.uid()`, which is NULL for the service role. A seeder has no
 * session and no contended write to protect against, so it writes the column
 * and lets the same triggers fire — `record_team_members` and the pipeline
 * status projection both maintain themselves from the JSONB exactly as they do
 * for a real edit.
 *
 * Usage:
 *   node --env-file=.env scripts/seed-demo-data.mjs
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error('Set SUPABASE_DB_URL first (node --env-file=.env scripts/seed-demo-data.mjs).');
  process.exit(1);
}

const c = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await c.connect();

const storage =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

const log = (...a) => console.log('  ', ...a);
const step = (s) => console.log(`\n${s}`);

/* -------------------------------------------------------------------------- */
/* Deterministic pseudo-randomness                                            */
/*                                                                            */
/* Seeded from a string so every run produces identical content. A seeder that */
/* produces different data each time makes "is this a bug or just new data?"   */
/* unanswerable when someone reports something odd on the demo.                */
/* -------------------------------------------------------------------------- */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
const rng = (seed) => {
  let s = hash(seed) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
};
const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const money = (r, lo, hi, dp = 2) => Number((lo + r() * (hi - lo)).toFixed(dp));
const digits = (r, n) => Array.from({ length: n }, () => int(r, 0, 9)).join('');
const dateBetween = (r, startYear, endYear) => {
  const y = int(r, startYear, endYear);
  const m = int(r, 1, 12);
  const d = int(r, 1, 28);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STATES = ['NY', 'CA', 'TX', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'NJ'];
const CITIES = ['Brooklyn', 'Austin', 'Sacramento', 'Miami', 'Naperville', 'Pittsburgh', 'Columbus', 'Savannah', 'Durham', 'Newark'];
const STREETS = ['Market St', 'Lincoln Ave', 'Grand Blvd', 'Willow Rd', 'Harbor Way', 'Cedar Lane', 'Union St', 'Franklin Ave'];
const FIRST = ['Maria', 'James', 'Aisha', 'Daniel', 'Priya', 'Marcus', 'Elena', 'Tomas', 'Grace', 'Omar'];
const LAST = ['Alvarez', 'Whitfield', 'Rahman', 'Okafor', 'Castellanos', 'Nguyen', 'Brennan', 'Silva', 'Kowalski', 'Duarte'];
const INDUSTRIES = ['Restaurant', 'Retail grocery', 'Auto repair', 'Salon and spa', 'E-commerce', 'Professional services', 'Convenience store', 'Home services'];
/** The five locked Application rows, matching `files.ts`'s own list. */
const APPLICATION_ROWS = ['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'];

const PROVIDERS = ['First Data', 'TSYS', 'Elavon', 'Worldpay', 'Clover', 'Square', 'Authorize.net', 'NMI', 'Dejavoo', 'PAX'];

/* -------------------------------------------------------------------------- */
/* Value generation, by field type                                            */
/* -------------------------------------------------------------------------- */
function valueForField(field, seedBase, ctx) {
  const r = rng(`${seedBase}:${field.key}`);
  const k = field.key;

  switch (field.type) {
    case 'text': {
      if (k === 'deal_name' || k === 'legal_business_name') return ctx.name;
      if (k === 'dba') return ctx.name.replace(/,? (LLC|Inc|Corp)\.?$/i, '');
      if (k === 'merchant_industry') return pick(r, INDUSTRIES);
      if (k === 'affiliate_business_name') return `${pick(r, LAST)} Partners LLC`;
      if (k === 'advertising_method') return pick(r, ['Cold outreach', 'Referral partner', 'Trade show', 'Inbound web form', 'Existing portfolio']);
      if (k.includes('tpn_amount')) return String(int(r, 1, 4));
      if (k.includes('tpn_type')) return pick(r, ['Retail', 'Restaurant', 'MOTO']);
      return pick(r, PROVIDERS);
    }
    case 'long_text':
      return k === 'refund_policy'
        ? 'Refunds accepted within 30 days with the original receipt. Card refunds return to the original card; cash sales are refunded to store credit above $50.'
        : `${ctx.name} operates a ${pick(r, INDUSTRIES).toLowerCase()} business serving walk-in and repeat customers, with a small online ordering channel added in the last two years.`;
    case 'number':
      return int(r, 0, 12);
    case 'currency': {
      if (k.includes('volume')) return money(r, 8000, 450000);
      if (k.includes('avg_transaction')) return money(r, 18, 140);
      if (k.includes('max_transaction')) return money(r, 500, 9000);
      if (k.includes('lease') || k.includes('monthly')) return money(r, 5, 199);
      return money(r, 0.02, 0.45, 3);
    }
    case 'percentage':
      return money(r, 0.15, 3.5, 2);
    case 'date':
      if (k === 'business_founded_date') return dateBetween(r, 1998, 2020);
      if (k === 'onboard_date') return dateBetween(r, 2025, 2026);
      return dateBetween(r, 2025, 2026);
    case 'checkbox':
      return r() > 0.5;
    case 'email':
      return `${ctx.slug}.partner@example.com`;
    case 'phone':
      return `(${int(r, 201, 989)}) ${int(r, 200, 999)}-${digits(r, 4)}`;
    case 'url':
      return `https://www.${ctx.slug}.example.com`;
    case 'identifier': {
      const n = field.digits?.[0] ?? 9;
      return digits(r, n);
    }
    case 'address':
      return {
        street: `${int(r, 10, 4900)} ${pick(r, STREETS)}`,
        city: pick(r, CITIES),
        state: pick(r, STATES),
        zip: digits(r, 5),
        country: 'USA',
      };
    case 'dropdown':
    case 'status': {
      const options = ctx.choicesFor(field.id, ctx.moduleId);
      if (!options.length) return null;
      return pick(r, options).key;
    }
    case 'multi_select': {
      const options = ctx.choicesFor(field.id, ctx.moduleId);
      if (!options.length) return [];
      // One value, not several: `bankruptcy` is the only multi-select and a
      // record with three simultaneous bankruptcies is not realistic demo data.
      return [pick(r, options).key];
    }
    case 'team_member': {
      if (!ctx.teamIds.length) return [];
      if (k === 'team_members_assigned') {
        // Two people on some records, one on the rest — enough for the client
        // to see shared visibility working without making every record shared.
        const first = pick(r, ctx.teamIds);
        const second = pick(r, ctx.teamIds);
        return first === second || r() > 0.4 ? [first] : [first, second];
      }
      return [pick(r, ctx.teamIds)];
    }
    case 'months': {
      // A seasonal business is busy in a contiguous run of months.
      const start = int(r, 0, 8);
      return MONTH_NAMES.slice(start, start + int(r, 2, 4));
    }
    case 'percent_split': {
      const options = ctx.choicesFor(field.id, ctx.moduleId);
      if (!options.length) return null;
      // Must total exactly 100: weights are normalised and the remainder is
      // pushed onto the first slice, so rounding can never leave 99 or 101.
      const chosen = options.slice(0, Math.min(options.length, int(r, 2, 3)));
      const weights = chosen.map(() => int(r, 1, 10));
      const total = weights.reduce((a, b) => a + b, 0);
      const out = {};
      let running = 0;
      chosen.forEach((opt, i) => {
        const share = i === chosen.length - 1 ? 100 - running : Math.max(5, Math.round((weights[i] / total) * 100));
        running += share;
        out[opt.key] = share;
      });
      return out;
    }
    case 'grid': {
      const cols = field.grid_columns ?? [];
      return Array.from({ length: int(r, 1, 3) }, () => {
        const row = {};
        for (const col of cols) {
          if (col.type === 'currency') row[col.label] = String(money(r, 25, 900));
          else if (col.type === 'date') row[col.label] = dateBetween(r, 2025, 2026);
          else if (col.type === 'long_text') row[col.label] = 'Agreed at signing; invoiced separately.';
          else if (col.label.toLowerCase().includes('paid')) row[col.label] = pick(r, ['Merchant', 'TapDash', 'Split']);
          else row[col.label] = pick(r, PROVIDERS);
        }
        return row;
      });
    }
    case 'repeat_group': {
      const schema = field.repeat_schema ?? [];
      const count = int(r, 1, Math.min(3, field.repeat_max ?? 3));
      return Array.from({ length: count }, (_, i) => {
        const inst = {};
        const rr = rng(`${seedBase}:${field.key}:${i}`);
        const first = pick(rr, FIRST);
        const last = pick(rr, LAST);
        for (const m of schema) {
          if (m.key === 'first') inst[m.key] = first;
          else if (m.key === 'last') inst[m.key] = last;
          else if (m.key === 'name') inst[m.key] = `${first} ${last}`;
          else if (m.type === 'email') inst[m.key] = `${first.toLowerCase()}.${last.toLowerCase()}@example.com`;
          else if (m.type === 'phone') inst[m.key] = `(${int(rr, 201, 989)}) ${int(rr, 200, 999)}-${digits(rr, 4)}`;
          else if (m.type === 'percentage') inst[m.key] = count === 1 ? 100 : Math.floor(100 / count);
          else if (m.type === 'identifier') inst[m.key] = digits(rr, m.digits?.[0] ?? 9);
          else if (m.key === 'title') inst[m.key] = pick(rr, ['Owner', 'Managing Partner', 'CFO', 'Director']);
          else inst[m.key] = `${first} ${last}`;
        }
        return inst;
      });
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Load the world                                                             */
/* -------------------------------------------------------------------------- */
step('Reading configuration…');

const { rows: admins } = await c.query(
  `select p.id, p.email::text email from profiles p join roles r on r.id = p.role_id
    where r.is_admin and p.status = 'active' and p.deleted_at is null order by p.created_at limit 1`,
);
if (!admins.length) {
  console.error('No active admin profile found. Sign up the first admin before seeding.');
  process.exit(1);
}
const admin = admins[0];

const { rows: people } = await c.query(
  `select id, email::text email, coalesce(full_name, split_part(email::text,'@',1)) name
     from profiles where status = 'active' and deleted_at is null order by created_at`,
);
const teamIds = people.map((p) => p.id);
log(`${people.length} active users, admin is ${admin.email}`);

const { rows: fields } = await c.query(
  `select id, key, type::text type, digits, repeat_max, repeat_schema, grid_columns
     from fields where archived_at is null`,
);
const { rows: choices } = await c.query(`select field_id, key::text key, module_id from field_choices`);
/*
 * ⚠️ KEYED BY FIELD **AND MODULE**, not by field alone.
 *
 * `field_choices` carries a `module_id`: a field can offer a different list per
 * module, and `current_status` does — Leads offers new_lead…closed while Deals
 * offers application_sent…declined, over one shared field on one record.
 *
 * Indexing by field alone meant picking from the UNION of every module's list,
 * so most seeded records ended up holding a key their own module could not
 * resolve. `choicesFor()` looks up the module-scoped list and falls back to the
 * global one, and it renders the raw key when nothing matches — so the demo
 * showed lower-case blobs like "qualified" in modules that have never heard of
 * it. This index mirrors that lookup exactly.
 */
const choicesByFieldModule = new Map();
for (const ch of choices) {
  const key = `${ch.field_id}|${ch.module_id ?? 'global'}`;
  if (!choicesByFieldModule.has(key)) choicesByFieldModule.set(key, []);
  choicesByFieldModule.get(key).push(ch);
}
/** The same rule `choicesFor()` applies: this module's list if it has one,
 *  otherwise the global set. */
const choicesFor = (fieldId, moduleId) =>
  choicesByFieldModule.get(`${fieldId}|${moduleId}`)
  ?? choicesByFieldModule.get(`${fieldId}|global`)
  ?? [];
const { rows: modules } = await c.query(`select id, slug, kind, frozen from modules order by position`);
log(`${fields.length} fields, ${modules.length} modules`);

/* -------------------------------------------------------------------------- */
/* 1. Records                                                                 */
/* -------------------------------------------------------------------------- */
step('1. Records');

const DEMO_MERCHANTS = [
  "Joe's Pizza", 'Harbor Auto Repair', 'Bluebird Coffee Roasters', 'Cedar Lane Pharmacy',
  'Summit Fitness Club', 'Golden Wok Express', 'Riverside Dental Group', 'Nova Electronics',
  'Sunset Liquor & Wine', 'The Corner Bakery', 'Apex Landscaping', 'Willow Boutique',
  'Ironside Barbers', 'Pearl Nail Studio', 'Trailhead Outfitters', 'Metro Dry Cleaners',
  'Casa Verde Cantina', 'Lakeside Marine Supply', 'Bright Path Tutoring', 'Copper Kettle Catering',
  'Union Street Books', 'Ridgeway Veterinary', 'Falcon Print Shop', 'Seaside Surf Rentals',
];

let created = 0;
for (const name of DEMO_MERCHANTS) {
  const { rows: exists } = await c.query(
    `select id from records where deal_name = $1 and deleted_at is null`, [name],
  );
  if (exists.length) continue;
  await c.query(
    `insert into records (deal_name, creator_user_id, creator_kind, values)
     values ($1, $2, 'user', '{}'::jsonb)`, [name, admin.id],
  );
  created++;
}
log(`${created} created, ${DEMO_MERCHANTS.length - created} already present`);

const { rows: records } = await c.query(
  `select id, deal_name from records where deleted_at is null order by deal_name`,
);
log(`${records.length} live records total`);

/* -------------------------------------------------------------------------- */
/* 2. Field values — every field, every record                                */
/* -------------------------------------------------------------------------- */
step('2. Field values');

/*
 * Which module each record primarily lives in, read BEFORE any value is
 * generated.
 *
 * ⚠️ Ordered by the MODULE'S OWN POSITION, not by `added_at`. Memberships
 * inserted in one statement share a timestamp to the microsecond, so ordering
 * by `added_at` returns a different "first" module between runs — and the
 * chosen status list changed with it. Module position is stable and it is also
 * the more meaningful answer: a record in both Leads and Deals is primarily a
 * Lead, because that is the earlier stage. A per-module choice list can only be resolved once the module is
 * known, so membership has to be settled first — step 3 below tops up anything
 * missing, and on a first run this map is simply empty and the global lists
 * apply.
 */
const primaryModule = new Map(
  (await c.query(`
    select distinct on (rm.record_id) rm.record_id, rm.module_id
      from record_modules rm
      join modules m on m.id = rm.module_id
     order by rm.record_id, m.position
  `)).rows.map((r) => [r.record_id, r.module_id]),
);

let filled = 0;
for (const rec of records) {
  const slug = rec.deal_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ctx = {
    name: rec.deal_name,
    slug,
    choicesFor,
    moduleId: primaryModule.get(rec.id) ?? null,
    teamIds,
  };
  const values = {};

  for (const f of fields) {
    // The pipeline-synced Status fields are a projection of `record_pipelines`
    // (migration 57) with exactly one writer, and the write functions refuse
    // the key outright. Seeding them here would be writing to a derived column.
    const v = valueForField(f, rec.deal_name, ctx);
    if (v !== null && v !== undefined) values[f.key] = v;
  }

  const { rows: synced } = await c.query(
    `select f.key from pipelines p join fields f on f.id = p.status_field_id`,
  );
  for (const s of synced) delete values[s.key];

  // Merge rather than replace, so anything a human already typed on the demo
  // survives a re-run and only the untouched keys are filled in.
  await c.query(`update records set values = $2::jsonb || values where id = $1`, [rec.id, JSON.stringify(values)]);
  filled++;
}
log(`${filled} records populated across ${fields.length} fields`);

/* -------------------------------------------------------------------------- */
/* 3. Module membership and pipelines                                         */
/* -------------------------------------------------------------------------- */
step('3. Module membership and pipelines');

const displayModules = modules.filter((m) => m.kind === 'display' && !m.frozen);
let memberships = 0;
for (const [i, rec] of records.entries()) {
  // A spread rather than everything everywhere: the client needs to see that
  // modules are genuinely different projections, not five copies of one list.
  const targets = [displayModules[i % displayModules.length]];
  if (i % 3 === 0 && displayModules.length > 1) targets.push(displayModules[(i + 1) % displayModules.length]);

  for (const m of targets) {
    const { rowCount } = await c.query(
      `insert into record_modules (record_id, module_id, added_by)
       values ($1, $2, $3) on conflict do nothing`, [rec.id, m.id, admin.id],
    );
    memberships += rowCount;
  }
}
log(`${memberships} new module memberships`);

let pipelineAssigned = 0;
for (const [i, rec] of records.entries()) {
  const { rows: mems } = await c.query(`select module_id from record_modules where record_id = $1`, [rec.id]);
  for (const mem of mems) {
    const { rows: pls } = await c.query(
      `select p.id, (select s.id from pipeline_steps s where s.pipeline_id = p.id order by s.position offset $2 limit 1) step
         from pipelines p where p.module_id = $1 order by p.position limit 1`,
      [mem.module_id, i % 3],
    );
    if (!pls.length || !pls[0].step) continue;
    const { rowCount } = await c.query(
      `insert into record_pipelines (record_id, module_id, pipeline_id, step_id)
       values ($1, $2, $3, $4) on conflict (record_id, module_id) do nothing`,
      [rec.id, mem.module_id, pls[0].id, pls[0].step],
    );
    pipelineAssigned += rowCount;
  }
}
log(`${pipelineAssigned} pipeline assignments (the synced Status field follows automatically)`);

/* -------------------------------------------------------------------------- */
/* 4. Notes                                                                   */
/* -------------------------------------------------------------------------- */
step('4. Notes');

const NOTE_BODIES = [
  'Confirmed with the owner on the phone — figures are from their last statement.',
  'Waiting on the signed addendum before this can move forward.',
  'Merchant asked us to re-check the effective rate against their current processor.',
  'Numbers verified against the January statement. Safe to quote from.',
];
let notes = 0;
for (const [i, rec] of records.entries()) {
  if (i % 2) continue;
  const { rows: n } = await c.query(`select count(*) c from notes where record_id = $1`, [rec.id]);
  if (Number(n[0].c) > 0) continue;
  await c.query(
    `insert into notes (record_id, author_id, scope_kind, scope_id, body)
     values ($1, $2, 'field', 'monthly_acq_volume', $3),
            ($1, $2, 'tab', (select id::text from tabs where key = 'overview'), $4)`,
    [rec.id, admin.id, NOTE_BODIES[i % NOTE_BODIES.length], NOTE_BODIES[(i + 1) % NOTE_BODIES.length]],
  );
  notes += 2;
}
log(`${notes} notes`);

/* -------------------------------------------------------------------------- */
/* 5. Updates, replies and mention notifications                              */
/* -------------------------------------------------------------------------- */
step('5. Updates and replies');

const UPDATE_BODIES = [
  'Kicked off underwriting today. **Statements are in** and the file looks clean.\n\n- Bank statements: received\n- Corp docs: received\n- Voided check: outstanding',
  'Merchant called back. They want to compare against their current *effective rate* before signing.\n\n> "Send me the side-by-side and I will decide this week."',
  'Pricing approved by the desk. Moving to `contract sent`.\n\n1. Send agreement\n2. Book install\n3. Confirm batch settings',
];
let updates = 0;
for (const [i, rec] of records.entries()) {
  if (i % 3) continue;
  const { rows: u } = await c.query(`select count(*) c from updates where record_id = $1`, [rec.id]);
  if (Number(u[0].c) > 0) continue;

  const other = people.find((p) => p.id !== admin.id) ?? people[0];
  const body = `${UPDATE_BODIES[i % UPDATE_BODIES.length]}\n\n@${other.name} can you confirm?`;
  const { rows: root } = await c.query(
    `insert into updates (record_id, author_id, body) values ($1, $2, $3) returning id`,
    [rec.id, admin.id, body],
  );
  await c.query(
    `insert into update_mentions (update_id, user_id) values ($1, $2) on conflict do nothing`,
    [root[0].id, other.id],
  );
  await c.query(
    `insert into notifications (recipient_id, source_kind, record_id, body)
     values ($1, 'mention', $2, $3)`,
    [other.id, rec.id, `You were mentioned on ${rec.deal_name}`],
  );
  await c.query(
    `insert into updates (record_id, parent_id, author_id, body) values ($1, $2, $3, $4)`,
    [rec.id, root[0].id, other.id, 'Confirmed — I spoke to the owner this morning and the numbers match.'],
  );
  updates += 2;
}
log(`${updates} updates and replies, with mention notifications`);

/* -------------------------------------------------------------------------- */
/* 6. Cases                                                                   */
/* -------------------------------------------------------------------------- */
step('6. Cases');

const CASES = [
  { title: 'Terminal declining swiped transactions', issue: 'Merchant reports every swiped card declining since Tuesday. Keyed transactions go through.', solution: 'Terminal was on an old firmware build. Pushed the current one remotely and re-ran a test batch successfully.' },
  { title: 'Deposit missing for the weekend batch', issue: 'Saturday and Sunday batches settled but no deposit landed on Monday.', solution: null },
  { title: 'Chargeback documentation request', issue: 'Merchant needs help assembling evidence for a $480 chargeback.', solution: 'Sent the compelling-evidence template and filed the response before the deadline.' },
];
let cases = 0;
for (const [i, rec] of records.entries()) {
  if (i % 4) continue;
  const { rows: existing } = await c.query(`select count(*) c from cases where record_id = $1`, [rec.id]);
  if (Number(existing[0].c) > 0) continue;

  const spec = CASES[i % CASES.length];
  const other = people.find((p) => p.id !== admin.id) ?? people[0];
  const { rows: cs } = await c.query(
    `insert into cases (record_id, title, issue, issue_author, solution, solution_author, solution_at, state)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, number`,
    [rec.id, spec.title, spec.issue, admin.id, spec.solution, spec.solution ? admin.id : null,
      spec.solution ? new Date().toISOString() : null, spec.solution ? 'closed' : 'open'],
  );
  await c.query(
    `insert into case_managers (case_id, user_id) values ($1,$2) on conflict do nothing`, [cs[0].id, admin.id],
  );
  await c.query(
    `insert into case_replies (case_id, author_id, body) values ($1,$2,$3), ($1,$4,$5)`,
    [cs[0].id, other.id, 'Picked this up — asking the merchant for the batch reference now.',
      admin.id, 'Thanks. Flagging to the processor in parallel so we do not lose a day.'],
  );
  cases++;
}
log(`${cases} cases with managers and replies`);

/* -------------------------------------------------------------------------- */
/* 7. Logins                                                                  */
/* -------------------------------------------------------------------------- */
step('7. Logins');

const LOGIN_TYPES = [
  { type: 'Processor portal', link: 'https://portal.example-processor.com' },
  { type: 'Gateway', link: 'https://gateway.example.com/login' },
  { type: 'Merchant back office', link: 'https://backoffice.example.com' },
];
let logins = 0;
for (const [i, rec] of records.entries()) {
  const { rows: l } = await c.query(`select count(*) c from logins where record_id = $1`, [rec.id]);
  if (Number(l[0].c) > 0) continue;
  const spec = LOGIN_TYPES[i % LOGIN_TYPES.length];
  const slug = rec.deal_name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  // No password: `password_enc` is written only by the encrypting write path,
  // and a seeder must never invent ciphertext the reveal function cannot read.
  await c.query(
    `insert into logins (record_id, login_type, link, username, note, position)
     values ($1,$2,$3,$4,$5,$6)`,
    [rec.id, spec.type, spec.link, `${slug}_admin`, 'Demo credential row. Use Reveal to see the password flow.', i],
  );
  logins++;
}
log(`${logins} login rows`);

/* -------------------------------------------------------------------------- */
/* 8. Files and statements                                                    */
/* -------------------------------------------------------------------------- */
step('8. Files and statements');

/** A tiny, genuinely valid one-page PDF, so a download opens rather than 404s. */
const pdfBytes = (title) => Buffer.from(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
  `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n` +
  `4 0 obj<</Length 90>>stream\nBT /F1 12 Tf 20 70 Td (${title.slice(0, 40)}) Tj ET\nBT /F1 8 Tf 20 45 Td (TapDash CRM demo document) Tj ET\nendstream endobj\n` +
  `5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n` +
  `trailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');

let uploaded = 0;
let statementRows = 0;
if (!storage) {
  log('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping file uploads');
} else {
  for (const [i, rec] of records.entries()) {
    if (i % 3) continue;

    // The five locked Application rows, created lazily by the app the first
    // time its Files tab opens. Seeding calls the same helper with the same
    // names, so a seeded record and a browsed one end up identical.
    await c.query(
      `select ensure_application_file_rows($1, $2::text[], $3::int[])`,
      [rec.id, APPLICATION_ROWS, APPLICATION_ROWS.map((_, n) => n)],
    );
    const { rows: rows5 } = await c.query(
      `select id, name from file_rows where record_id = $1 and kind = 'application' and deleted_at is null order by position limit 2`,
      [rec.id],
    );
    for (const row of rows5) {
      const { rows: has } = await c.query(`select count(*) c from files where file_row_id = $1 and deleted_at is null`, [row.id]);
      if (Number(has[0].c) > 0) continue;
      const fileName = `${row.name.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`;
      const path = `${rec.id}/application/${row.id}/demo-${fileName}`;
      const up = await storage.storage.from('records').upload(path, pdfBytes(`${rec.deal_name} — ${row.name}`), {
        contentType: 'application/pdf', upsert: true,
      });
      if (up.error) { log('upload failed', up.error.message); continue; }
      await c.query(
        `insert into files (file_row_id, storage_path, name, size_bytes, uploaded_by)
         values ($1,$2,$3,$4,$5)`,
        [row.id, path, fileName, pdfBytes('x').length, admin.id],
      );
      uploaded++;
    }

    // Statements: three recent months per seeded record.
    const { rows: periods } = await c.query(
      `select id, year, month from statement_periods where (year, month) <= (2026, 9) order by year desc, month desc limit 3`,
    );
    for (const p of periods) {
      const { rows: has } = await c.query(
        `select count(*) c from statement_files where record_id = $1 and period_id = $2 and deleted_at is null`,
        [rec.id, p.id],
      );
      if (Number(has[0].c) > 0) continue;
      const fileName = `statement-${p.year}-${String(p.month).padStart(2, '0')}.pdf`;
      const path = `${rec.id}/statements/${p.id}/${fileName}`;
      const up = await storage.storage.from('records').upload(path, pdfBytes(`${rec.deal_name} ${p.year}-${p.month}`), {
        contentType: 'application/pdf', upsert: true,
      });
      if (up.error) { log('statement upload failed', up.error.message); continue; }
      await c.query(
        `insert into statement_files (record_id, period_id, storage_path, name, size_bytes, uploaded_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [rec.id, p.id, path, fileName, pdfBytes('x').length, admin.id],
      );
      statementRows++;
    }
  }
}
log(`${uploaded} application files, ${statementRows} statements uploaded to storage`);

/* -------------------------------------------------------------------------- */
/* 9. Communication                                                           */
/* -------------------------------------------------------------------------- */
step('9. Communication');

// `direction` is the enum 'in'/'out', and the identities are the two sides of
// the conversation — the sync matcher pairs `from_identity`/`to_identity`
// against sync-enabled Email and Phone fields, so they are real addresses.
const MESSAGES = [
  { channel: 'email', direction: 'in', subject: 'Re: your pricing proposal', body: 'Thanks for sending this over. Can you confirm the monthly fee includes PCI?' },
  { channel: 'email', direction: 'out', subject: 'Pricing proposal', body: 'Attached is the side-by-side against your current statement. Happy to walk through it.' },
  { channel: 'text', direction: 'in', subject: null, body: 'Terminal arrived this morning, thank you!' },
];
let messages = 0;
for (const [i, rec] of records.entries()) {
  if (i % 3) continue;
  const { rows: m } = await c.query(`select count(*) c from messages where record_id = $1`, [rec.id]);
  if (Number(m[0].c) > 0) continue;
  for (const msg of MESSAGES) {
    const merchantSide = msg.channel === 'text' ? '(555) 010-2233' : 'owner@example.com';
    const teamSide = msg.channel === 'text' ? '(555) 700-8100' : admin.email;
    await c.query(
      `insert into messages (record_id, channel, direction, from_identity, to_identity, subject, body, sent_at)
       values ($1, $2::message_channel, $3::message_direction, $4, $5, $6, $7, now() - ($8 || ' days')::interval)`,
      [rec.id, msg.channel, msg.direction,
        msg.direction === 'in' ? merchantSide : teamSide,
        msg.direction === 'in' ? teamSide : merchantSide,
        msg.subject, msg.body, String(messages % 9)],
    );
    messages++;
  }
}
log(`${messages} messages`);

/* -------------------------------------------------------------------------- */
/* 10. Other-tab entries                                                      */
/* -------------------------------------------------------------------------- */
step('10. Other tab entries');
/* The Other tab was removed (UI/UX Redesign spec §5, migration 9802). */
log('skipped — the Other tab no longer exists');

/* -------------------------------------------------------------------------- */
/* 11. Permission templates                                                   */
/* -------------------------------------------------------------------------- */
step('11. Permission templates');

const TEMPLATES = [
  { label: 'Sales Rep', hideTabs: ['logins', 'statements'], viewTabs: ['files'] },
  { label: 'Support Agent', hideTabs: ['pricing'], viewTabs: ['statements', 'files'] },
];
let templateGrants = 0;
for (const spec of TEMPLATES) {
  let { rows: t } = await c.query(`select id from permission_templates where label = $1`, [spec.label]);
  if (!t.length) {
    t = (await c.query(`insert into permission_templates (label) values ($1) returning id`, [spec.label])).rows;
  }
  const templateId = t[0].id;
  for (const [level, keys] of [['hidden', spec.hideTabs], ['view', spec.viewTabs]]) {
    for (const key of keys) {
      const { rows: tab } = await c.query(`select id from tabs where key = $1`, [key]);
      if (!tab.length) continue;
      const { rowCount } = await c.query(
        `insert into template_grants (template_id, scope_kind, scope_id, grant_level)
         values ($1, 'tab'::grant_scope, $2, $3::permission_level)
         on conflict (template_id, scope_kind, scope_id) do nothing`,
        [templateId, tab[0].id, level],
      );
      templateGrants += rowCount;
    }
  }
}
log(`${TEMPLATES.length} templates, ${templateGrants} new grants`);

/* -------------------------------------------------------------------------- */
step('Done');
const summary = await c.query(`
  select
    (select count(*) from records where deleted_at is null) records,
    (select count(*) from notes where deleted_at is null) notes,
    (select count(*) from updates where deleted_at is null) updates,
    (select count(*) from cases where deleted_at is null) cases,
    (select count(*) from case_replies where deleted_at is null) replies,
    (select count(*) from logins where deleted_at is null) logins,
    (select count(*) from files where deleted_at is null) files,
    (select count(*) from statement_files where deleted_at is null) statements,
    (select count(*) from messages) messages,
    (select count(*) from record_pipelines) pipelines,
    (select count(*) from notifications) notifications,
    (select count(*) from permission_templates) templates`);
console.table(summary.rows);

await c.end();
