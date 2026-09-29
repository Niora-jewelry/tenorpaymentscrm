-- Ported from Daniel Weissman's residuals branch, file
-- `20260827120000_residuals_reference_data_r5c.sql`.
--
-- Mechanical changes only: their role vocabulary
-- (auth_role() in ('admin','super_admin')) becomes our auth_is_admin(),
-- and their service-role test (auth_role() is null) becomes
-- auth.uid() is null. Nothing else in this file was altered.
--
-- The reasoning in the comments below is his and is kept verbatim:
-- it explains why the schema is shaped this way, and rewriting it in
-- my own words would lose the parts I have not yet had to understand.
-- ---------------------------------------------------------------------

-- ============================================================
-- Residuals R5c — reference data for the calculation engine
-- ============================================================
--
-- STRICTLY ADDITIVE. Eight new tables, two new functions, one extension.
-- Nothing is dropped, nothing is retyped, no existing table gains a column,
-- no existing policy or function is replaced. Nothing in the app reads any of
-- it yet, so this migration has NO deploy-ordering hazard: it may ship before,
-- with, or after its app code.
--
-- R5c COMPUTES NOTHING. It stores the four reference vocabularies R5d will
-- read:
--   1. the risk-tier vocabulary and its three-way name mapping
--   2. the Maverick template buy rates, effective-dated
--   3. per-merchant vendor costs (drawer subtab 2 — TapDash's own cost side)
--   4. partners and their per-MID assignment
--
-- MONEY RULE (R1b, unchanged): dollars are numeric(14,2), rates are
-- numeric(14,6), no float anywhere, every sum happens in SQL.
--
-- ONE DELIBERATE EXTENSION OF THAT RULE. A buy rate that denominates DOLLARS
-- is still numeric(14,6), not numeric(14,2). The workbook quotes Batch Fee at
-- 0.025 and VMD Auth Fee at 0.02/0.03/0.05 — sub-cent per-item dollar amounts
-- that numeric(14,2) would destroy at write. This is not new: R1b already
-- typed residual_lines.buy_rate_per_item as numeric(14,6) for exactly this
-- reason, and roundCurrencyForStorage rounds drawer currency to 6dp, not to
-- cents, for the same one. Buy rates are quoted amounts, not settled amounts;
-- settled amounts stay numeric(14,2).
--
-- PERIOD RULE (R1b, extended): a statement month is a calendar date pinned to
-- the 1st. R5c dates its reference data on the SAME grain — see the
-- "EFFECTIVE DATING" note above residual_buy_rate_schedules.
--
-- Idempotent: re-runnable (if-not-exists / not-exists guards throughout).
-- Seeds are a FLOOR, not a reset: a re-run inserts what is missing and
-- UPDATES nothing, so an admin's edit to a seeded rate survives.

begin;

-- ============================================================
-- 0. btree_gist
-- ============================================================
-- Needed for the EXCLUDE constraints that make overlapping effective-date
-- ranges unrepresentable. An EXCLUDE mixing an equality column (processor,
-- mid) with a range overlap operator needs gist operator classes for the
-- scalar side, which is what btree_gist provides.
--
-- WHY NOT A TRIGGER INSTEAD. A BEFORE trigger that SELECTs for an overlapping
-- row and raises is racy: two concurrent inserts each see no conflict and both
-- commit, leaving exactly the overlap the check exists to forbid. There are no
-- predicate locks to take. EXCLUDE is enforced by the index itself and is the
-- only race-free form. Overlapping rate versions are a wrong-money bug, not a
-- config annoyance, so the race matters even at admin-config write volumes.
--
-- Unqualified, matching the repo precedent in 20260430120000_init_extensions
-- (pgcrypto, citext). On Supabase this resolves against the postgres role's
-- search_path and lands in `public`.
create extension if not exists btree_gist;

-- ============================================================
-- 1. residual_risk_tiers — the risk vocabulary, and its three names
-- ============================================================
-- GRAIN: one row = one risk tier.
--
-- THREE VOCABULARIES, ONE ROW. The same tier is called three different things
-- by three different systems:
--   * the Pricing drawer stores a STRING     ('Low risk',   R2 select option)
--   * the workbook's merchant data uses an INTEGER (1)
--   * the buy-rate table's column heading is a THIRD name ('Low Risk')
-- "Moderate" (drawer) vs "Medium" (workbook) is a genuine vocabulary
-- mismatch, not a typo. Do NOT normalise one into the other: R2's migration
-- header pins the drawer option strings as calc join keys and forbids renaming
-- them, because a rename rewrites stored column_data values across every
-- record and silently breaks this join.
--
-- WHY A TABLE, NOT A CHECK. R5a moved the plan-code map out of TypeScript into
-- a table; R5b declined to do the same for its five-value verdict vocabulary
-- and argued why. The R5a precedent applies here, for R5a's own two reasons:
--
--   a) IT IS A MULTI-COLUMN MAPPING, NOT A VALUE LIST. A CHECK can pin a set
--      of legal strings. It cannot express "'Moderate risk' and the integer 2
--      and the column headed Medium Risk are the same tier". That is data with
--      three columns, and R5a's residual_plan_code_buckets got its own table
--      rather than a presets row for precisely that shape.
--
--   b) IT IS JOINED. R5b's verdict vocabulary is a CHECK because nothing joins
--      it — the values are produced by the algorithm and only ever read back
--      by a human. This map is the join key between the drawer and the rate
--      table, evaluated on every calculation. A joined mapping belongs in a
--      relation.
--
-- The CONVERSE of R5b's argument also holds and is worth stating: R5b kept its
-- vocabulary in a CHECK because the values can only change when the code
-- changes. These can change without a code change — a fifth Maverick tier is
-- an INSERT here plus one new drawer option, not a schema migration to any
-- rate table. That is the whole point of tiers-as-rows below.
--
-- statement_code is NULLABLE on purpose. 'No Buy Rate Program' has no integer
-- in the workbook's merchant data — merchants on no program simply carry no
-- risk integer. NULL means "this tier is not addressable by integer", which is
-- a fact about the source data, not a missing value to be filled in later.
create table if not exists public.residual_risk_tiers (
  id              uuid primary key default gen_random_uuid(),

  -- Canonical key. Snake-case-pinned so a join is a plain equality and a
  -- stray 'Low' can never silently miss (the residual_plan_code_buckets
  -- upper-case precedent, in this table's own casing convention).
  tier_key        text not null
                    check (tier_key = lower(btrim(tier_key))
                           and tier_key ~ '^[a-z][a-z0-9_]{0,30}$'),

  -- EXACT R2 drawer option string. See the do-not-rename note above.
  drawer_option   text not null
                    check (length(btrim(drawer_option)) between 1 and 60),

  -- The workbook's merchant-data integer. NULL = not addressable by integer.
  statement_code  integer check (statement_code between 0 and 99),

  -- Human label for the rate grid. Deliberately NOT the workbook's
  -- "Maverick Low Risk" heading: the "Maverick " prefix names the PROCESSOR,
  -- which lives on the schedule, not on the tier. A tier is processor-
  -- agnostic; a schedule is not.
  label           text not null
                    check (length(btrim(label)) between 1 and 60),

  sort_order      integer not null,

  created_at      timestamptz not null default now(),
  created_by_id   uuid references auth.users(id),
  updated_at      timestamptz not null default now(),
  updated_by_id   uuid references auth.users(id),
  deleted_at      timestamptz,
  deleted_by_id   uuid references auth.users(id)
);

-- PLAIN unique, NOT the house partial-on-live-rows form. This is a FOREIGN KEY
-- TARGET (residual_buy_rate_tiers.risk_tier references it) and PostgreSQL
-- cannot reference a partial unique index. The tradeoff is deliberate: "retire
-- a tier and re-add the same key later" is not a supported operation — you
-- clear deleted_at instead. A rate row pointing at a tier that does not exist
-- is a silent hole in a money calculation, which is worth more than the
-- convenience of re-using a retired key.
create unique index if not exists residual_risk_tiers_tier_key_unique
  on public.residual_risk_tiers (tier_key);

-- One live tier per drawer option, and per statement integer. Partial, because
-- neither is an FK target and a retired tier must not block its replacement.
create unique index if not exists residual_risk_tiers_drawer_option_unique
  on public.residual_risk_tiers (drawer_option)
  where deleted_at is null;

create unique index if not exists residual_risk_tiers_statement_code_unique
  on public.residual_risk_tiers (statement_code)
  where deleted_at is null and statement_code is not null;

drop trigger if exists residual_risk_tiers_set_updated_at
  on public.residual_risk_tiers;
create trigger residual_risk_tiers_set_updated_at
  before update on public.residual_risk_tiers
  for each row execute function public.tg_set_updated_at();

alter table public.residual_risk_tiers enable row level security;

drop policy if exists "residual_risk_tiers_select" on public.residual_risk_tiers;
create policy "residual_risk_tiers_select"
  on public.residual_risk_tiers
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_risk_tiers_insert" on public.residual_risk_tiers;
create policy "residual_risk_tiers_insert"
  on public.residual_risk_tiers
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_risk_tiers_update" on public.residual_risk_tiers;
create policy "residual_risk_tiers_update"
  on public.residual_risk_tiers
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_risk_tiers is
  'Risk-tier vocabulary and the three-way name map between the R2 drawer option string, the workbook''s merchant-data integer, and the buy-rate grid. Joined on every calculation; do NOT rename drawer_option (see the R2 migration header).';
comment on column public.residual_risk_tiers.drawer_option is
  'The risk-level option as written on the Pricing tab. R5 calc join key — renaming it rewrites stored values across every record and silently breaks the buy-rate join.';
comment on column public.residual_risk_tiers.statement_code is
  'The workbook merchant-data integer for this tier. NULL = the tier is not addressable by integer (No Buy Rate Program), not a missing value.';

-- ============================================================
-- 2. residual_fee_items — the buy-rate line vocabulary
-- ============================================================
-- GRAIN: one row = one fee item that a buy rate can be quoted for.
--
-- WHY A TABLE, NOT A CHECK. This is the R5a plan-code argument again, and NOT
-- the R4a target_column argument. residual_column_mappings.target_column is a
-- CHECK because its vocabulary is CLOSED — the legal targets are the columns
-- of residual_lines, and adding one is necessarily a schema change. The fee
-- items Maverick quotes are OPEN: a new fee item next quarter is an operational
-- fact about the processor, not a change to our schema. Under a CHECK, adding
-- "Debit Network Access Fee" would need an edit, a review, a deploy and a
-- migration; here it is one admin INSERT.
--
-- A CHECK also cannot carry the two attributes below, and both are needed.
--
-- rate_kind — WHAT THE STORED NUMBER MEANS, NOT WHAT IT MULTIPLIES.
-- 0.0002 for VMD BIN is a dimensionless fraction; 0.02 for VMD Auth Fee is two
-- cents. Same column, same type, different dimension — and nothing in the
-- number itself distinguishes them, so the distinction has to be stored.
-- This is deliberately NOT the formula registry: the formula registry says
-- which volume or which count a rate multiplies, and that is R5d's scope. This
-- says only whether the value is money or a ratio, which is a property of the
-- value and is required to render, validate, or even sanity-check it before
-- any formula exists.
--
-- billed_directly_to_merchant — MODELLED, NOT DERIVED. Three items are marked
-- "Paid directly by merchant" in the workbook (PCI Fee, Website Monitoring
-- Fee, IRS Annual Fee) and those three happen to carry identical values across
-- all four tiers. The temptation is to let R5d infer the flag from that
-- coincidence. It must not:
--   * the equality is EVIDENCE, not a DEFINITION. If Maverick tiers the
--     Website Monitoring Fee next year the inference silently inverts, and
--     nothing raises.
--   * the implication runs the other way round. The flag is an INPUT to how
--     R5d treats the item; a formula derived from the flag cannot also be the
--     thing the flag is derived from.
--   * a fourth item could legitimately be flat across tiers without being
--     merchant-billed, and the inference would misclassify it.
-- No CHECK enforces "flagged implies flat across tiers", deliberately — that
-- would freeze today's coincidence into the schema.
create table if not exists public.residual_fee_items (
  id                           uuid primary key default gen_random_uuid(),

  fee_item_key                 text not null
                                 check (fee_item_key = lower(btrim(fee_item_key))
                                        and fee_item_key ~ '^[a-z][a-z0-9_]{0,60}$'),

  label                        text not null
                                 check (length(btrim(label)) between 1 and 80),

  rate_kind                    text not null
                                 check (rate_kind in ('amount','rate')),

  billed_directly_to_merchant  boolean not null default false,

  sort_order                   integer not null,
  notes                        text,

  created_at                   timestamptz not null default now(),
  created_by_id                uuid references auth.users(id),
  updated_at                   timestamptz not null default now(),
  updated_by_id                uuid references auth.users(id),
  deleted_at                   timestamptz,
  deleted_by_id                uuid references auth.users(id)
);

-- PLAIN unique — FK target (residual_buy_rates.fee_item_key). Same reasoning
-- as residual_risk_tiers_tier_key_unique above.
create unique index if not exists residual_fee_items_key_unique
  on public.residual_fee_items (fee_item_key);

-- LABEL IS A JOIN SURFACE, NOT DISPLAY TEXT — so it is unique among live rows.
-- The workbook's calculation sheet references fee items BY NAME (its formula
-- registry rows read "Processor-TD Merchant Pricing / Terminal Monthly - Mav"
-- and the like), and that registry is what R5d has to reconcile against. Two
-- live items sharing a label would make a name-based match ambiguous, and an
-- ambiguous match in a formula registry resolves to whichever row came back
-- first — a silent wrong rate rather than an error.
--
-- Partial (live rows only), because unlike fee_item_key this is not an FK
-- target: a retired item must not block a replacement that reuses its name.
--
-- THE STRONGER FIX BELONGS TO R5d, and this index only makes it safe rather
-- than performing it: R5d should resolve each workbook name to a fee_item_key
-- ONCE, when its formula registry is seeded, and store the KEY. Matching a
-- label string on every calculation makes a rename or a stray space a
-- silent-miss, and R5c cannot prevent that from inside this table.
create unique index if not exists residual_fee_items_label_unique
  on public.residual_fee_items (lower(btrim(label)))
  where deleted_at is null;

drop trigger if exists residual_fee_items_set_updated_at
  on public.residual_fee_items;
create trigger residual_fee_items_set_updated_at
  before update on public.residual_fee_items
  for each row execute function public.tg_set_updated_at();

alter table public.residual_fee_items enable row level security;

drop policy if exists "residual_fee_items_select" on public.residual_fee_items;
create policy "residual_fee_items_select"
  on public.residual_fee_items
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_fee_items_insert" on public.residual_fee_items;
create policy "residual_fee_items_insert"
  on public.residual_fee_items
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_fee_items_update" on public.residual_fee_items;
create policy "residual_fee_items_update"
  on public.residual_fee_items
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_fee_items is
  'Open vocabulary of fee items a template buy rate can be quoted for. A new item is an admin INSERT, not a migration — the R5a plan-code precedent, not the R4a closed-CHECK one.';
comment on column public.residual_fee_items.label is
  'The workbook''s EXACT fee-item text, parentheticals included. Not display text — the calc sheet''s formula registry references fee items by name, so this is R5d''s reconciliation surface and a truncated label is a future join miss. Unique among live rows for that reason.';
comment on column public.residual_fee_items.rate_kind is
  'Dimension of the stored number: ''amount'' = dollars, ''rate'' = dimensionless fraction. A property of the VALUE, not of the formula — which volume or count it multiplies is the R5d formula registry, not this.';
comment on column public.residual_fee_items.billed_directly_to_merchant is
  'The workbook''s "Paid directly by merchant" flag. Stored, never derived: the three flagged items happen to be flat across all four tiers today, but that equality is evidence, not a definition, and inferring the flag from it inverts silently the moment Maverick tiers one of them.';

-- ============================================================
-- 3. residual_buy_rate_schedules — the effective-dated version header
-- ============================================================
-- GRAIN: one row = one processor's complete buy-rate table, valid over one
-- date range.
--
-- WHY A HEADER, RATHER THAN DATING EVERY CELL. The workbook is published as a
-- TABLE and revised as a table: all 44 rates and all 4 shares change together
-- on the same day. Three things follow:
--   * one row to date, one row to audit, one row to soft-delete — instead of
--     48 parallel date series that can drift into disagreeing about which
--     version is current;
--   * "no overlaps" becomes ONE constraint on ONE table, enforceable by the
--     index, rather than 48 constraints that are individually satisfiable and
--     jointly meaningless;
--   * a partial revision is unrepresentable. You cannot accidentally publish a
--     new PCI Fee against last quarter's Percentage, because the Percentage
--     belongs to a version, not to a cell.
-- The cost is that revising one rate means copying 48 rows into a new
-- schedule. That is the correct cost — a rate table with one changed cell IS a
-- new rate table, and copying it makes the diff auditable.
--
-- ============================================================
-- EFFECTIVE DATING — THE MECHANICS, ESTABLISHED HERE
-- ============================================================
-- Nothing in this codebase was effective-dated before R5c. Every convention
-- below is being established, so it is stated in full and every other dated
-- table in this migration follows it verbatim.
--
-- 1. GRAIN IS THE STATEMENT MONTH, NOT AN INSTANT. effective_from and
--    effective_to are plain dates pinned to the 1st, guarded by a CHECK —
--    the R1b period rule, applied to reference data. A rate change on the 17th
--    is not representable, and that is the point: a monthly statement has no
--    sub-month allocation, so "which rate applied on the 17th" is a question
--    with no answer this data model can give. Better to be unable to ask it
--    than to answer it wrong. timestamptz is doubly wrong here for R1b's own
--    reason (a calendar fact is not an instant) and for a new one (a rate
--    boundary read in two timezones would fall in two different months).
--
-- 2. RANGES ARE HALF-OPEN, [effective_from, effective_to). effective_to is
--    EXCLUSIVE, so a successor's effective_from EQUALS its predecessor's
--    effective_to. No off-by-one-month, and adjacent versions cannot leave a
--    one-month hole by construction. NULL effective_to means open-ended.
--
-- 3. OVERLAPS ARE UNREPRESENTABLE. Enforced by an EXCLUDE constraint on
--    (processor, daterange) filtered to live rows — see section 0 for why not
--    a trigger. Two schedules covering the same month would make
--    "the rates in effect for month M" return two answers, and a calculation
--    that silently picks one is worse than one that fails.
--
-- 4. GAPS ARE NOT PREVENTED, THEY ARE DETECTED. No constraint can require that
--    a set of ranges COVERS anything — coverage is a property of the whole set,
--    and there is no legitimate moment at which a half-entered schedule set is
--    invalid. So the invariant is made CHECKABLE instead of enforced:
--    residual_buy_rate_coverage() (section 9) reports every live statement
--    month with no covering schedule, and the lookup RAISES rather than
--    returning an empty rate set. A missing rate must never read as a zero
--    rate.
--
-- 5. THE LOOKUP IS A FUNCTION, NOT A COPIED PREDICATE.
--    residual_buy_rates_for_month() (section 9) is the ONE implementation of
--    "which schedule is in effect for month M" — the same discipline R5a
--    applied to residual_derive_plan_rollup and R5b to
--    residual_reconcile_mid_links. R5d and any admin UI call it; neither
--    writes its own `effective_from <= M and (effective_to is null or
--    effective_to > M)`, because two copies of that predicate drift into
--    disagreeing about a boundary month and the disagreement is silent.
--
-- PROCESSOR IS FREE TEXT, PINNED. residual_imports.processor is unconstrained
-- free text today and R5c deliberately does not retype it — that is a
-- normalization slice of its own. The new column IS pinned to upper/trimmed,
-- because a new table is cheap to constrain and an unpinned join key is how
-- 'Maverick' and 'maverick ' become two processors. The consequence is that
-- the join to residual_imports must normalise the OTHER side:
--   join public.residual_buy_rate_schedules s
--     on s.processor = upper(btrim(i.processor))
-- residual_buy_rates_for_month() applies upper(btrim(...)) to its argument for
-- the same reason, so callers never have to remember.
create table if not exists public.residual_buy_rate_schedules (
  id             uuid primary key default gen_random_uuid(),

  processor      text not null
                   check (processor = upper(btrim(processor))
                          and length(processor) between 1 and 100),

  label          text not null
                   check (length(btrim(label)) between 1 and 120),

  effective_from date not null
                   check (extract(day from effective_from) = 1),

  -- EXCLUSIVE upper bound. NULL = open-ended.
  effective_to   date
                   check (effective_to is null
                          or extract(day from effective_to) = 1),

  notes          text,

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id),

  constraint residual_buy_rate_schedules_range_ordered
    check (effective_to is null or effective_to > effective_from)
);

-- Overlap is unrepresentable. WHERE clause scopes it to live rows so a
-- soft-deleted schedule does not block its replacement over the same months.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'residual_buy_rate_schedules_no_overlap'
  ) then
    alter table public.residual_buy_rate_schedules
      add constraint residual_buy_rate_schedules_no_overlap
      exclude using gist (
        processor                                  with =,
        daterange(effective_from, effective_to)     with &&
      ) where (deleted_at is null);
  end if;
end$$;

create index if not exists residual_buy_rate_schedules_lookup
  on public.residual_buy_rate_schedules (processor, effective_from desc)
  where deleted_at is null;

drop trigger if exists residual_buy_rate_schedules_set_updated_at
  on public.residual_buy_rate_schedules;
create trigger residual_buy_rate_schedules_set_updated_at
  before update on public.residual_buy_rate_schedules
  for each row execute function public.tg_set_updated_at();

alter table public.residual_buy_rate_schedules enable row level security;

drop policy if exists "residual_buy_rate_schedules_select"
  on public.residual_buy_rate_schedules;
create policy "residual_buy_rate_schedules_select"
  on public.residual_buy_rate_schedules
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_buy_rate_schedules_insert"
  on public.residual_buy_rate_schedules;
create policy "residual_buy_rate_schedules_insert"
  on public.residual_buy_rate_schedules
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_buy_rate_schedules_update"
  on public.residual_buy_rate_schedules;
create policy "residual_buy_rate_schedules_update"
  on public.residual_buy_rate_schedules
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_buy_rate_schedules is
  'One processor''s complete template buy-rate table, valid over a half-open [effective_from, effective_to) month range. Overlaps are unrepresentable (EXCLUDE); gaps are detected by residual_buy_rate_coverage(), not prevented.';
comment on column public.residual_buy_rate_schedules.effective_to is
  'EXCLUSIVE upper bound, pinned to the 1st. A successor''s effective_from equals this value, so adjacent versions cannot leave a gap. NULL = open-ended.';
comment on column public.residual_buy_rate_schedules.processor is
  'Upper/trim-pinned. residual_imports.processor is UNPINNED free text and is deliberately not retyped by R5c — join it as upper(btrim(i.processor)).';

-- ============================================================
-- 4. residual_buy_rate_tiers — the Percentage row, structurally separated
-- ============================================================
-- GRAIN: one row = one (schedule, risk tier).
--
-- THIS TABLE EXISTS SO THE PERCENTAGE ROW CANNOT BE MISTAKEN FOR A BUY RATE.
-- In the workbook the Percentage sits as a 12th row in the same grid as the 11
-- fee items, in the same four columns, and it is not the same kind of thing at
-- all. A fee item's number is a COST that Maverick charges. The Percentage is
-- TapDash's SHARE of what is left: Maverick pays TapDash that fraction of
-- (Total Income - Total Buy Rate), and the share SHRINKS as risk rises
-- (0.9 / 0.9 / 0.8 / 0.7) where every buy rate RISES. An engine that summed
-- the Percentage into a buy-rate total would be adding a share to a cost and
-- would be wrong by roughly the entire margin.
--
-- The defence is structural, not documentary. tapdash_share is a column on the
-- TIER, and a tier has no fee_item_key. There is no row shape in which the
-- share can appear alongside the fee items:
--   * it is not in residual_buy_rates, so `sum(rate)` over a tier's fee items
--     cannot reach it;
--   * it has no residual_fee_items row, so it cannot be enumerated as an item;
--   * residual_buy_rates_for_month() returns it as a scalar repeated per row,
--     visibly a different column, never as another (fee_item_key, rate) pair.
-- A comment saying "do not add this to the total" would have been the weaker
-- version of this, and is the version this table replaces.
--
-- WHY NOT FOUR COLUMNS ON THE SCHEDULE (share_no_program, share_low, ...).
-- Same reason the rates are rows: a fifth tier would then be an ALTER TABLE
-- plus every reader, instead of an INSERT. See the note on tiers-as-rows in
-- section 5.
create table if not exists public.residual_buy_rate_tiers (
  id             uuid primary key default gen_random_uuid(),

  schedule_id    uuid not null
                   references public.residual_buy_rate_schedules(id),

  risk_tier      text not null
                   references public.residual_risk_tiers(tier_key),

  -- TapDash's share of (Total Income - Total Buy Rate). A fraction of a
  -- whole, so [0,1] is not a guess about plausible values — it is what the
  -- quantity IS. Unlike a fee amount, a value outside the range is
  -- definitionally wrong rather than merely surprising.
  tapdash_share  numeric(14,6) not null
                   check (tapdash_share >= 0 and tapdash_share <= 1),

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id)
);

-- PLAIN unique — FK target for residual_buy_rates' composite reference below.
-- Identity within a schedule is unique dead or alive; a schedule never has two
-- rows for the same tier, and "delete and re-add" is un-delete instead.
create unique index if not exists residual_buy_rate_tiers_schedule_tier_unique
  on public.residual_buy_rate_tiers (schedule_id, risk_tier);

drop trigger if exists residual_buy_rate_tiers_set_updated_at
  on public.residual_buy_rate_tiers;
create trigger residual_buy_rate_tiers_set_updated_at
  before update on public.residual_buy_rate_tiers
  for each row execute function public.tg_set_updated_at();

alter table public.residual_buy_rate_tiers enable row level security;

drop policy if exists "residual_buy_rate_tiers_select"
  on public.residual_buy_rate_tiers;
create policy "residual_buy_rate_tiers_select"
  on public.residual_buy_rate_tiers
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_buy_rate_tiers_insert"
  on public.residual_buy_rate_tiers;
create policy "residual_buy_rate_tiers_insert"
  on public.residual_buy_rate_tiers
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_buy_rate_tiers_update"
  on public.residual_buy_rate_tiers;
create policy "residual_buy_rate_tiers_update"
  on public.residual_buy_rate_tiers
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_buy_rate_tiers is
  'Per (schedule, risk tier) header carrying tapdash_share — the workbook''s "Percentage" row. Kept OUT of residual_buy_rates so a share can never be summed into a buy-rate total: this table has no fee_item_key, so there is no row shape in which the two are interchangeable.';
comment on column public.residual_buy_rate_tiers.tapdash_share is
  'TapDash''s fraction of (Total Income - Total Buy Rate) for this tier. NOT a per-item rate. Falls as risk rises (0.9/0.9/0.8/0.7) where every buy rate climbs.';

-- ============================================================
-- 5. residual_buy_rates — the 11 x 4 grid, as rows
-- ============================================================
-- GRAIN: one row = one (schedule, risk tier, fee item) rate.
--
-- TIERS ARE ROWS, NOT COLUMNS. The workbook presents four risk columns, and
-- transcribing that shape into four columns (rate_no_program, rate_low,
-- rate_medium, rate_high) would be the obvious move. It is the wrong one:
--
--   * A FIFTH MAVERICK TIER would be an ALTER TABLE, a type regen, a change to
--     every SELECT list, every reader, and the lookup function — for what is
--     an operational fact about a processor's pricing. As rows it is one INSERT
--     into residual_risk_tiers plus one INSERT per fee item, and no code
--     changes at all.
--   * A SECOND PROCESSOR with a different tier count could not share the table
--     at all. TSYS with three tiers and Fiserv with six do not fit into four
--     fixed columns; they fit trivially into rows, each under its own schedule.
--   * NULL BECOMES AMBIGUOUS in the column form. A processor with no
--     medium tier and a medium tier whose rate has not been entered would both
--     read as NULL in rate_medium. As rows, the first is an absent row and the
--     second is a NOT NULL violation.
--   * The composite FK below cannot exist in the column form, so "every rate
--     belongs to a tier that has a share" stops being structural.
--
-- numeric(14,6) FOR BOTH rate_kinds — see the money-rule note in the header.
--
-- NO SIGN CHECK on rate, deliberately. A negative buy rate is a rebate and
-- those do occur; the money rule constrains TYPE and PRECISION, not sign. The
-- two constrained-to-[0,1] quantities in this migration (tapdash_share,
-- residual_mid_partners.split) are constrained because they are shares of a
-- whole, which is a different kind of claim.
create table if not exists public.residual_buy_rates (
  id             uuid primary key default gen_random_uuid(),

  schedule_id    uuid not null
                   references public.residual_buy_rate_schedules(id),

  risk_tier      text not null,

  fee_item_key   text not null
                   references public.residual_fee_items(fee_item_key),

  rate           numeric(14,6) not null,

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id),

  -- COMPOSITE FK, not two independent ones. This is what makes "a rate can
  -- only exist for a tier that has a tapdash_share in the same schedule" a
  -- structural fact. Without it, a rate row could name a tier the schedule
  -- never declared, the lookup's join would silently drop it, and a fee would
  -- vanish from a calculation with nothing raised.
  constraint residual_buy_rates_schedule_tier_fk
    foreign key (schedule_id, risk_tier)
    references public.residual_buy_rate_tiers (schedule_id, risk_tier)
);

-- One live rate per cell. Partial (not an FK target), so a soft-deleted rate
-- does not block its replacement — the residual_column_mappings precedent.
create unique index if not exists residual_buy_rates_cell_unique
  on public.residual_buy_rates (schedule_id, risk_tier, fee_item_key)
  where deleted_at is null;

create index if not exists residual_buy_rates_schedule
  on public.residual_buy_rates (schedule_id, risk_tier)
  where deleted_at is null;

drop trigger if exists residual_buy_rates_set_updated_at
  on public.residual_buy_rates;
create trigger residual_buy_rates_set_updated_at
  before update on public.residual_buy_rates
  for each row execute function public.tg_set_updated_at();

alter table public.residual_buy_rates enable row level security;

drop policy if exists "residual_buy_rates_select" on public.residual_buy_rates;
create policy "residual_buy_rates_select"
  on public.residual_buy_rates
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_buy_rates_insert" on public.residual_buy_rates;
create policy "residual_buy_rates_insert"
  on public.residual_buy_rates
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_buy_rates_update" on public.residual_buy_rates;
create policy "residual_buy_rates_update"
  on public.residual_buy_rates
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_buy_rates is
  'Template buy rates as (schedule, tier, fee item) ROWS rather than four tier COLUMNS, so a fifth Maverick tier or a second processor with a different tier count is an INSERT rather than an ALTER TABLE plus every reader.';

-- ============================================================
-- 6. residual_merchant_vendor_costs — drawer subtab 2, typed and dated
-- ============================================================
-- GRAIN: one row = one MID's vendor-cost configuration, valid over one
-- half-open month range.
--
-- These are the 11 fields of the drawer's "Processor-Vendor Pricing to TD"
-- subtab. The workbook states their purpose verbatim: "This tab lists the
-- costs incurred by TapDash to pay for the merchants operations. The Merchant
-- does not participate in these costs." They are the COST side that R2 never
-- captured; R2's 26 fields are all subtab 1, the SELL side.
--
-- ============================================================
-- THESE ARE NOT R2'S SIX "- Mav" FIELDS. EVIDENCE, NOT INFERENCE.
-- ============================================================
-- R2 already seeded gateway_provider_mav, gateway_monthly_mav,
-- gateway_auth_fee_mav, terminal_provider_mav, terminal_monthly_mav and
-- terminal_auth_fee_mav into subtab 1. Four of the eleven columns below are
-- near-homonyms of those, and the two sets are one careless read from being
-- merged by a future maintainer. They are genuinely different things, and the
-- proof is in the calc sheet rather than in the naming:
--
--   * Two formula rows resolve the "- Mav" fields into TOTAL INCOME:
--       iPOS Spin Fee       Total Income = Processor-TD Merchant Pricing /
--                                          Terminal Monthly - Mav
--       Accept Blue Monthly Total Income = Processor-TD Merchant Pricing /
--                                          Gateway Monthly - Mav
--     A value that feeds INCOME is what the MERCHANT is charged. So the six
--     "- Mav" fields are sell-side, and they belong exactly where R2 put them.
--
--   * The columns below are what TAPDASH PAYS. The workbook's merchant rows
--     show Accept.blue at Gateway Monthly Fee 15 / Gateway Auth Fee 0.05,
--     matching the Accept.Blue vendor rate card on the Template Buy Rates
--     sheet exactly — a vendor's price list, not a merchant's invoice.
--
-- The same gateway can therefore appear on both sides of one merchant at two
-- different numbers, and the spread between them is margin. Collapsing the two
-- sets would not merely lose a field; it would delete the margin by making the
-- cost and the charge the same number.
--
-- ============================================================
-- WHY THESE ARE NOT lead_gen_columns + column_data (Decision A)
-- ============================================================
-- Following R2 would have been consistent and would have got the drawer UI for
-- free. It was rejected, and the reason is not aesthetic:
--
--   1. EFFECTIVE DATING IS NOT EXPRESSIBLE IN column_data AT ALL. The blob is
--      one object per thread. One MID has exactly one version of every value,
--      forever, and a correction overwrites history in place. There is no
--      shape of jsonb key that fixes this without inventing a versioning
--      scheme inside a blob — at which point it is a table with worse
--      ergonomics. Since the spec makes dating non-negotiable for merchant
--      pricing, putting subtab 2 in column_data would have meant R5c could not
--      date it, and Decision B would collapse to "nothing is dated".
--
--   2. THEY ARE CALC INPUTS AND INHERIT EVERY GAP-#8 DEFECT. column_data is
--      untyped (no numeric column, no CHECK), unindexed for these keys,
--      IEEE-754 in origin (a JS number written through jsonb), and needs a
--      ::numeric cast on every read. R1b refused a jsonb blob for
--      residual_lines in precisely these words, for precisely this reason, and
--      the same argument covers the same kind of data here.
--
--   3. PRECISION IS NOT MERELY UNENFORCED, IT IS ACTIVELY WRONG ON THE WRITE
--      PATH. roundCurrencyForStorage is Math.round(n * 1e6) / 1e6, which is
--      HALF_CEILING on ties, not HALF_UP: it turns -2.675 into -2.67 where
--      numeric(14,2)/(14,6) give -2.68. R5a established this. A numeric column
--      does the rounding correctly, in SQL, with no JS round-trip.
--
-- The case AGAINST this decision, stated plainly because it is real:
--   * THE DRAWER UI IS LOST. R2 got 26 fields rendered for free. These 11 get
--     nothing until someone builds a panel, and R5c is schema-only — so
--     between this migration and that panel, subtab 2 is enterable only by SQL.
--     That work is named in the file-change plan and must not be assumed to
--     have happened.
--   * MERCHANT PRICING NOW LIVES IN TWO PLACES with two precision stories,
--     and R5d reads its sell side from jsonb and its cost side from a typed
--     table. That is genuinely ugly and is only acceptable as a bridgehead,
--     which is why the subtab-1 migration path is written down (see the
--     file-change plan) rather than left implicit.
--   * FOUR OF THE ELEVEN ARE PROVIDER NAMES — plain text that EAV handles
--     perfectly well. They come along because splitting a subtab across two
--     storage models would be worse than either.
--
-- WHY NOT LEAVE IT UNDATED FOR SYMMETRY WITH SUBTAB 1: because you do not add
-- a NEW financial table born with a known defect in order to match an old one.
-- The asymmetry after this migration is "everything created by R5c is dated;
-- the one pre-existing blob is not, and is flagged with a named remediation" —
-- which is a strictly better position than uniform undatedness.
--
-- ============================================================
-- WHY THIS KEYS ON A MID AND NOT ON R5b's thread_id
-- ============================================================
-- R5b exists because MID-as-identity was fragile, so keying a NEW table by MID
-- text deserves an argument rather than an assumption. The argument is that
-- R5b solved a DIFFERENT identity problem, and that these two tables live in
-- the namespace R5b's problem does not touch.
--
-- THERE ARE TWO MID NAMESPACES IN THIS SYSTEM, and conflating them is the
-- actual bug to avoid:
--   * the STATEMENT MID — residual_lines.mid, carried verbatim from a
--     processor file. IMMUTABLE: a statement said what it said, forever.
--   * the RECORD MID — lead_gen_threads.column_data->>'mid', typed by a human
--     into the drawer, uniquely indexed by R3, and MUTABLE.
-- R5b's whole job is adjudicating BETWEEN those two — hence the five-value
-- verdict, the suffix fallback for statements that print a four-character mask
-- in front of the MID, and the relink trigger that re-adjudicates when a
-- RECORD's MID moves.
--
-- mid HERE IS THE STATEMENT MID. Declared, not incidental: R5c's only consumer
-- is R5d, which computes over residual_lines at (period, statement MID, fee
-- item) grain. Keying the inputs in the same namespace as the fact table makes
-- the join total and exact —
--   on regexp_replace(l.mid,'[^0-9]','','g') = v.mid
-- — and immune to every merchant-record event, because nothing here points at
-- a record. A thread_id FK would have pointed the calculation's inputs at a
-- mutable CRM row that 20 of the 21 MIDs in residual_lines do not even have,
-- making vendor costs unenterable for 95% of the data.
--
-- WHAT A RECORD'S MID CHANGING DOES TO THESE ROWS: nothing. There is no
-- pointer to invalidate. R5b's trigger re-adjudicates residual_lines.thread_id
-- and these rows are not in its scope, correctly.
--
-- WHAT A MID THAT NEVER GETS A RECORD DOES: also nothing. That is the normal
-- case today, not a degraded one.
--
-- THE FAILURE THAT REMAINS, AND IT IS REAL: a merchant re-boarding under a new
-- MID. New statements arrive under MID B while the vendor costs and the
-- partner assignment sit on MID A, and nothing points out that the new MID has
-- no reference data. That is not detectable by any constraint — MID B is a
-- perfectly valid MID with no rows against it — so it is made CHECKABLE
-- instead, by residual_reference_coverage() in section 9c, exactly as buy-rate
-- gaps are. A partner arrangement carrying across a re-boarding is a
-- COMMERCIAL question, and surfacing it for a human beats a thread_id that
-- would have silently assumed the answer was yes.
--
-- MID IS STORED NORMALIZED. R3 pinned the normalization to digits-only
-- (regexp_replace(mid,'[^0-9]','','g')) and its TypeScript twin is
-- normalizeMidForStorage(). residual_lines.mid is RAW text carried from a
-- vendor file; this column is not, because a new table can enforce what an
-- imported one cannot — which is also what makes the join above a plain
-- equality on one side only.
create table if not exists public.residual_merchant_vendor_costs (
  id                        uuid primary key default gen_random_uuid(),

  mid                       text not null
                              check (mid = regexp_replace(mid, '[^0-9]', '', 'g')
                                     and length(mid) between 1 and 32),

  effective_from            date not null
                              check (extract(day from effective_from) = 1),
  effective_to              date
                              check (effective_to is null
                                     or extract(day from effective_to) = 1),

  -- Gateway
  gateway_provider          text,
  gateway_monthly_fee       numeric(14,6),
  gateway_auth_fee          numeric(14,6),
  gateway_per_update        numeric(14,6),

  -- Terminal
  terminal_provider         text,
  terminal_monthly_fee      numeric(14,6),
  terminal_transaction_fee  numeric(14,6),

  -- Rewards. A PERCENTAGE in the workbook, stored UNSCALED as a decimal
  -- fraction (0.0035 = 0.35%), matching the convention R2 pinned for the
  -- drawer's percentage type so that R5d multiplies by volume directly and
  -- only the formatter ever scales.
  rewards_provider          text,
  rewards_volume_cost       numeric(14,6),

  -- Other
  other_provider            text,
  other_monthly_fee         numeric(14,6),

  notes                     text,

  created_at                timestamptz not null default now(),
  created_by_id             uuid references auth.users(id),
  updated_at                timestamptz not null default now(),
  updated_by_id             uuid references auth.users(id),
  deleted_at                timestamptz,
  deleted_by_id             uuid references auth.users(id),

  constraint residual_merchant_vendor_costs_range_ordered
    check (effective_to is null or effective_to > effective_from)
);

-- Every numeric is NULLABLE with no default. A merchant with no rewards
-- program has no rewards cost, and NULL says that; 0 would assert a cost of
-- zero, which is a different claim and one R5d would sum.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'residual_merchant_vendor_costs_no_overlap'
  ) then
    alter table public.residual_merchant_vendor_costs
      add constraint residual_merchant_vendor_costs_no_overlap
      exclude using gist (
        mid                                     with =,
        daterange(effective_from, effective_to) with &&
      ) where (deleted_at is null);
  end if;
end$$;

create index if not exists residual_merchant_vendor_costs_lookup
  on public.residual_merchant_vendor_costs (mid, effective_from desc)
  where deleted_at is null;

drop trigger if exists residual_merchant_vendor_costs_set_updated_at
  on public.residual_merchant_vendor_costs;
create trigger residual_merchant_vendor_costs_set_updated_at
  before update on public.residual_merchant_vendor_costs
  for each row execute function public.tg_set_updated_at();

alter table public.residual_merchant_vendor_costs enable row level security;

drop policy if exists "residual_merchant_vendor_costs_select"
  on public.residual_merchant_vendor_costs;
create policy "residual_merchant_vendor_costs_select"
  on public.residual_merchant_vendor_costs
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_merchant_vendor_costs_insert"
  on public.residual_merchant_vendor_costs;
create policy "residual_merchant_vendor_costs_insert"
  on public.residual_merchant_vendor_costs
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_merchant_vendor_costs_update"
  on public.residual_merchant_vendor_costs;
create policy "residual_merchant_vendor_costs_update"
  on public.residual_merchant_vendor_costs
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_merchant_vendor_costs is
  'The Pricing tab''s vendor-pricing fields as typed, effective-dated columns rather than free-text fields on the Pricing tab. These are TapDash''s own costs, which the merchant does not participate in, and they are calc inputs — dating them is not expressible in a jsonb blob at all.';
comment on column public.residual_merchant_vendor_costs.mid is
  'The STATEMENT MID (residual_lines.mid''s namespace), normalized digits-only per R3 — NOT the mutable record MID that R5b adjudicates against. Immutable, so nothing here can orphan when a merchant record changes; join as regexp_replace(l.mid,''[^0-9]'','''',''g'') = mid. Re-boarding under a new MID is the one uncovered case and is surfaced by residual_reference_coverage().';
comment on column public.residual_merchant_vendor_costs.rewards_volume_cost is
  'Unscaled decimal fraction (0.0035 = 0.35%), matching the R2 drawer percentage convention. Only a formatter ever scales it.';

-- ============================================================
-- 7. residual_partners — the partner entity
-- ============================================================
-- GRAIN: one row = one partner.
--
-- ENTITY AND ASSIGNMENT ONLY. Partners take their cut AFTER net revenue, and
-- the exact formula is explicitly NOT decided and explicitly out of R5c's
-- scope. Nothing here computes a payout, and no column holds one. What R5c
-- owes R5d is a stable identity for each partner and an unambiguous answer to
-- "who was this MID's partner in month M, at what split" — the two facts any
-- payout formula will need whichever way it is eventually written.
--
-- NOT auth.users. A partner is a counterparty, not an operator of this CRM:
-- "TapDash" and "H&H" are entities rather than people, and none of the six
-- needs to sign in. Modelling them as profiles would put non-users in the
-- assignee dropdowns and the @-mention list. If a partner later also needs a
-- login, that is a nullable user_id FK added then, not a reason to conflate the
-- two now.
--
-- CONFIRMED THERE IS NOTHING TO REUSE: the codebase has no partner, agent,
-- referrer or payee entity. lead_gen_agents is an AI agent (prompts,
-- mailboxes, extraction rules), unrelated. The four R4a attribution columns on
-- residual_lines (root_agent, agent_owner, agent, branch) are free text
-- carried verbatim from vendor files, documented in their own COMMENTs as
-- "Attribution only ... NOT a calculation input", and are deliberately left
-- alone — deriving a partner from them would make a vendor's spreadsheet
-- string the system of record for who gets paid.
create table if not exists public.residual_partners (
  id             uuid primary key default gen_random_uuid(),

  name           text not null
                   check (length(btrim(name)) between 1 and 120),

  -- citext, so 'a@b.com' and 'A@B.com' are one partner. Nullable: an entity
  -- partner may legitimately have no mailbox.
  email          citext,

  -- The split this partner is normally assigned at. NOT the split any
  -- calculation reads — see residual_mid_partners.split.
  default_split  numeric(14,6) not null default 0
                   check (default_split >= 0 and default_split <= 1),

  is_active      boolean not null default true,
  notes          text,

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id)
);

create unique index if not exists residual_partners_name_unique
  on public.residual_partners (lower(btrim(name)))
  where deleted_at is null;

create unique index if not exists residual_partners_email_unique
  on public.residual_partners (email)
  where deleted_at is null and email is not null;

drop trigger if exists residual_partners_set_updated_at
  on public.residual_partners;
create trigger residual_partners_set_updated_at
  before update on public.residual_partners
  for each row execute function public.tg_set_updated_at();

alter table public.residual_partners enable row level security;

drop policy if exists "residual_partners_select" on public.residual_partners;
create policy "residual_partners_select"
  on public.residual_partners
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_partners_insert" on public.residual_partners;
create policy "residual_partners_insert"
  on public.residual_partners
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_partners_update" on public.residual_partners;
create policy "residual_partners_update"
  on public.residual_partners
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_partners is
  'Partner counterparties. Entity only — no payout is computed or stored anywhere in R5c; the post-net-revenue formula is explicitly undecided and out of scope.';
comment on column public.residual_partners.default_split is
  'The split a NEW assignment is seeded from. Never read by a calculation: residual_mid_partners.split is, so editing this can never restate history.';

-- ============================================================
-- 8. residual_mid_partners — one partner per MID, over time
-- ============================================================
-- GRAIN: one row = one MID's partner assignment, valid over one half-open
-- month range.
--
-- WHAT HAPPENS WHEN A MID'S PARTNER CHANGES MID-HISTORY. Nothing is edited.
-- You close the standing row (set its effective_to to the first month the new
-- arrangement applies) and INSERT a successor from that month. Both rows
-- survive, the EXCLUDE guarantees they cannot both claim a month, and the
-- half-open convention guarantees they cannot leave one uncovered between them.
-- A recomputation of an earlier month therefore resolves the partner who was
-- actually on the account then, not the one on it now. Overwriting the row in
-- place — the only thing an undated design could do — silently restates every
-- prior month's payout, which for a counterparty payment is the worst
-- available failure.
--
-- "ONE PARTNER PER MID" IS ENFORCED, NOT ASSUMED. The EXCLUDE on (mid, range)
-- makes two simultaneous assignments unrepresentable. If a MID ever needs two
-- partners at once, that is a deliberate schema change (drop the EXCLUDE, add
-- the splits-sum-to-one invariant somewhere it can actually be checked) rather
-- than something that happens by accident on a Tuesday.
--
-- mid IS THE STATEMENT MID, for the reasons argued at length in section 6 and
-- not repeated here. The consequence specific to THIS table is worth stating
-- once, because the failure is a payment failure: a partner assignment cannot
-- orphan against a merchant record, because it never points at one. What it
-- CAN do is fail to cover a MID the merchant re-boarded onto, and nothing in
-- the schema can distinguish that from a MID that simply has no partner. So it
-- is detected rather than prevented — residual_reference_coverage() reports
-- every statement MID in a period with no partner assignment covering that
-- month, and "someone stops getting paid" becomes a row on a screen instead of
-- a silence.
--
-- SPLIT IS COPIED, NOT REFERENCED. residual_partners.default_split is the
-- value a new assignment is seeded FROM; this NOT NULL column is what any
-- calculation reads. The difference matters: if the calculation joined through
-- to the partner's current default, changing "Hershel Laufer: 0.3" to 0.35
-- next year would silently restate every closed month he was ever on. A copied
-- value cannot do that — a new split is a new dated row, like every other
-- change here.
create table if not exists public.residual_mid_partners (
  id              uuid primary key default gen_random_uuid(),

  mid             text not null
                    check (mid = regexp_replace(mid, '[^0-9]', '', 'g')
                           and length(mid) between 1 and 32),

  partner_id      uuid not null references public.residual_partners(id),

  -- Copied from residual_partners.default_split at assignment time. A share of
  -- a whole, hence [0,1] — 0 is legitimate and seeded (TapDash, H&H).
  split           numeric(14,6) not null
                    check (split >= 0 and split <= 1),

  effective_from  date not null
                    check (extract(day from effective_from) = 1),
  effective_to    date
                    check (effective_to is null
                           or extract(day from effective_to) = 1),

  notes           text,

  created_at      timestamptz not null default now(),
  created_by_id   uuid references auth.users(id),
  updated_at      timestamptz not null default now(),
  updated_by_id   uuid references auth.users(id),
  deleted_at      timestamptz,
  deleted_by_id   uuid references auth.users(id),

  constraint residual_mid_partners_range_ordered
    check (effective_to is null or effective_to > effective_from)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'residual_mid_partners_no_overlap'
  ) then
    alter table public.residual_mid_partners
      add constraint residual_mid_partners_no_overlap
      exclude using gist (
        mid                                     with =,
        daterange(effective_from, effective_to) with &&
      ) where (deleted_at is null);
  end if;
end$$;

create index if not exists residual_mid_partners_lookup
  on public.residual_mid_partners (mid, effective_from desc)
  where deleted_at is null;

create index if not exists residual_mid_partners_partner
  on public.residual_mid_partners (partner_id)
  where deleted_at is null;

drop trigger if exists residual_mid_partners_set_updated_at
  on public.residual_mid_partners;
create trigger residual_mid_partners_set_updated_at
  before update on public.residual_mid_partners
  for each row execute function public.tg_set_updated_at();

alter table public.residual_mid_partners enable row level security;

drop policy if exists "residual_mid_partners_select"
  on public.residual_mid_partners;
create policy "residual_mid_partners_select"
  on public.residual_mid_partners
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_mid_partners_insert"
  on public.residual_mid_partners;
create policy "residual_mid_partners_insert"
  on public.residual_mid_partners
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_mid_partners_update"
  on public.residual_mid_partners;
create policy "residual_mid_partners_update"
  on public.residual_mid_partners
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

comment on table public.residual_mid_partners is
  'One partner per MID, effective-dated. A partner change closes the standing row and inserts a successor; nothing is edited in place, so recomputing an earlier month resolves the partner who was actually on the account then.';
comment on column public.residual_mid_partners.mid is
  'The STATEMENT MID (residual_lines.mid''s namespace), normalized digits-only per R3 — deliberately not an FK to a merchant record. See section 6''s namespace note; uncovered MIDs are surfaced by residual_reference_coverage().';
comment on column public.residual_mid_partners.split is
  'COPIED from residual_partners.default_split at assignment time, never joined through to it. A copied value means editing a partner''s default cannot silently restate closed months.';

-- ============================================================
-- 9. The two read functions
-- ============================================================
-- BOTH ARE SECURITY DEFINER WITH AN INTERNAL auth_role() GATE, AND THAT PAIRING
-- IS LOAD-BEARING — CHANGE BOTH OR NEITHER.
--
-- Section 1-8 gate SELECT on all eight tables to admin/super_admin, following
-- R5a's section 6. R5a left residual_plan_code_buckets deliberately UNGATED
-- because residual_derive_plan_rollup is SECURITY INVOKER and LEFT JOINs it: a
-- gated table would have given a non-admin caller zero map rows, classified
-- every plan code as unmapped, and returned a wrong ANSWER dressed as a real
-- one.
--
-- The same hazard exists here and is closed the OTHER way R5a named as
-- correct: these functions are DEFINER, so their joins never depend on the
-- caller's role, and the gate is an explicit RAISE rather than an empty result.
-- If anyone ever makes one of them SECURITY INVOKER, the tables must be
-- ungated in the same change — otherwise a non-admin gets an empty rate set,
-- and an empty rate set is indistinguishable from a genuinely uncovered month.
--
-- The gate is written `is null or not in (...)` — the R5b idiom — because
-- auth_role() returns NULL for a service-role connection (auth.uid() is NULL),
-- and a bare `not in` against NULL evaluates to NULL, which an IF treats as
-- false and would let the call through unauthenticated. This fails closed.

-- ---------- 9a. the ONE lookup ----------
create or replace function public.residual_buy_rates_for_month(
  p_processor text,
  p_month     date
)
returns table (
  schedule_id                  uuid,
  risk_tier                    text,
  tapdash_share                numeric(14,6),
  fee_item_key                 text,
  fee_item_label               text,
  rate_kind                    text,
  billed_directly_to_merchant  boolean,
  rate                         numeric(14,6)
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_processor text := upper(btrim(coalesce(p_processor, '')));
  v_month     date := date_trunc('month', p_month)::date;
  v_schedule  uuid;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read template buy rates.'
      using errcode = '42501';
  end if;

  -- p_month is truncated rather than rejected: callers pass a period's
  -- statement_month, which residual_periods already pins to the 1st, and a
  -- caller who passes mid-month means the month containing that day. NULL is
  -- rejected explicitly rather than falling through to the not-covered raise,
  -- which would report a missing schedule for a month nobody asked about.
  if v_month is null then
    raise exception 'residual_buy_rates_for_month: p_month is required.'
      using errcode = '22004';
  end if;

  -- Exactly one schedule can cover a month (the EXCLUDE guarantees it), so
  -- this cannot silently pick one of several.
  select s.id into v_schedule
    from public.residual_buy_rate_schedules s
   where s.deleted_at is null
     and s.processor = v_processor
     and s.effective_from <= v_month
     and (s.effective_to is null or s.effective_to > v_month);

  -- A MISSING RATE MUST NEVER READ AS A ZERO RATE. Returning zero rows here
  -- would let R5d compute a total buy rate of 0.00 for an uncovered month and
  -- book the entire income as margin. Raising is the only safe empty case.
  if v_schedule is null then
    raise exception
      'No buy-rate schedule covers % for processor %.', v_month, v_processor
      using errcode = 'P0002',
            hint = 'Check residual_buy_rate_coverage() for uncovered months.';
  end if;

  return query
    select bt.schedule_id,
           bt.risk_tier,
           bt.tapdash_share,
           br.fee_item_key,
           fi.label,
           fi.rate_kind,
           fi.billed_directly_to_merchant,
           br.rate
      from public.residual_buy_rate_tiers bt
      join public.residual_buy_rates br
        on br.schedule_id = bt.schedule_id
       and br.risk_tier   = bt.risk_tier
       and br.deleted_at is null
      join public.residual_fee_items fi
        on fi.fee_item_key = br.fee_item_key
       and fi.deleted_at is null
     where bt.schedule_id = v_schedule
       and bt.deleted_at is null
     order by bt.risk_tier, fi.sort_order;
end;
$$;

comment on function public.residual_buy_rates_for_month(text, date) is
  'The ONE implementation of "which buy rates are in effect for statement month M". Raises rather than returning an empty set when no schedule covers the month, because a missing rate must never read as a zero rate. tapdash_share is returned as a per-tier scalar, never as another (fee_item_key, rate) pair.';

revoke all on function public.residual_buy_rates_for_month(text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_buy_rates_for_month(text, date)
  to authenticated;

-- ---------- 9b. the checkable coverage invariant ----------
-- Gaps cannot be prevented by a constraint — coverage is a property of a whole
-- set of ranges, and there is no moment at which a half-entered set is
-- invalid. So the invariant is made CHECKABLE instead, in the spirit of R5b's
-- last commit: one row per live statement period, saying whether a schedule
-- covers it. covered = false is a gap, and it is the query an admin screen and
-- a pre-flight test both run.
--
-- ============================================================
-- THIS FUNCTION CANNOT RETURN ZERO ROWS, AND THAT IS THE POINT
-- ============================================================
-- The first draft joined residual_periods and stopped there, which meant a
-- database with no live periods returned an empty set — rendering as "no
-- gaps" on any screen that counts `covered = false`, when what it actually
-- meant was "nothing was checked". That is the identical fail-quiet shape
-- 9a avoids by raising, arriving through the back door.
--
-- Raising is the wrong fix HERE. 9a raises because it is an INPUT to a
-- calculation and an empty rate set would be consumed as zeroes. This is a
-- REPORT, and a report that raises cannot be rendered next to the thing it is
-- reporting on — an admin screen would show an error page instead of "you have
-- no periods yet", which is a worse answer to a legitimate question.
--
-- So the empty case is given a ROW instead of an exception: statement_month
-- NULL, schedule_id NULL, covered FALSE. Three properties follow, and each was
-- chosen rather than fallen into:
--
--   * ZERO ROWS NOW MEANS SOMETHING ELSE. The result is non-empty by
--     construction, so a caller that gets nothing back knows the CALL failed,
--     not that the data is clean. The ambiguity is not merely reduced, it is
--     relocated to a case that cannot silently happen.
--
--   * covered IS FALSE, NOT NULL. NULL would read as "unknown", which is more
--     literally accurate and operationally worse: a caller filtering
--     `where not covered` evaluates `not NULL` to NULL, drops the row, and is
--     back to an empty result meaning "fine". FALSE keeps the sentinel inside
--     the one filter every caller will actually write.
--
--   * FALSE IS ALSO HONEST. "No periods exist" is a genuine blocker for R5d,
--     not a clean bill of health — there is nothing to compute over. A
--     pre-flight check should fail on it.
--
-- statement_month IS NULL is what distinguishes the sentinel from a real
-- uncovered month, so a UI can render "no statement periods yet" rather than
-- listing a gap for a month that does not exist.
create or replace function public.residual_buy_rate_coverage(
  p_processor text
)
returns table (
  statement_month  date,
  schedule_id      uuid,
  covered          boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_processor text := upper(btrim(coalesce(p_processor, '')));
  v_periods   integer;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read buy-rate coverage.'
      using errcode = '42501';
  end if;

  select count(*) into v_periods
    from public.residual_periods p
   where p.deleted_at is null;

  -- Nothing to check is not the same as nothing wrong. See the note above.
  if v_periods = 0 then
    return query select null::date, null::uuid, false;
    return;
  end if;

  -- The LEFT JOIN cannot multiply rows: the EXCLUDE constraint makes at most
  -- one live schedule match any given month.
  return query
    select p.statement_month,
           s.id,
           (s.id is not null)
      from public.residual_periods p
      left join public.residual_buy_rate_schedules s
        on s.deleted_at is null
       and s.processor = v_processor
       and s.effective_from <= p.statement_month
       and (s.effective_to is null or s.effective_to > p.statement_month)
     where p.deleted_at is null
     order by p.statement_month;
end;
$$;

comment on function public.residual_buy_rate_coverage(text) is
  'One row per live statement period with the schedule covering it, or covered=false. Gaps cannot be forbidden by a constraint, so they are made detectable instead. NEVER returns zero rows: with no live periods it returns a single sentinel (statement_month NULL, covered FALSE) so that "nothing checked" cannot render as "no gaps" — an empty result therefore means the call failed.';

revoke all on function public.residual_buy_rate_coverage(text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_buy_rate_coverage(text)
  to authenticated;

-- ---------- 9c. per-MID reference coverage ----------
-- The counterpart to 9b, one level down. 9b answers "do we have RATES for this
-- month"; this answers "do we have PER-MERCHANT reference data for the MIDs
-- this month actually contains" — vendor costs and a partner assignment,
-- resolved for the period's own statement month.
--
-- THIS IS THE DETECTOR THE MID-KEYING DECISION OWES. Section 6 argues that
-- keying on the immutable statement MID makes these rows unable to orphan
-- against a merchant record, and that the one failure left standing is a
-- merchant RE-BOARDING onto a new MID — MID B starts appearing in statements
-- while the vendor costs and the partner sit on MID A. No constraint can catch
-- that: MID B is a perfectly valid MID that simply has no reference rows, and
-- so is every genuinely new merchant. It is a reporting question, so it gets a
-- report, and for the partner half the stake is that "someone stops getting
-- paid" becomes a row on a screen instead of a silence.
--
-- BOTH DIRECTIONS, ONE RESULT SET. The MID set is the UNION of the period's
-- statement MIDs and the MIDs of reference rows in effect that month, so:
--   in_statements = false  -> a reference row for a MID this period never
--                             carried: a typo, a stale assignment left behind
--                             by a re-boarding, or a merchant boarded ahead of
--                             its first statement.
--   has_vendor_costs/has_partner = false
--                          -> a MID being billed with no reference data.
-- Reporting only one direction would have made the re-boarding case look like
-- two unrelated findings instead of the matched pair it is.
--
-- merchant_thread_id / merchant_match ARE DERIVED LIVE, NEVER STORED, and come
-- from residual_resolve_mid — the same kernel R5b's commit path and relink
-- trigger call. Two things follow. It gives an operator the merchant record
-- for context without the CALCULATION depending on it, which is the whole
-- point of the namespace split. And it honours R5b's own rule that staleness
-- is derived rather than stored: a cached thread_id on these tables would be a
-- second copy of a fact R5b already owns, and copying it is how the two would
-- come to disagree. Calling the kernel needs no grant — it is SECURITY
-- DEFINER, the owner retains EXECUTE, and this body runs as the owner.
--
-- SAME NON-EMPTY GUARANTEE AS 9b: this function never returns zero rows, so
-- "nothing to check" can never render as "everything is covered". The sentinel
-- is mid NULL with every flag false.
--
-- THE SENTINEL'S CONDITION IS NARROWER THAN "A PERIOD WITH NO LINES", AND THE
-- TWO ARE EASY TO CONFUSE. It fires only when the ENTIRE MID UNION is empty:
-- no statement MIDs in the period AND no vendor-cost or partner rows in effect
-- for its month. On any database carrying reference rows that cover that month,
-- a line-less period returns THOSE rows with in_statements = false rather than
-- the sentinel — because there genuinely is something to report: reference data
-- pointing at a MID the period never carried, which is the stale-assignment and
-- boarded-ahead-of-first-statement signal this function exists to surface.
--
-- Both behaviours are correct. They are simply not the same condition, and an
-- earlier version of this comment said "a period with no lines and no reference
-- rows" as though they coincided. That phrasing duly misled the first test
-- written against it, which asserted the sentinel for a line-less period on a
-- database that had vendor costs in effect and got three rows instead of one.
-- The test was wrong and this comment is why, so the comment is now explicit.
--
-- A BAD period id does raise, though — an id that names no live period is a
-- caller error, not a finding, and reporting it as "nothing to see" would hide
-- a bug in the caller.
create or replace function public.residual_reference_coverage(
  p_period_id uuid
)
returns table (
  mid                 text,
  in_statements       boolean,
  has_vendor_costs    boolean,
  has_partner         boolean,
  merchant_record_id  uuid,
  merchant_match      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month date;
  v_mids  text[];
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read residual reference coverage.'
      using errcode = '42501';
  end if;

  select p.statement_month into v_month
    from public.residual_periods p
   where p.id = p_period_id
     and p.deleted_at is null;

  if v_month is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  -- Collected into an ARRAY rather than a temp table on purpose: this function
  -- is STABLE, and PostgreSQL rejects an INSERT (temp table or not) inside a
  -- non-volatile function. Aggregating once into a variable also keeps the
  -- three-way UNION written exactly once — a second copy for a row count would
  -- be a predicate that can drift out of step with the one that produces the
  -- rows, which is the failure this file avoids everywhere else.
  select coalesce(array_agg(distinct m.mid), '{}'::text[])
    into v_mids
    from (
      select regexp_replace(l.mid, '[^0-9]', '', 'g') as mid
        from public.residual_lines l
       where l.period_id = p_period_id
         and l.deleted_at is null
      union
      select v.mid
        from public.residual_merchant_vendor_costs v
       where v.deleted_at is null
         and v.effective_from <= v_month
         and (v.effective_to is null or v.effective_to > v_month)
      union
      select mp.mid
        from public.residual_mid_partners mp
       where mp.deleted_at is null
         and mp.effective_from <= v_month
         and (mp.effective_to is null or mp.effective_to > v_month)
    ) m
   where m.mid <> '';

  -- Nothing to check is not the same as nothing wrong — the 9b rule.
  if cardinality(v_mids) = 0 then
    return query select null::text, false, false, false, null::uuid, null::text;
    return;
  end if;

  return query
    select a.mid,
           exists (
             select 1 from public.residual_lines l
              where l.period_id = p_period_id
                and l.deleted_at is null
                and regexp_replace(l.mid, '[^0-9]', '', 'g') = a.mid
           ),
           exists (
             select 1 from public.residual_merchant_vendor_costs v
              where v.deleted_at is null
                and v.mid = a.mid
                and v.effective_from <= v_month
                and (v.effective_to is null or v.effective_to > v_month)
           ),
           exists (
             select 1 from public.residual_mid_partners mp
              where mp.deleted_at is null
                and mp.mid = a.mid
                and mp.effective_from <= v_month
                and (mp.effective_to is null or mp.effective_to > v_month)
           ),
           r.record_id,
           r.match_kind
      from unnest(v_mids) as a(mid)
      left join lateral public.residual_resolve_mid(a.mid) r on true
     order by a.mid;
end;
$$;

comment on function public.residual_reference_coverage(uuid) is
  'Per-MID reference-data coverage for one statement period: which of the period''s MIDs have vendor costs and a partner assignment in effect that month, and which reference rows point at MIDs the period never carried. This is the detector the statement-MID keying decision owes — a merchant re-boarding onto a new MID cannot be caught by a constraint, and for the partner half the alternative to this report is someone silently stopping getting paid. The merchant link is resolved LIVE through residual_resolve_mid and never stored, so the calculation stays in the statement-MID namespace while an operator still sees the record. NEVER returns zero rows: the mid-NULL sentinel fires only when the ENTIRE MID union is empty (no statement MIDs AND no reference rows in effect for the month) — a line-less period on a database that has reference rows covering that month returns those rows with in_statements = false instead, which is a different condition and not a bug. A bad period id raises.';

revoke all on function public.residual_reference_coverage(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_reference_coverage(uuid)
  to authenticated;

-- ============================================================
-- 10. SEEDS
-- ============================================================
-- WHAT IS SEEDED: the vocabularies and the one buy-rate schedule that came out
-- of the workbook — 4 risk tiers, 11 fee items, 1 MAVERICK schedule, its 4 tier
-- shares, its 44 rates, and the 6 partners.
--
-- WHAT AN ADMIN ENTERS: every per-MID row. residual_merchant_vendor_costs and
-- residual_mid_partners are seeded with NOTHING, because the workbook gives no
-- per-MID vendor costs or partner assignments and inventing them would put
-- fabricated cost data into a money calculation.
--
-- RE-RUN BEHAVIOUR: every insert is guarded by `where not exists` on the row's
-- NATURAL key, and nothing here UPDATEs. A second run inserts what is missing
-- and touches nothing that is present, so an admin's correction to a seeded
-- rate SURVIVES a re-run. Seeds are a floor, not a reset. The corollary is
-- that a seed can never be used to CHANGE a value later — that is a new dated
-- schedule, which is the whole point of section 3.

-- ---------- 10a. risk tiers ----------
-- The drawer_option strings are EXACTLY R2's four seeded options. Verified
-- against 20260821120000_residuals_pricing_drawer_r2.sql:
--   '{"options":["No risk","Low risk","Moderate risk","High risk"]}'
-- The statement_code integers are confirmed empirically against the sample:
--   Budget Max            risk 1 -> Low:    38 auths x 0.02   = 0.76  = Agent Expense
--   Elite Personal Chefs  risk 2 -> Medium: 20134.70 x 0.0015 = 30.20 = Agent Expense
insert into public.residual_risk_tiers
  (tier_key, drawer_option, statement_code, label, sort_order)
select v.tier_key, v.drawer_option, v.statement_code, v.label, v.sort_order
from (values
  ('no_program', 'No risk',       null::integer, 'No Buy Rate Program', 10),
  ('low',        'Low risk',      1,             'Low Risk',            20),
  ('medium',     'Moderate risk', 2,             'Medium Risk',         30),
  ('high',       'High risk',     3,             'High Risk',           40)
) as v(tier_key, drawer_option, statement_code, label, sort_order)
where not exists (
  select 1 from public.residual_risk_tiers t where t.tier_key = v.tier_key
);

-- ---------- 10b. fee items ----------
-- rate_kind is read off the workbook's own magnitudes and confirmed by the two
-- worked examples above: VMD Auth Fee 0.02 is two cents per auth ('amount'),
-- Amex Optblue 0.0015 is fifteen basis points of Amex volume ('rate').
--
-- LABELS ARE THE WORKBOOK'S EXACT TEXT, PARENTHETICALS INCLUDED. The calc
-- sheet's formula registry names fee items, so a shortened label is a join
-- miss waiting to happen — which is why "Monthly Online Access Fee (includes
-- white label fee)" is seeded in full rather than trimmed to the part that
-- reads like a name. fee_item_key stays the short canonical slug: the key is
-- OURS and never appears in the workbook, so it is free to be terse, and
-- keeping the two independent means a future label correction is a one-column
-- UPDATE rather than a re-key of every rate row.
--
-- ALL 11 LABELS VERIFIED CHARACTER-FOR-CHARACTER AGAINST THE TEMPLATE BUY
-- RATES SHEET ON 2026-09-07. Only monthly_online_access_fee needed correcting.
--
-- 'Chargeback' HAS NO "Fee" SUFFIX, AND THAT IS NOT A TYPO — DO NOT "FIX" IT.
-- R2 seeded a subtab-1 drawer field labelled 'Chargeback Fee'
-- (20260821120000_residuals_pricing_drawer_r2.sql), and the mismatch between
-- the two is the first thing a careful reader will want to tidy up. They are
-- different sheets describing different things — the drawer field is what the
-- merchant is charged, this is the buy-rate line — and the workbook spells
-- them differently. They need not agree and do not. Since label is a join
-- surface (see the unique index in section 2), "correcting" this one would
-- break the very match it looks like it would fix.
--
-- 'VMD BIN' and 'Amex Optblue' were checked on the same pass for the same
-- reason — both read like abbreviations that could carry a trailing qualifier.
-- Neither does. Exact workbook text.
insert into public.residual_fee_items
  (fee_item_key, label, rate_kind, billed_directly_to_merchant, sort_order)
select v.fee_item_key, v.label, v.rate_kind, v.billed, v.sort_order
from (values
  ('pci_fee',                   'PCI Fee',                                            'amount', true,  10),
  ('vmd_bin',                   'VMD BIN',                                            'rate',   false, 20),
  ('vmd_auth_fee',              'VMD Auth Fee',                                       'amount', false, 30),
  ('avs_fee',                   'AVS Fee',                                            'amount', false, 40),
  ('monthly_fee',               'Monthly Fee',                                        'amount', false, 50),
  ('amex_optblue',              'Amex Optblue',                                       'rate',   false, 60),
  ('monthly_online_access_fee', 'Monthly Online Access Fee (includes white label fee)','amount', false, 70),
  ('batch_fee',                 'Batch Fee',                                          'amount', false, 80),
  ('website_monitoring_fee',    'Website Monitoring Fee',                             'amount', true,  90),
  ('irs_annual_fee',            'IRS Annual Fee',                                     'amount', true, 100),
  ('chargeback',                'Chargeback',                                         'amount', false,110)
) as v(fee_item_key, label, rate_kind, billed, sort_order)
where not exists (
  select 1 from public.residual_fee_items f where f.fee_item_key = v.fee_item_key
);

-- ---------- 10c. the MAVERICK schedule ----------
-- EFFECTIVE_FROM IS A FLOOR SENTINEL, AND THAT IS AN ASSUMPTION ON RECORD.
-- The workbook states no start date. Three options were available and only one
-- is honest:
--   * pick a month (e.g. the arc's first statement month) — fabricates a fact
--     the source does not contain;
--   * compute it from the earliest live residual_periods row — makes the seed
--     non-deterministic across environments, so the test DB and production
--     disagree about a financial boundary;
--   * a FLOOR — asserts only "as far back as this system holds data, these were
--     the rates", which is exactly what we believe and nothing more.
-- 2000-01-01 is the floor. Every existing and backfilled period resolves, and
-- an admin closes this schedule and opens a dated successor the first time
-- Maverick actually revises the table.
--
-- OPEN QUESTION FOR THE USER: if the real effective date IS known, say so
-- before this is applied — changing it afterwards means closing this schedule
-- and re-seeding, which is more work than editing one literal now.
insert into public.residual_buy_rate_schedules
  (processor, label, effective_from, effective_to, notes)
select 'MAVERICK',
       'Maverick Template Buy Rates (as supplied)',
       date '2000-01-01',
       null,
       'Seeded from the supplied workbook. effective_from is a floor sentinel: the workbook states no start date, so this asserts only that these rates held for as far back as this system holds data.'
where not exists (
  select 1 from public.residual_buy_rate_schedules s
  where s.processor = 'MAVERICK'
    and s.effective_from = date '2000-01-01'
    and s.deleted_at is null
);

-- ---------- 10d. tier shares (the Percentage row) ----------
-- 0.9 / 0.9 / 0.8 / 0.7 — TapDash's share of (Total Income - Total Buy Rate).
insert into public.residual_buy_rate_tiers (schedule_id, risk_tier, tapdash_share)
select s.id, v.risk_tier, v.share
from (values
  ('no_program', 0.900000::numeric(14,6)),
  ('low',        0.900000::numeric(14,6)),
  ('medium',     0.800000::numeric(14,6)),
  ('high',       0.700000::numeric(14,6))
) as v(risk_tier, share)
cross join (
  select id from public.residual_buy_rate_schedules
  where processor = 'MAVERICK' and effective_from = date '2000-01-01'
    and deleted_at is null
  limit 1
) s
where not exists (
  select 1 from public.residual_buy_rate_tiers bt
  where bt.schedule_id = s.id and bt.risk_tier = v.risk_tier
);

-- ---------- 10e. the 11 x 4 rates ----------
-- Transcribed verbatim from the workbook. Column order:
--   no_program | low | medium | high
--
-- ONE VALUE WORTH KNOWING ABOUT, VERIFIED: VMD BIN reads
-- 0 / 0.0002 / 0.0002 / 0.002. The 10x jump from Medium to High is out of line
-- with every other item's progression — every other row climbs by a factor
-- under 3 — and it was queried during review on exactly that suspicion.
--
-- IT IS GENUINE. Confirmed against the calc sheet on 2026-09-07: the High-risk
-- BIN rate really is ten times the Medium one, not a slipped decimal for
-- 0.0004. The observation stands and is left here deliberately, because the
-- next reader will notice the same discontinuity and should find out it has
-- already been checked rather than re-open it or, worse, "round" it into line
-- with its neighbours.
insert into public.residual_buy_rates (schedule_id, risk_tier, fee_item_key, rate)
select s.id, v.risk_tier, v.fee_item_key, v.rate
from (values
  ('no_program','pci_fee',                    0.000000::numeric(14,6)),
  ('low',       'pci_fee',                    5.000000::numeric(14,6)),
  ('medium',    'pci_fee',                    5.000000::numeric(14,6)),
  ('high',      'pci_fee',                    5.000000::numeric(14,6)),

  ('no_program','vmd_bin',                    0.000000::numeric(14,6)),
  ('low',       'vmd_bin',                    0.000200::numeric(14,6)),
  ('medium',    'vmd_bin',                    0.000200::numeric(14,6)),
  ('high',      'vmd_bin',                    0.002000::numeric(14,6)),

  ('no_program','vmd_auth_fee',               0.000000::numeric(14,6)),
  ('low',       'vmd_auth_fee',               0.020000::numeric(14,6)),
  ('medium',    'vmd_auth_fee',               0.030000::numeric(14,6)),
  ('high',      'vmd_auth_fee',               0.050000::numeric(14,6)),

  ('no_program','avs_fee',                    0.010000::numeric(14,6)),
  ('low',       'avs_fee',                    0.010000::numeric(14,6)),
  ('medium',    'avs_fee',                    0.020000::numeric(14,6)),
  ('high',      'avs_fee',                    0.040000::numeric(14,6)),

  ('no_program','monthly_fee',                0.000000::numeric(14,6)),
  ('low',       'monthly_fee',                4.000000::numeric(14,6)),
  ('medium',    'monthly_fee',                4.000000::numeric(14,6)),
  ('high',      'monthly_fee',                7.000000::numeric(14,6)),

  ('no_program','amex_optblue',               0.001000::numeric(14,6)),
  ('low',       'amex_optblue',               0.001000::numeric(14,6)),
  ('medium',    'amex_optblue',               0.001500::numeric(14,6)),
  ('high',      'amex_optblue',               0.002000::numeric(14,6)),

  ('no_program','monthly_online_access_fee',  0.000000::numeric(14,6)),
  ('low',       'monthly_online_access_fee',  6.500000::numeric(14,6)),
  ('medium',    'monthly_online_access_fee',  8.000000::numeric(14,6)),
  ('high',      'monthly_online_access_fee', 12.500000::numeric(14,6)),

  ('no_program','batch_fee',                  0.000000::numeric(14,6)),
  ('low',       'batch_fee',                  0.010000::numeric(14,6)),
  ('medium',    'batch_fee',                  0.025000::numeric(14,6)),
  ('high',      'batch_fee',                  0.040000::numeric(14,6)),

  ('no_program','website_monitoring_fee',    15.000000::numeric(14,6)),
  ('low',       'website_monitoring_fee',    15.000000::numeric(14,6)),
  ('medium',    'website_monitoring_fee',    15.000000::numeric(14,6)),
  ('high',      'website_monitoring_fee',    15.000000::numeric(14,6)),

  ('no_program','irs_annual_fee',             1.950000::numeric(14,6)),
  ('low',       'irs_annual_fee',             1.950000::numeric(14,6)),
  ('medium',    'irs_annual_fee',             1.950000::numeric(14,6)),
  ('high',      'irs_annual_fee',             1.950000::numeric(14,6)),

  ('no_program','chargeback',                10.000000::numeric(14,6)),
  ('low',       'chargeback',                15.000000::numeric(14,6)),
  ('medium',    'chargeback',                20.000000::numeric(14,6)),
  ('high',      'chargeback',                25.000000::numeric(14,6))
) as v(risk_tier, fee_item_key, rate)
cross join (
  select id from public.residual_buy_rate_schedules
  where processor = 'MAVERICK' and effective_from = date '2000-01-01'
    and deleted_at is null
  limit 1
) s
where not exists (
  select 1 from public.residual_buy_rates br
  where br.schedule_id = s.id
    and br.risk_tier = v.risk_tier
    and br.fee_item_key = v.fee_item_key
    and br.deleted_at is null
);

-- ---------- 10f. partners ----------
-- The six names and splits from the workbook. TapDash and H&H at 0 are seeded
-- as supplied: a 0 split is a real arrangement, not a missing value, and
-- omitting them would lose the fact that these are partners at all.
insert into public.residual_partners (name, default_split)
select v.name, v.split
from (values
  ('Gershy Tress',     0.500000::numeric(14,6)),
  ('Chaim Birnhack',   0.500000::numeric(14,6)),
  ('Mendy Blobstein',  0.500000::numeric(14,6)),
  ('Hershel Laufer',   0.300000::numeric(14,6)),
  ('TapDash',          0.000000::numeric(14,6)),
  ('H&H',              0.000000::numeric(14,6))
) as v(name, split)
where not exists (
  select 1 from public.residual_partners p
  where lower(btrim(p.name)) = lower(btrim(v.name)) and p.deleted_at is null
);

-- ============================================================
-- MIGRATION SAFETY
-- ============================================================
-- PURELY ADDITIVE. Nothing is dropped. Nothing is retyped. No existing table
-- gains a column. No existing policy, view, trigger or function is replaced.
-- No existing row is read or written by any statement in this file. Three
-- pre-existing objects are READ, and only from inside a function body that
-- runs on demand: residual_periods and residual_lines by the two coverage
-- functions, and residual_resolve_mid (R5b's kernel) by 9c.
--
-- CALLING R5b's KERNEL IS NOT A CHANGE TO IT. 9c calls residual_resolve_mid;
-- it does not CREATE OR REPLACE it, does not alter its grants, and adds no
-- caller that writes. R5b's kernel stays granted to no client role and reached
-- only from SECURITY DEFINER bodies, which is exactly the containment its own
-- header specifies. The alternative — reimplementing MID resolution inline —
-- would have been the second copy R5b explicitly forbids.
--
-- NO DEPLOY-ORDERING HAZARD. Nothing in the app reads any of these objects, so
-- unlike R5a (which dropped the 3-arg commit_residual_pdf_import and had to
-- ship with its caller) this migration can be applied before, with, or after
-- its app code, in either order, with no window in which anything fails.
--
-- THE ONE THING TO VERIFY BEFORE APPLYING: `create extension btree_gist`. It
-- is available on Supabase but is NOT installed by default, so this statement
-- genuinely creates it, unqualified, into the first schema of the postgres
-- role's search_path (public on Supabase). Two consequences:
--   * it is a database-level object, so it survives and is shared — dropping
--     it later would break three EXCLUDE constraints;
--   * the EXCLUDE constraints depend on its operator classes being VISIBLE at
--     DDL time. They are resolved and stored at constraint-creation, so a later
--     search_path change cannot break them, but a failure to create the
--     extension fails this whole migration in its transaction — which is the
--     correct outcome, not a silent degradation.
-- If btree_gist is unavailable on the target for any reason, the fallback is a
-- BEFORE INSERT OR UPDATE trigger per table. It is strictly worse (racy under
-- concurrency, as section 0 explains) and should be taken only under protest.
--
-- ROLLBACK, if it comes to that: drop the three functions
-- (residual_buy_rates_for_month, residual_buy_rate_coverage,
-- residual_reference_coverage) and the eight tables in reverse dependency
-- order (buy_rates, buy_rate_tiers, buy_rate_schedules, mid_partners,
-- partners, merchant_vendor_costs, fee_items, risk_tiers). No other object
-- references them — in particular nothing in R5b references anything here, so
-- dropping these cannot affect the merchant-link machinery. Leave btree_gist.

commit;
