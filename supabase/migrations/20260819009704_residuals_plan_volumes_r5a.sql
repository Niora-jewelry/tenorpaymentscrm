-- Ported from Daniel Weissman's residuals branch, file
-- `20260825120000_residuals_plan_volumes_r5a.sql`.
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
-- Residuals R5a — plan-code volume substrate
-- ============================================================
--
-- Five things:
--   0. RLS role gates on every residual table that holds merchant data or
--      money (section 6). Until now their SELECT policies were open to any
--      authenticated user; only the admin layout's requireSuperAdmin() stood
--      in the way. R5 writes splits and net income into these tables, so the
--      gate goes in before the money does.
--   1. residual_plan_code_buckets — the plan_code -> volume bucket map,
--      MOVED out of TypeScript (lib/residuals/pdf-layout.ts ROLLUP) into a
--      seeded, admin-editable table.
--   2. residual_plan_volumes — per (period, mid, plan_code) detail rows, so
--      the four dollar buckets become DERIVABLE rather than asserted, and so
--      transaction counts have somewhere to land.
--   3. residual_merchant_volumes gains the derived-rollup siblings:
--      stated_total, stated_item_count, reconciled, unmapped_volume, and four
--      per-bucket item counts.
--   4. residual_derive_plan_rollup (the shared, write-free derivation) and a
--      rebuilt commit_residual_pdf_import that receives PLAN ROWS and derives
--      the buckets itself with a SQL GROUP BY.
--
-- WHY: R4b handed the database finished bucket totals that JavaScript had
-- summed (lib/residuals/pdf-parser.ts:254-281, an integer-cent accumulator),
-- and threw away planRows[], statedTotal and unmappedCodes[] afterwards. Three
-- consequences this migration removes:
--   * the house rule "every sum happens in SQL" was broken on the write path;
--   * the buckets were unauditable — nothing behind them to re-derive from;
--   * an unmapped plan code destroyed a perfectly good extraction and forced a
--     code change, a deploy, AND a re-upload.
--
-- MONEY RULE (unchanged from R1b): every dollar amount is numeric(14,2), every
-- rate numeric(14,6). No float anywhere. Sums happen here, in SQL.
--
-- COUNT RULE (new): a transaction count is a whole number of transactions, so
-- it is `integer`, not numeric. It is NULLABLE — see the note on
-- residual_plan_volumes.item_count for the empirical reason.
--
-- Idempotent: re-runnable (if-not-exists / drop-and-readd guards throughout).

begin;

-- ============================================================
-- 1. residual_plan_code_buckets
-- ============================================================
-- GRAIN: one row = one plan code -> one volume bucket.
--
-- WHY THIS LEAVES TYPESCRIPT. The map was a frozen constant in
-- lib/residuals/pdf-layout.ts. Two things force it into the database:
--
--   a) The commit RPC now does the rollup as a SQL GROUP BY, so SQL needs the
--      classification. The alternative — having the caller send a resolved
--      bucket per row — would put the classification back in JS and make the
--      "resolve an unmapped code later" workflow impossible without a re-parse.
--
--   b) Resolving an unmapped code is OPERATIONAL, not a code change. Under the
--      TS constant, adding `PP -> vmd_volume` needed an edit, a review, a
--      deploy and a re-upload. That is barely better than the re-upload it was
--      meant to replace. Here it is one admin INSERT, after which the existing
--      plan rows can be re-derived in place.
--
-- This follows the house rule that behaviour-driving vocabularies live in
-- admin tables rather than hardcoded (CLAUDE.md, "Do not hardcode dropdown
-- values that should come from the admin Presets table"). It gets its OWN
-- table rather than a presets category for the same reason
-- residual_column_mappings did: presets is a single-value vocabulary and this
-- is a two-column mapping with a constrained target.
--
-- NOT THE RESIDUAL_TARGET_COLUMNS PRECEDENT. That mirror (lib/residuals/
-- mapping.ts:31 <-> the CHECK on residual_column_mappings.target_column) is
-- safe to duplicate because SQL is authoritative and drift surfaces instantly
-- as a 23514. Drift in a ROLLUP duplicate would instead produce a SILENTLY
-- DIFFERENT rollup between preview and commit. That failure mode does not
-- tolerate a copy, so there is exactly one copy and it is this table.
--
-- DELIBERATELY NOT SEEDED — V$, M$, D$ (cash advance) and PP (PayPal). Their
-- absence is still meaningful, but the MEANING HAS CHANGED: under R4b an
-- unmapped code with volume aborted the import. From R5a it lands as a plan
-- row with volume_bucket IS NULL, the merchant's buckets are withheld (left
-- NULL, not partial), and reconciled is set false. Nothing silently
-- under-counts, and the extraction survives for a human to resolve.

create table if not exists public.residual_plan_code_buckets (
  id             uuid primary key default gen_random_uuid(),

  -- Uppercase-pinned: the join in residual_derive_plan_rollup is a plain
  -- equality against the statement's own token, and a lowercase row would
  -- silently never match. Enforced rather than trusted.
  plan_code      text not null
                   check (plan_code = upper(btrim(plan_code))
                          and length(plan_code) between 1 and 8),

  volume_bucket  text not null
                   check (volume_bucket in (
                     'amex_volume','vmd_volume','debit_volume','ebt_volume'
                   )),

  -- Why this code maps where it does. Free text, for the admin UI.
  notes          text,

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id)
);

-- One live mapping per code. Partial, so a retired mapping does not block its
-- replacement (the residual_column_mappings precedent).
create unique index if not exists residual_plan_code_buckets_code_unique
  on public.residual_plan_code_buckets (plan_code)
  where deleted_at is null;

drop trigger if exists residual_plan_code_buckets_set_updated_at
  on public.residual_plan_code_buckets;
create trigger residual_plan_code_buckets_set_updated_at
  before update on public.residual_plan_code_buckets
  for each row execute function public.tg_set_updated_at();

alter table public.residual_plan_code_buckets enable row level security;

-- ------------------------------------------------------------
-- DELIBERATELY UNGATED — DO NOT ADD auth_role() HERE
-- ------------------------------------------------------------
-- Section 6 tightens SELECT to admin/super_admin on every other residual
-- table. This one is the deliberate exception, and the reason is a
-- SILENT-WRONG-ANSWER hazard, not laxity.
--
-- residual_derive_plan_rollup is SECURITY INVOKER and LEFT JOINs this table.
-- Under a role gate, a non-admin caller would see ZERO map rows, every LEFT
-- JOIN would miss, and the function would classify EVERY plan code as
-- unmapped and return reconciled=false. That is a wrong ANSWER dressed as a
-- real one — strictly worse than a permission error, because nothing raises
-- and the caller has no way to tell a genuinely unreconciled statement from
-- an RLS artifact.
--
-- It is safe to leave open: this table holds a plan-code vocabulary
-- ('VS' -> vmd_volume). No merchant identity, no MID, no money, no amounts.
-- An open read leaks a list of card-plan abbreviations.
--
-- If a future slice genuinely must restrict it, the correct fix is to make
-- residual_derive_plan_rollup SECURITY DEFINER (so the map lookup stops
-- depending on the caller's role) — NOT to gate the table and leave the
-- function invoker. Change both or neither.
drop policy if exists "residual_plan_code_buckets_select"
  on public.residual_plan_code_buckets;
create policy "residual_plan_code_buckets_select"
  on public.residual_plan_code_buckets
  for select to authenticated
  using (deleted_at is null);

drop policy if exists "residual_plan_code_buckets_insert"
  on public.residual_plan_code_buckets;
create policy "residual_plan_code_buckets_insert"
  on public.residual_plan_code_buckets
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_plan_code_buckets_update"
  on public.residual_plan_code_buckets;
create policy "residual_plan_code_buckets_update"
  on public.residual_plan_code_buckets
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

-- No DELETE policy: retirement is a soft delete, which per the
-- project_soft_delete_pattern must run through the service-role admin client.

-- ---------- seed: the 16 codes R4b locked ----------
-- Transcribed verbatim from ROLLUP in lib/residuals/pdf-layout.ts:143-164 and
-- pinned by the test at pdf-parser.test.ts:591. Insert-where-not-exists so a
-- re-run never disturbs an admin's later edits.
insert into public.residual_plan_code_buckets (plan_code, volume_bucket, notes)
select v.plan_code, v.volume_bucket, v.notes
from (values
  ('AM', 'amex_volume',  'Amex.'),
  ('EB', 'ebt_volume',   'EBT.'),

  ('VD', 'debit_volume', 'Visa debit.'),
  ('MD', 'debit_volume', 'MasterCard debit.'),
  ('DD', 'debit_volume', 'Discover debit.'),
  ('DB', 'debit_volume', 'Debit.'),

  ('VS', 'vmd_volume',   'Visa sale.'),
  ('VB', 'vmd_volume',   'Visa business.'),
  ('MC', 'vmd_volume',   'MasterCard.'),
  ('MB', 'vmd_volume',   'MasterCard business.'),
  ('DS', 'vmd_volume',   'Discover sale.'),
  ('DZ', 'vmd_volume',   'Discover.'),
  ('DJ', 'vmd_volume',   'Discover JCB.'),
  ('JC', 'vmd_volume',   'JCB.'),
  ('VL', 'vmd_volume',   'Visa large ticket - settles as ordinary V/MC volume.'),
  ('ML', 'vmd_volume',   'MasterCard large ticket - settles as ordinary V/MC volume.')
) as v(plan_code, volume_bucket, notes)
where not exists (
  select 1 from public.residual_plan_code_buckets b
  where b.plan_code = v.plan_code and b.deleted_at is null
);

-- ============================================================
-- 2. residual_plan_volumes
-- ============================================================
-- GRAIN: one row = one plan code, for one MID, in one statement month.
--
-- This is the substrate residual_merchant_volumes' four buckets are rolled up
-- FROM. Both grains are kept on purpose, exactly as R1b kept residual_lines
-- and residual_merchant_volumes apart: the Tab-2 grid and the R5 engine read
-- at (period, mid), and making every one of those reads re-aggregate the plan
-- rows would be strictly worse. The rollup is materialized by ONE writer (the
-- commit RPC below), which is what makes duplicating it safe here and unsafe
-- in the case R1b rejected.
--
-- mid is TEXT and deliberately not an FK, matching residual_lines.mid and
-- residual_merchant_volumes.mid. The RPC normalizes it with the R3 digits-only
-- expression before insert, so it is canonical by construction.

create table if not exists public.residual_plan_volumes (
  id             uuid primary key default gen_random_uuid(),
  period_id      uuid not null references public.residual_periods(id),
  import_id      uuid references public.residual_imports(id),

  mid            text not null,

  plan_code      text not null
                   check (plan_code = upper(btrim(plan_code))
                          and length(plan_code) between 1 and 8),

  -- The bucket this code resolved to AT IMPORT TIME. A materialized join
  -- against residual_plan_code_buckets, not an independent fact: only the
  -- derive/re-derive RPC may write it, and it must always agree with the
  -- rolled-up totals on residual_merchant_volumes. Storing it (rather than
  -- re-joining on every read) is what makes those two consistent — a fresh
  -- join beside a stale materialized total would be incoherent.
  --
  -- NULL = this code is not in the map. The row still lands; see the
  -- fail-loud note on residual_plan_code_buckets.
  volume_bucket  text
                   check (volume_bucket is null or volume_bucket in (
                     'amex_volume','vmd_volume','debit_volume','ebt_volume'
                   )),

  -- Amount of Sales for this plan row. NOT NULL: interpretStatement refuses
  -- the whole statement when a plan row's amount cannot be read
  -- (pdf-parser.ts:203-211), so a row with no amount is a parse failure and
  -- never reaches storage.
  amount         numeric(14,2) not null,

  -- Number of Sales for this plan row.
  --
  -- NULLABLE, and that is an empirical decision, not caution. The column is
  -- present and parses cleanly on all three sampled statements across BOTH
  -- layout versions (right edge 84.7-84.8; every plan row of Taste of Home
  -- 07-2026, Mesivta 01-2025 and YDH 01-2025 carries one). But three
  -- statements is the whole sample, and making it NOT NULL would convert a
  -- brand-new data point into a blocking requirement for the volume import
  -- that already works — a fourth layout without the column would stop
  -- volumes landing at all. Nullable costs R5 nothing it is not already
  -- paying: today the count does not exist anywhere.
  --
  -- integer, not numeric: every sampled value is a whole zero-padded count
  -- ("205", "03", "00"), and a transaction count is physically an integer.
  -- Deliberately UNLIKE residual_lines.item_count numeric(14,4), which counts
  -- fee-report line items — a different source with genuinely fractional
  -- values. The parser rejects a count token containing '.', because a
  -- decimal in that band means the band caught the wrong column.
  item_count     integer,

  source         text not null default 'pdf'
                   check (source in ('pdf','manual')),

  created_at     timestamptz not null default now(),
  created_by_id  uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by_id  uuid references auth.users(id),
  deleted_at     timestamptz,
  deleted_by_id  uuid references auth.users(id),

  -- Same equivalence as residual_lines_provenance_consistent and
  -- residual_merchant_volumes_provenance_consistent.
  constraint residual_plan_volumes_provenance_consistent
    check ((source = 'manual') = (import_id is null))
);

-- THE grain, enforced rather than assumed. Partial, which is why the RPC
-- sweeps then inserts instead of using ON CONFLICT (the R4b reasoning:
-- a partial unique cannot be a conflict target).
create unique index if not exists residual_plan_volumes_period_mid_code_unique
  on public.residual_plan_volumes (period_id, mid, plan_code)
  where deleted_at is null;

-- The rollup / read path: "every plan row for this merchant this month".
create index if not exists residual_plan_volumes_period_mid
  on public.residual_plan_volumes (period_id, mid)
  where deleted_at is null;

-- Provenance sweep.
create index if not exists residual_plan_volumes_import
  on public.residual_plan_volumes (import_id)
  where deleted_at is null;

-- The resolve-later worklist: "which merchants are blocked on an unmapped
-- code". This is the index that makes the new workflow cheap.
create index if not exists residual_plan_volumes_unmapped
  on public.residual_plan_volumes (plan_code, period_id, mid)
  where deleted_at is null and volume_bucket is null;

drop trigger if exists residual_plan_volumes_set_updated_at
  on public.residual_plan_volumes;
create trigger residual_plan_volumes_set_updated_at
  before update on public.residual_plan_volumes
  for each row execute function public.tg_set_updated_at();

alter table public.residual_plan_volumes enable row level security;

-- Role-gated from birth, matching the tightening applied to the four
-- pre-existing residual tables in section 6. This table carries per-merchant
-- processing volume, so it is merchant financial data.
drop policy if exists "residual_plan_volumes_select" on public.residual_plan_volumes;
create policy "residual_plan_volumes_select"
  on public.residual_plan_volumes
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_plan_volumes_insert" on public.residual_plan_volumes;
create policy "residual_plan_volumes_insert"
  on public.residual_plan_volumes
  for insert to authenticated
  with check (public.auth_is_admin());

drop policy if exists "residual_plan_volumes_update" on public.residual_plan_volumes;
create policy "residual_plan_volumes_update"
  on public.residual_plan_volumes
  for update to authenticated
  using (public.auth_is_admin() and deleted_at is null)
  with check (public.auth_is_admin());

-- ============================================================
-- 3. residual_merchant_volumes — the derived-rollup siblings
-- ============================================================
-- STRICTLY ADDITIVE. Every column below is nullable, so existing rows are
-- untouched and keep their R4b-era meaning. See the MIGRATION SAFETY note at
-- the foot of this file.
--
-- WHY stated_total LIVES HERE AND NOT ON residual_imports.
-- The '**' row's Amount of Sales is a property of one merchant's statement for
-- one month. Its grain is exactly (period_id, mid) — which is precisely this
-- table's grain and its unique key. residual_imports' grain is
-- (processor, period_id, source_type). Those two coincide today only because
-- one PDF happens to carry one merchant; they coincide ACCIDENTALLY, not
-- definitionally. Storing a per-merchant fact at import grain is the same
-- class of error R1b argued against when it refused to put volumes on
-- residual_lines ("SUM(amex_volume) silently wrong by a factor of the line
-- count") — the day one import carries two merchants, an import-grain
-- stated_total is simply wrong, with no constraint able to say so.
-- Colocating it here also makes the reconciliation a single-row comparison
-- with no join.

alter table public.residual_merchant_volumes
  -- The statement's own '**' Amount of Sales. The number the derived buckets
  -- are checked against.
  add column if not exists stated_total       numeric(14,2),

  -- The '**' row's Number of Sales. ADVISORY ONLY — never gates an import.
  -- Reason: of the three sampled statements only Taste of Home's totals-row
  -- count was actually measured (491, which is exactly the sum of its 14 plan
  -- counts); the Mesivta and YDH fixtures reuse that literal rather than
  -- carrying their own (their real sums are 659 and 2). One verified sample is
  -- not enough to gate on, so this is stored for later comparison and nothing
  -- else.
  add column if not exists stated_item_count  integer,

  -- The SQL verdict. NULL = unknown, which is exactly right for pre-R5a rows:
  -- they were written by the old path with no plan rows behind them, so there
  -- is nothing to re-derive and no honest true/false to assert.
  add column if not exists reconciled         boolean,

  -- Volume sitting in plan codes with no bucket. The actionable shortfall
  -- number: when reconciled is false this is usually why, and it names the
  -- size of the problem.
  add column if not exists unmapped_volume    numeric(14,2),

  -- Rolled-up transaction counts, siblings to the four dollar buckets.
  -- Materialized for the same reason the dollar buckets are: the R5 engine
  -- and the Tab-2 grid read at (period, mid), and seven per-transaction sell
  -- rates in the R2 pricing drawer need a count to multiply at that grain.
  -- Same writer, same derivation, same NULL-when-unreconciled rule.
  add column if not exists amex_item_count    integer,
  add column if not exists vmd_item_count     integer,
  add column if not exists debit_item_count   integer,
  add column if not exists ebt_item_count     integer;

comment on column public.residual_merchant_volumes.stated_total is
  'The statement''s own ''**'' Amount of Sales, at (period_id, mid) grain. The figure the SQL-derived buckets are reconciled against. NULL on pre-R5a rows.';
comment on column public.residual_merchant_volumes.stated_item_count is
  'The ''**'' row''s Number of Sales. ADVISORY ONLY — never gates an import; only one of three sampled statements had a verified value.';
comment on column public.residual_merchant_volumes.reconciled is
  'SQL verdict: derived plan-row total equals stated_total AND no volume sits in unmapped plan codes. NULL = unknown (pre-R5a row, no plan rows behind it). When false, the four dollar buckets and four count columns are NULL rather than partial.';
comment on column public.residual_merchant_volumes.unmapped_volume is
  'Dollar volume in plan codes absent from residual_plan_code_buckets. 0 when everything mapped.';

-- ============================================================
-- 4. residual_derive_plan_rollup — the ONE derivation
-- ============================================================
-- Write-free. Takes the plan rows as jsonb and the statement's stated total,
-- resolves each code against residual_plan_code_buckets, sums in SQL, and
-- returns the whole verdict.
--
-- TWO CALLERS, ONE FUNCTION, and that is the point:
--   * previewResidualPdfAction calls it to show the user a verdict WITHOUT
--     writing anything;
--   * commit_residual_pdf_import calls it on the identical input before
--     inserting.
-- So the preview cannot disagree with the commit — not "should not", cannot.
-- This is what replaces the JS reconciliation in pdf-parser.ts:271-274 AND the
-- duplicate JS reconciliation in import-wizard.tsx:465-469, and it is how the
-- preview keeps its fail-loud behaviour without the parser owning any
-- arithmetic: the preview gets the real verdict from the real code path rather
-- than re-deriving one.
--
-- MONEY CROSSES BACK AS TEXT. Every dollar figure in the returned object is
-- rendered ::text, not left as a JSON number. jsonb numbers become JS floats,
-- and the whole point of this migration is that no JS float ever holds a
-- residual dollar amount. The UI renders these strings directly. Counts stay
-- JSON numbers — they are small exact integers.
--
-- STABLE + SECURITY INVOKER: it only reads, and residual_plan_code_buckets'
-- SELECT policy is open to authenticated for live rows, so this returns
-- nothing the caller could not already read. No definer needed.

create or replace function public.residual_derive_plan_rollup(
  p_plan_rows    jsonb,
  p_stated_total numeric
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with rows_in as (
    select
      upper(btrim(r.plan_code)) as plan_code,
      r.amount,
      r.item_count
    from jsonb_to_recordset(coalesce(p_plan_rows, '[]'::jsonb)) as r(
      plan_code   text,
      amount      numeric(14,2),
      item_count  integer
    )
    -- The amount filter must match the INSERT's filter in
    -- commit_residual_pdf_import exactly, or the derived totals would be
    -- computed over a different row set than the one that gets stored.
    where btrim(coalesce(r.plan_code, '')) <> ''
      and r.amount is not null
  ),
  resolved as (
    select
      ri.plan_code,
      ri.amount,
      ri.item_count,
      b.volume_bucket
    from rows_in ri
    left join public.residual_plan_code_buckets b
      on b.plan_code = ri.plan_code
     and b.deleted_at is null
  ),
  agg as (
    select
      -- Dollars coalesce to 0: a bucket with no plan rows genuinely has zero
      -- volume (Mesivta carries no EB row at all and its ebt_volume is 0).
      coalesce(sum(amount) filter (where volume_bucket = 'amex_volume'),  0)::numeric(14,2) as amex_volume,
      coalesce(sum(amount) filter (where volume_bucket = 'vmd_volume'),   0)::numeric(14,2) as vmd_volume,
      coalesce(sum(amount) filter (where volume_bucket = 'debit_volume'), 0)::numeric(14,2) as debit_volume,
      coalesce(sum(amount) filter (where volume_bucket = 'ebt_volume'),   0)::numeric(14,2) as ebt_volume,
      coalesce(sum(amount) filter (where volume_bucket is null),          0)::numeric(14,2) as unmapped_volume,
      coalesce(sum(amount), 0)::numeric(14,2)                                               as derived_total,

      -- Counts: raw sums here, NULL-vs-0 decided below against has_counts.
      sum(item_count) filter (where volume_bucket = 'amex_volume')  as amex_item_count,
      sum(item_count) filter (where volume_bucket = 'vmd_volume')   as vmd_item_count,
      sum(item_count) filter (where volume_bucket = 'debit_volume') as debit_item_count,
      sum(item_count) filter (where volume_bucket = 'ebt_volume')   as ebt_item_count,

      -- Whether this statement carried the Number of Sales column at all.
      -- The parser guarantees all-or-nothing within one statement (a mixed
      -- result means the band caught the wrong column and it refuses), so one
      -- flag for the whole set is sound.
      (count(item_count) > 0)                                       as has_counts,

      count(*)                                                      as plan_row_count,

      coalesce(
        jsonb_agg(distinct plan_code) filter (where volume_bucket is null),
        '[]'::jsonb
      )                                                             as unmapped_codes,
      coalesce(
        jsonb_agg(distinct plan_code)
          filter (where volume_bucket is null and amount <> 0),
        '[]'::jsonb
      )                                                             as unmapped_codes_with_volume
    from resolved
  )
  select jsonb_build_object(
    'plan_row_count',  a.plan_row_count,
    'has_counts',      a.has_counts,

    -- Money as text. See the header note.
    'derived_total',   a.derived_total::text,
    'stated_total',    case when p_stated_total is null
                            then null else p_stated_total::numeric(14,2)::text end,
    'unmapped_volume', a.unmapped_volume::text,

    'unmapped_codes',             a.unmapped_codes,
    'unmapped_codes_with_volume', a.unmapped_codes_with_volume,

    'buckets', jsonb_build_object(
      'amex_volume',  a.amex_volume::text,
      'vmd_volume',   a.vmd_volume::text,
      'debit_volume', a.debit_volume::text,
      'ebt_volume',   a.ebt_volume::text
    ),

    -- A bucket with rows but no readable counts, and a bucket with no rows at
    -- all, are both NULL unless the statement carried counts — in which case
    -- an empty bucket is a true zero.
    'counts', jsonb_build_object(
      'amex_item_count',  case when a.has_counts then coalesce(a.amex_item_count,  0) end,
      'vmd_item_count',   case when a.has_counts then coalesce(a.vmd_item_count,   0) end,
      'debit_item_count', case when a.has_counts then coalesce(a.debit_item_count, 0) end,
      'ebt_item_count',   case when a.has_counts then coalesce(a.ebt_item_count,   0) end
    ),

    -- THE VERDICT. Exact numeric equality — both sides are numeric(14,2), so
    -- this is the comparison JS could never make safely.
    --
    -- A zero-volume unmapped code does NOT fail reconciliation: the statement
    -- listed a plan nothing ran through, the arithmetic still holds, and R4b's
    -- test "allows a zero-volume unmapped code and still reconciles" keeps its
    -- meaning.
    'reconciled',
      (p_stated_total is not null
       and a.unmapped_volume = 0
       and a.derived_total = p_stated_total::numeric(14,2))
  )
  from agg a;
$$;

comment on function public.residual_derive_plan_rollup(jsonb, numeric) is
  'Write-free SQL rollup of PDF statement plan rows: resolves each plan_code against residual_plan_code_buckets, sums per bucket, and returns the reconciliation verdict. Called by BOTH previewResidualPdfAction and commit_residual_pdf_import on identical input, so the preview cannot disagree with the commit. Money is returned as text so no JS float ever holds a residual dollar amount.';

revoke all on function public.residual_derive_plan_rollup(jsonb, numeric) from public;
grant execute on function public.residual_derive_plan_rollup(jsonb, numeric) to authenticated;

-- ============================================================
-- 5. commit_residual_pdf_import — plan rows in, buckets derived
-- ============================================================
-- DROP THEN CREATE, not CREATE OR REPLACE: the argument list changes from
-- (uuid, uuid, jsonb) to (uuid, uuid, jsonb, jsonb). The old 3-arg form is
-- dropped EXPLICITLY rather than left as an overload — leaving it would let a
-- stale caller silently hit the R4b path and write asserted buckets with no
-- plan rows behind them, which is exactly the state this migration exists to
-- end. The caller (ingestResidualPdf in app/(app)/admin/residuals/actions.ts)
-- is updated in the same commit, per the R4b precedent.
--
-- WHAT IS PRESERVED, EXACTLY:
--   * the admin gate, FIRST, before anything else (definer bypasses RLS);
--   * SELECT ... FOR UPDATE on the import row;
--   * status must be 'processing'  -> 22023;
--   * source_type must be 'pdf'    -> 22023;
--   * processor AND period_id both required -> 22023;
--   * the period pin onto the import row, in the same transaction as the rows;
--   * the supersede sweep keyed on "different import, same
--     (processor, period_id, source_type) triple" — NOT on status;
--   * the final flip to 'completed', which arms
--     residual_imports_processor_period_unique; a 23505 there rolls the entire
--     function back;
--   * "inserted" and "swept" in the return object, with their R4b meanings
--     (merchant-volume rows), so readCommitCounts keeps working untouched.
--
-- WHAT CHANGES:
--   * p_rows (finished buckets) becomes p_merchant (identity + stated totals)
--     and p_plan_rows (the detail);
--   * the buckets are DERIVED here by residual_derive_plan_rollup, not
--     received;
--   * the sweep covers residual_plan_volumes as well;
--   * an unreconciled statement no longer aborts. See below.
--
-- ------------------------------------------------------------
-- BEHAVIOUR CHANGE — unreconciled statements now LAND, flagged
-- ------------------------------------------------------------
-- R4b refused the import outright when a plan code had no bucket or the totals
-- disagreed, so a good extraction was destroyed and the fix required a code
-- change, a deploy and a re-upload.
--
-- From R5a the plan rows are stored, `reconciled` is set false, and the four
-- dollar buckets AND the four count columns are written NULL — not partial,
-- not zero. Nothing downstream can read an under-counted total, because there
-- is no total to read; NULL is R1b's own "not computed" convention. The
-- shortfall is recorded in unmapped_volume and the offending codes are
-- returned to the caller by name.
--
-- The safety property R4b was protecting is therefore intact — a wrong bucket
-- total still cannot be published — while the data loss it caused is gone.
-- Resolving a code becomes: INSERT the mapping, then re-derive in place
-- against the stored plan rows. No re-upload.
--
-- STRUCTURAL failures are unaffected and still abort before anything lands:
-- a scanned PDF, no Plan Summary, no '**' totals row, an unreadable Amount of
-- Sales. Those produce nothing worth storing. The line is deliberate — only
-- ARITHMETIC outcomes became storable-but-flagged.
--
-- If this trade is not wanted, the single-line veto is documented at the
-- v_reconciled check below.

drop function if exists public.commit_residual_pdf_import(uuid, uuid, jsonb);

create or replace function public.commit_residual_pdf_import(
  p_import_id uuid,
  p_period_id uuid,
  p_merchant  jsonb,
  p_plan_rows jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_processor    text;
  v_source_type  text;
  v_status       text;
  v_mid          text;
  v_merchant_nm  text;
  v_stated_total numeric(14,2);
  v_stated_count integer;
  v_rollup       jsonb;
  v_reconciled   boolean;
  v_inserted     integer;
  v_swept        integer;
  v_plan_ins     integer;
  v_plan_swept   integer;
begin
  -- Auth gate FIRST. Definer bypasses RLS, so this is the only guard.
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to commit a residual import.'
      using errcode = '42501';
  end if;

  if p_plan_rows is null or jsonb_typeof(p_plan_rows) <> 'array' then
    raise exception 'p_plan_rows must be a JSON array.'
      using errcode = '22023';
  end if;

  if p_merchant is null or jsonb_typeof(p_merchant) <> 'object' then
    raise exception 'p_merchant must be a JSON object.'
      using errcode = '22023';
  end if;

  -- ---------- merchant identity ----------
  -- Re-normalized here with the R3 digits-only expression rather than trusted
  -- from the caller. Pinned character-for-character to
  -- records_mid_unique, find_live_thread_by_mid and
  -- find_live_threads_by_mid_suffix; the TypeScript twin is
  -- normalizeMidForStorage(). All five change together or not at all.
  v_mid := regexp_replace(coalesce(p_merchant->>'mid', ''), '[^0-9]', '', 'g');
  if v_mid = '' then
    raise exception 'p_merchant.mid has no digits.'
      using errcode = '22023';
  end if;

  v_merchant_nm  := nullif(btrim(coalesce(p_merchant->>'merchant_name', '')), '');
  v_stated_count := nullif(p_merchant->>'stated_item_count', '')::integer;

  -- stated_total is REQUIRED. interpretStatement already refuses a statement
  -- with no '**' totals row ("Refusing to import a statement that can't be
  -- reconciled"); enforcing it here too means that guarantee survives any
  -- caller, not just the one we ship.
  v_stated_total := nullif(p_merchant->>'stated_total', '')::numeric(14,2);
  if v_stated_total is null then
    raise exception 'p_merchant.stated_total is required (the statement''s ''**'' row).'
      using errcode = '22023';
  end if;

  -- ---------- import row: lock and guard ----------
  select ri.processor, ri.source_type, ri.status
    into v_processor, v_source_type, v_status
    from public.residual_imports ri
   where ri.id = p_import_id
     and ri.deleted_at is null
   for update;

  if not found then
    raise exception 'Residual import % not found.', p_import_id
      using errcode = '22023';
  end if;

  if v_status <> 'processing' then
    raise exception 'Residual import % is in status %, expected processing.',
      p_import_id, v_status
      using errcode = '22023';
  end if;

  if v_source_type <> 'pdf' then
    raise exception 'Residual import % has source_type %, expected pdf.',
      p_import_id, v_source_type
      using errcode = '22023';
  end if;

  if v_processor is null or p_period_id is null then
    raise exception 'Residual import % needs both a processor and a period.',
      p_import_id
      using errcode = '22023';
  end if;

  -- Pin the resolved period in the SAME transaction as the rows, so the import
  -- and its data can never disagree about which month they belong to. Also
  -- arms the idempotency index, which keys on period_id.
  update public.residual_imports
     set period_id = p_period_id
   where id = p_import_id;

  -- ---------- derive, before writing anything ----------
  -- The identical call previewResidualPdfAction made on the identical input.
  v_rollup     := public.residual_derive_plan_rollup(p_plan_rows, v_stated_total);
  v_reconciled := (v_rollup->>'reconciled')::boolean;

  if (v_rollup->>'plan_row_count')::integer = 0 then
    raise exception 'p_plan_rows contains no usable plan rows.'
      using errcode = '22023';
  end if;

  -- VETO POINT. To restore R4b's abort-on-mismatch behaviour, uncomment:
  --
  --   if not v_reconciled then
  --     raise exception 'Statement does not reconcile: derived % vs stated %.',
  --       v_rollup->>'derived_total', v_rollup->>'stated_total'
  --       using errcode = '22023';
  --   end if;
  --
  -- Everything below already handles the unreconciled case correctly, so this
  -- is genuinely a one-block change in either direction.

  -- ---------- supersede sweep ----------
  -- Identical rule to R4a/R4b, now applied to BOTH tables: soft-delete every
  -- live row belonging to a DIFFERENT import that shares this import's
  -- (processor, period_id, source_type) triple.
  --
  -- Why not keyed on status: residual_imports carries a partial unique on that
  -- triple WHERE status='completed' AND deleted_at IS NULL, so a second
  -- completed import for the same triple cannot exist and a status-keyed sweep
  -- would be dead code. The real re-import path is soft-delete-the-import then
  -- re-upload, and soft-deleting an import does NOT cascade to its rows —
  -- which would double-count. Hence "different import, same triple".
  --
  -- Manual rows are never swept: the provenance CHECK on both tables
  -- guarantees source='manual' implies import_id IS NULL, so the join excludes
  -- them outright.
  --
  -- ORDER IS FREE. There is no FK between residual_plan_volumes and
  -- residual_merchant_volumes — they are siblings keyed on (period, mid), not
  -- parent and child. Plan rows are swept first only for readability.
  --
  -- Both sweeps must precede their inserts: both uniques are PARTIAL and so
  -- cannot serve as an ON CONFLICT target (the R4b reasoning).

  update public.residual_plan_volumes pv
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where pv.import_id = ri.id
     and pv.deleted_at is null
     and pv.import_id <> p_import_id
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  get diagnostics v_plan_swept = row_count;

  update public.residual_merchant_volumes rv
     set deleted_at    = now(),
         deleted_by_id = v_actor
    from public.residual_imports ri
   where rv.import_id = ri.id
     and rv.deleted_at is null
     and rv.import_id <> p_import_id
     and ri.period_id = p_period_id
     and ri.source_type = v_source_type
     and ri.processor = v_processor;

  get diagnostics v_swept = row_count;

  -- ---------- insert the plan-row detail ----------
  -- volume_bucket is resolved by the SAME left join residual_derive_plan_rollup
  -- used, against the same live map rows, inside the same transaction — so the
  -- stored bucket and the derived totals cannot disagree.
  insert into public.residual_plan_volumes (
    period_id, import_id, mid, plan_code, volume_bucket,
    amount, item_count, source, created_by_id, updated_by_id
  )
  select
    p_period_id,
    p_import_id,
    v_mid,
    upper(btrim(r.plan_code)),
    b.volume_bucket,
    r.amount,
    r.item_count,
    'pdf',
    v_actor,
    v_actor
  from jsonb_to_recordset(p_plan_rows) as r(
    plan_code   text,
    amount      numeric(14,2),
    item_count  integer
  )
  left join public.residual_plan_code_buckets b
    on b.plan_code = upper(btrim(r.plan_code))
   and b.deleted_at is null
  where btrim(coalesce(r.plan_code, '')) <> ''
    and r.amount is not null;

  get diagnostics v_plan_ins = row_count;

  -- ---------- insert the rolled-up merchant row ----------
  -- The four dollar buckets and the four counts are written ONLY when the
  -- statement reconciled. Otherwise NULL — not partial, not zero. See the
  -- BEHAVIOUR CHANGE note above.
  insert into public.residual_merchant_volumes (
    period_id, import_id, mid, merchant_name,
    amex_volume, vmd_volume, debit_volume, ebt_volume,
    amex_item_count, vmd_item_count, debit_item_count, ebt_item_count,
    stated_total, stated_item_count, reconciled, unmapped_volume,
    source, created_by_id, updated_by_id
  )
  values (
    p_period_id,
    p_import_id,
    v_mid,
    v_merchant_nm,

    case when v_reconciled then (v_rollup#>>'{buckets,amex_volume}')::numeric(14,2)  end,
    case when v_reconciled then (v_rollup#>>'{buckets,vmd_volume}')::numeric(14,2)   end,
    case when v_reconciled then (v_rollup#>>'{buckets,debit_volume}')::numeric(14,2) end,
    case when v_reconciled then (v_rollup#>>'{buckets,ebt_volume}')::numeric(14,2)   end,

    case when v_reconciled then (v_rollup#>>'{counts,amex_item_count}')::integer  end,
    case when v_reconciled then (v_rollup#>>'{counts,vmd_item_count}')::integer   end,
    case when v_reconciled then (v_rollup#>>'{counts,debit_item_count}')::integer end,
    case when v_reconciled then (v_rollup#>>'{counts,ebt_item_count}')::integer   end,

    v_stated_total,
    v_stated_count,
    v_reconciled,
    (v_rollup->>'unmapped_volume')::numeric(14,2),

    'pdf',
    v_actor,
    v_actor
  );

  get diagnostics v_inserted = row_count;

  -- ---------- close the import ----------
  -- Arms residual_imports_processor_period_unique. A live completed import
  -- already holding this triple makes THIS statement raise 23505 and rolls the
  -- whole function back — no rows inserted, no sweep applied.
  update public.residual_imports
     set status        = 'completed',
         row_count     = v_inserted,
         processed_at  = now(),
         error_message = null,
         updated_by_id = v_actor
   where id = p_import_id;

  -- "inserted" and "swept" keep their R4b meanings (merchant-volume rows) so
  -- readCommitCounts in actions.ts needs no change. Everything else is added.
  return jsonb_build_object(
    'inserted',          v_inserted,
    'swept',             v_swept,
    'plan_rows_inserted', v_plan_ins,
    'plan_rows_swept',    v_plan_swept,
    'reconciled',         v_reconciled,
    'derived_total',      v_rollup->>'derived_total',
    'stated_total',       v_rollup->>'stated_total',
    'unmapped_volume',    v_rollup->>'unmapped_volume',
    'unmapped_codes',     v_rollup->'unmapped_codes_with_volume',
    'has_counts',         (v_rollup->>'has_counts')::boolean
  );
end;
$$;

comment on function public.commit_residual_pdf_import(uuid, uuid, jsonb, jsonb) is
  'Atomic commit for a PDF statement import. Receives PLAN ROWS (not finished buckets), stores them at (period, mid, plan_code) grain, derives the four dollar buckets and four transaction counts via residual_derive_plan_rollup, and reconciles against the statement''s stated total — all in SQL. Supersede-sweeps both residual_plan_volumes and residual_merchant_volumes for the same (processor, period, source_type), then flips the import to completed. An unreconciled statement LANDS with reconciled=false and NULL buckets rather than aborting. SECURITY DEFINER with an explicit admin gate.';

revoke all on function public.commit_residual_pdf_import(uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.commit_residual_pdf_import(uuid, uuid, jsonb, jsonb) to authenticated;

-- ============================================================
-- 6. RLS role gates on the pre-existing residual tables
-- ============================================================
-- R1b and R4a shipped every residual table with
--
--     for select to authenticated using (deleted_at is null)
--
-- — no role gate. Any authenticated marketer could read every fee line, every
-- buy rate and every merchant volume AT THE DATABASE LAYER. The only thing
-- actually stopping them was the admin layout's requireSuperAdmin(), which
-- inverts this project's stated rule that RLS is the primary permission
-- mechanism and application checks are secondary.
--
-- That was tolerable while these tables held imported vendor figures. R5
-- writes revenue splits and net income into residual_lines, so the gate goes
-- in now, before the money does.
--
-- WHY 'admin' AND NOT super_admin ONLY: it matches the INSERT/UPDATE policies
-- already on all five tables, and the residual-files storage bucket, which
-- have always been auth_is_admin(). Making SELECT
-- stricter than INSERT would let an admin write rows they cannot read back.
-- The admin layout's requireSuperAdmin() remains a second, stricter gate on
-- the UI — defence in depth, with RLS now the primary boundary rather than
-- the only-in-name one.
--
-- NO APP CHANGES NEEDED. Every read of these tables lives in
-- app/(app)/admin/residuals/ behind requireSuperAdmin() (verified: no API
-- route, cron, webhook or anon path touches them), and each server action
-- calls gateAdmin() before its first query. The two createAdminClient() call
-- sites (the mapping soft-delete and markResidualImportFailed) bypass RLS
-- entirely and are unaffected, as are both SECURITY DEFINER commit RPCs.
--
-- residual_column_mappings is deliberately NOT in this list — it holds
-- spreadsheet header names and target column keys, no merchant data and no
-- money. Flagged for review rather than changed unasked.
--
-- INSERT and UPDATE policies are untouched throughout; only SELECT changes.

drop policy if exists "residual_periods_select" on public.residual_periods;
create policy "residual_periods_select"
  on public.residual_periods
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_imports_select" on public.residual_imports;
create policy "residual_imports_select"
  on public.residual_imports
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_lines_select" on public.residual_lines;
create policy "residual_lines_select"
  on public.residual_lines
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

drop policy if exists "residual_merchant_volumes_select"
  on public.residual_merchant_volumes;
create policy "residual_merchant_volumes_select"
  on public.residual_merchant_volumes
  for select to authenticated
  using (public.auth_is_admin() and deleted_at is null);

-- ============================================================
-- 7. CURRENCY ROUNDING CONTRACT (verified, no code change)
-- ============================================================
-- Recorded here because this is exactly the decision that gets re-litigated
-- later by someone adding a JS rounding helper "to be safe".
--
-- THE PIPELINE, end to end:
--   JS number -> JSON.stringify -> jsonb -> jsonb_to_recordset(numeric(14,2))
--
-- 1. jsonb stores a JSON number as PostgreSQL `numeric`, NOT float8
--    (PostgreSQL docs, Table 8.23: JSON primitive `number` -> PG type
--    `numeric`). So the moment a value crosses into jsonb it is an EXACT
--    DECIMAL of whatever text JSON.stringify emitted. No IEEE-754 value
--    exists anywhere on the SQL side of this boundary.
--
-- 2. The cast to numeric(14,2) is therefore numeric -> numeric, and
--    "the numeric type rounds ties away from zero" (PostgreSQL docs,
--    datatype-numeric). Away-from-zero on an exact decimal IS the HALF_UP
--    the spec asks for — the same mode as Java BigDecimal.ROUND_HALF_UP and
--    the one taught as "round .5 up" in school. It is symmetric for
--    negatives: -2.675 -> -2.68, matching +2.675 -> +2.68.
--
-- 3. Float contamination CANNOT change the result. JSON.stringify emits the
--    shortest round-tripping decimal, so a contaminated double either prints
--    clean (19169.58000000000175 emits "19169.58") or prints its artifact
--    (0.1+0.2 emits "0.30000000000000004"). Either way jsonb holds that exact
--    decimal and numeric(14,2) rounds it correctly — an artifact in the 17th
--    significant digit is nowhere near a half-cent boundary.
--
-- WHAT THIS MIGRATION ACTUALLY FIXES. The JS rounding it removes was
-- Math.round(v * 100) / 100, which is HALF-CEILING (ties toward +infinity),
-- not HALF_UP: it turns -2.675 into -2.67 where the spec wants -2.68. So
-- moving the arithmetic into SQL does not merely preserve spec compliance on
-- negatives, it RESTORES it. Several residual columns legitimately go
-- negative (residual_lines.net_revenue in particular), which is precisely
-- where the old behaviour was wrong.
--
-- Unreachable from the PDF path today regardless: statements print Amount of
-- Sales at 2dp, so numeric(14,2) performs no rounding at all on these values.
-- The contract matters for the Excel path and for R5's own derived columns.
--
-- Paste-ready confirmation against this database:
--   select 2.675::numeric(14,2)    as pos_tie,      --  2.68
--          (-2.675)::numeric(14,2) as neg_tie,      -- -2.68
--          0.005::numeric(14,2)    as half_cent,    --  0.01
--          (-0.005)::numeric(14,2) as neg_half_cent,-- -0.01
--          (jsonb_build_object('a', 19169.58000000000175)->>'a')::numeric(14,2)
--                                  as contaminated; -- 19169.58

-- ============================================================
-- MIGRATION SAFETY
-- ============================================================
-- ADDITIVE except for one deliberate drop:
--   * residual_plan_code_buckets, residual_plan_volumes  — new tables.
--   * eight new columns on residual_merchant_volumes     — all NULLABLE, no
--     defaults, no backfill, no rewrite of existing rows.
--   * residual_derive_plan_rollup                        — new function.
--   * commit_residual_pdf_import(uuid,uuid,jsonb)        — DROPPED, replaced
--     by the 4-arg form. Nothing is retyped; no column changes type; no data
--     is deleted by this migration.
--   * five SELECT policies REPLACED (section 6 + residual_plan_volumes) —
--     drop-and-recreate under the same policy names, so re-runnable. This
--     RESTRICTS read access; it cannot expose anything. No app change is
--     required (every reader is already admin-gated), but it is a live
--     permission change: if any future non-admin reader is added it will get
--     zero rows, not an error.
--
-- The drop is the only coordination hazard: between applying this migration
-- and deploying the matching app code, the old 3-arg call in
-- ingestResidualPdf would fail (PostgREST cannot find the function). Ship the
-- migration and the caller in the SAME commit, exactly as R4b did for its own
-- return-type change.
--
-- EXISTING residual_merchant_volumes ROWS — left as-is, deliberately.
--   They were written by the R4b path from JS-summed buckets and have no plan
--   rows behind them. All eight new columns are NULL on those rows, which
--   reads correctly and honestly: no stated_total was captured, and
--   reconciled IS NULL means "unknown", per R1b's own convention that NULL on
--   a derived column means not-computed.
--
--   Backfill is impossible, not merely undesirable: the plan rows do not
--   exist, and reconstructing them means re-parsing the original PDFs with
--   pdfjs, which cannot run inside a migration.
--
--   Soft-deleting them for re-import is rejected: it destroys real imported
--   data in exchange for nothing automatic, and re-importing still requires
--   the manual soft-delete-the-import dance because of
--   residual_imports_processor_period_unique. Any month that genuinely needs
--   plan-row detail should be re-imported deliberately through the normal
--   path, which will sweep the old row correctly on its own.
--
--   Operator discriminator for the pre-R5a population:
--     select * from public.residual_merchant_volumes
--      where deleted_at is null and reconciled is null and stated_total is null;

commit;
