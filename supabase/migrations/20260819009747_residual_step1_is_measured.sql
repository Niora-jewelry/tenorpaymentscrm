begin;

-- ════════════════════════════════════════════════════════════════════════
-- Step 1 becomes a real comparison
-- ════════════════════════════════════════════════════════════════════════
--
-- `residuals.md` §2 and §11 both record step 1 as unevaluated and unmeasured:
--
--   "Step 1 of the reconciliation has also never been evaluated once ...
--    residual_verdicts returns ZERO step-1 rows on May, which is why step 1's
--    tolerance remains a placeholder."
--   "This is the highest-leverage gap in the list."
--
-- and `20260819009728`'s seed header names what settles the one conflict in
-- the bucket mapping: "THE FIRST OVERLAPPING MERCHANT-MONTH ARBITRATES."
--
-- August 2026 is that month. Seven real statements now sit against a real fee
-- report, step 1 returns sixteen comparisons instead of none, and this
-- migration is what those sixteen measured.
--
-- ── WHAT THEY SHOWED ────────────────────────────────────────────────────
-- Twelve of the sixteen agreed to the CENT on the mapping as seeded — Amex
-- OptBlue on all four merchants carrying it, Cash Discount on all three,
-- Interchange on three of four. The mapping is right in general.
--
-- All four that disagreed were BIN Sponsorship, and both causes are exact:
--
--   1. BIN IS ASSESSED NET OF REFUNDS. On MID 201100272922 the report's BIN
--      volume is 104,729.63 against mapped buckets of 104,821.61 — a gap of
--      91.98, which is precisely that statement's credits. Cash Discount and
--      Interchange on the SAME statement match on GROSS, so this is per fee
--      item and not a property of the month.
--
--   2. BIN PICKS UP AMEX WHEN THERE IS NO CASH DISCOUNT LINE. On MID
--      30119889965 the report's BIN exceeds vmd+debit by 10,777.00, exactly
--      that merchant's Amex volume. Measured across the four informative
--      merchants it is consistent: Cash Discount present -> Amex excluded
--      (2 of 2); absent -> Amex included (2 of 2, plus one merchant with zero
--      Amex that cannot discriminate).
--
--      Which is the same conditional the registry ALREADY carries for this
--      exact pair: BIN's income terms are `applies_when = 'sibling_absent'`
--      with `sibling_fee_item_name = 'Cash Disc/Surcharge Program'`. The two
--      rules are alternatives — a merchant on Cash Discount has its Amex
--      volume accounted there, so BIN does not count it twice. Step 1 was the
--      only layer that did not know.
--
-- With both applied: BIN agrees to the cent on three of four, and MID
-- 201100241497 is left 1.34 out on 430,881.10 — 0.0000031 of it. That one is
-- real and small and is left visible as a mismatch rather than tuned away.
--
-- ── WHAT THEY COULD NOT SHOW ────────────────────────────────────────────
-- The EBT bucket-membership conflict is NOT resolved here, and the spec's
-- expectation that this overlap would arbitrate it does not hold: none of the
-- seven statements carries any EBT volume at all. Its mapping is untouched and
-- the conflict stays open, now with a measured reason rather than an
-- assumption. A statement for an EBT merchant settles it.
--
-- ── THE TOLERANCE IS NOW MEASURED, AND THE NUMBER DOES NOT CHANGE ───────
-- §2 says step 1's 0.05 "is a placeholder, not a measurement". It is now a
-- measurement, and it lands on the same value: exact agreement is the norm —
-- fifteen of sixteen comparisons are 0.00 once the mapping is right — so a
-- tolerance of five cents forgives nothing that matters and still catches
-- 201100241497's 1.34. Only the note changes; the VALUE is untouched, so no
-- dated successor is opened and no reconciled month is disturbed.

-- ── 1. the mapping gains a condition and a basis ───────────────────────
-- Both mirror `residual_formula_terms`, which has carried `applies_when` and
-- `sibling_fee_item_name` since R5d. Step 1 is a second assertion about the
-- same quantity as a rule's income side, so when the rule's terms are
-- conditional its verification has to be conditional in the same way.

alter table public.residual_volume_row_mappings
  add column if not exists applies_when text not null default 'always',
  add column if not exists sibling_fee_item_name text,
  add column if not exists basis text not null default 'gross';

alter table public.residual_volume_row_mappings
  drop constraint if exists residual_volume_row_mappings_applies_when;
alter table public.residual_volume_row_mappings
  add constraint residual_volume_row_mappings_applies_when
  check (applies_when in ('always', 'sibling_absent', 'sibling_present'));

-- A conditional mapping with no sibling named is a mapping that silently
-- never applies, which would remove a bucket from the comparison and look
-- like agreement.
alter table public.residual_volume_row_mappings
  drop constraint if exists residual_volume_row_mappings_sibling_required;
alter table public.residual_volume_row_mappings
  add constraint residual_volume_row_mappings_sibling_required
  check ((applies_when = 'always') = (sibling_fee_item_name is null));

alter table public.residual_volume_row_mappings
  drop constraint if exists residual_volume_row_mappings_basis;
alter table public.residual_volume_row_mappings
  add constraint residual_volume_row_mappings_basis
  check (basis in ('gross', 'net'));

comment on column public.residual_volume_row_mappings.applies_when is
  'Whether this bucket counts towards the fee item unconditionally, or only '
  'when a sibling fee item is absent/present on the same merchant-month. Same '
  'vocabulary and same meaning as residual_formula_terms.applies_when, and '
  'evaluated against the same sibling set: every distinct fee_item_name on '
  'residual_lines for that merchant and period.';

comment on column public.residual_volume_row_mappings.basis is
  'gross compares against the statement''s sales volume; net subtracts that '
  'bucket''s credits first. Measured per fee item on August 2026: BIN '
  'Sponsorship is assessed net of refunds, while Cash Discount and Interchange '
  'are assessed gross on the same statements.';

-- ── 2. credits, carried from the statement ─────────────────────────────
-- The parser has always read the two credit columns; nothing stored them,
-- because until a statement/report pair existed there was nothing to compare
-- them against. `basis = 'net'` is what needs them.

alter table public.residual_plan_volumes
  add column if not exists credit_amount numeric(14,2),
  add column if not exists credit_count integer;

comment on column public.residual_plan_volumes.credit_amount is
  'Amount of credits for this plan code, as the statement printed it. NULL '
  'means the statement did not carry the column; 0.00 means it carried it and '
  'the plan had none.';

alter table public.residual_merchant_volumes
  add column if not exists amex_credits  numeric(14,2),
  add column if not exists vmd_credits   numeric(14,2),
  add column if not exists debit_credits numeric(14,2),
  add column if not exists ebt_credits   numeric(14,2);

comment on column public.residual_merchant_volumes.vmd_credits is
  'Credits rolled up into this bucket, for mappings whose basis is net. NULL '
  'on rows written before credits were captured, and on an unreconciled '
  'statement, for the same reason the volume buckets are NULL there.';


-- ── function, reproduced with the change marked in place ──────────────

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
      r.item_count,
      r.credit_amount
    from jsonb_to_recordset(coalesce(p_plan_rows, '[]'::jsonb)) as r(
      plan_code     text,
      amount        numeric(14,2),
      item_count    integer,
      credit_amount numeric(14,2),
      credit_count  integer
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
      ri.credit_amount,
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

      -- Credits, per bucket, for mappings whose basis is net. Summed with the
      -- same filters as the dollars above so a bucket's volume and its credits
      -- can never be drawn from different row sets. NULL-vs-0 is decided
      -- against has_credits below, exactly as the counts are.
      sum(credit_amount) filter (where volume_bucket = 'amex_volume')  as amex_credits,
      sum(credit_amount) filter (where volume_bucket = 'vmd_volume')   as vmd_credits,
      sum(credit_amount) filter (where volume_bucket = 'debit_volume') as debit_credits,
      sum(credit_amount) filter (where volume_bucket = 'ebt_volume')   as ebt_credits,
      (count(credit_amount) > 0)                                       as has_credits,
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

    -- A statement that did not carry the credits column leaves these NULL
    -- rather than 0.00, so `basis = 'net'` subtracts nothing it cannot see
    -- instead of subtracting a fabricated zero.
    'credits', jsonb_build_object(
      'amex_credits',  case when a.has_credits then coalesce(a.amex_credits,  0)::numeric(14,2)::text end,
      'vmd_credits',   case when a.has_credits then coalesce(a.vmd_credits,   0)::numeric(14,2)::text end,
      'debit_credits', case when a.has_credits then coalesce(a.debit_credits, 0)::numeric(14,2)::text end,
      'ebt_credits',   case when a.has_credits then coalesce(a.ebt_credits,   0)::numeric(14,2)::text end
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


-- ── function, reproduced with the change marked in place ──────────────

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
  -- Pins the MID too, for the same reason and in the same breath: a statement
  -- is one merchant's artifact, and residual_imports_statement_unique keys on
  -- it. Set here rather than trusted from the caller so the keyed value is the
  -- one that was actually read out of the document.
  update public.residual_imports
     set period_id = p_period_id,
         mid       = v_mid
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
  -- Soft-delete every live row for THIS MERCHANT belonging to a DIFFERENT
  -- import that shares this import's (processor, period_id, source_type).
  --
  -- The `mid` predicate is load-bearing. Without it the sweep clears every
  -- merchant in the month, which was correct while a month could hold only one
  -- completed PDF import and is silent data loss now that it holds one per
  -- merchant. It pairs with residual_imports_statement_unique; neither is safe
  -- without the other, so they went in together.
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
     and pv.mid = v_mid
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
     and rv.mid = v_mid
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
    amount, item_count, credit_amount, credit_count,
    source, created_by_id, updated_by_id
  )
  select
    p_period_id,
    p_import_id,
    v_mid,
    upper(btrim(r.plan_code)),
    b.volume_bucket,
    r.amount,
    r.item_count,
    r.credit_amount,
    r.credit_count,
    'pdf',
    v_actor,
    v_actor
  from jsonb_to_recordset(p_plan_rows) as r(
    plan_code     text,
    amount        numeric(14,2),
    item_count    integer,
    credit_amount numeric(14,2),
    credit_count  integer
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
     amex_credits, vmd_credits, debit_credits, ebt_credits,
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

    -- Gated on v_reconciled for the same reason the volumes are: an
    -- unreconciled statement's buckets are withheld, and a credit figure
    -- without the volume it belongs to is not a fact worth keeping.
    case when v_reconciled then (v_rollup#>>'{credits,amex_credits}')::numeric(14,2)  end,
    case when v_reconciled then (v_rollup#>>'{credits,vmd_credits}')::numeric(14,2)   end,
    case when v_reconciled then (v_rollup#>>'{credits,debit_credits}')::numeric(14,2) end,
    case when v_reconciled then (v_rollup#>>'{credits,ebt_credits}')::numeric(14,2)   end,

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
  -- Arms residual_imports_statement_unique. A live completed import already
  -- holding this (processor, period, mid) makes THIS statement raise 23505 and
  -- rolls the whole function back — no rows inserted, no sweep applied. Re-
  -- importing one merchant's statement therefore still has to soft-delete the
  -- earlier import first; what changed is that the OTHER merchants' imports no
  -- longer collide with it.
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


-- ── function, reproduced with the change marked in place ──────────────

create or replace function public.residual_verdicts(
  p_period_id uuid,
  p_mid       text default null,
  p_processor text default null
)
returns table (
  scope             text,
  scope_id          uuid,
  mid               text,
  fee_item_name     text,
  group_key         text,
  step              smallint,
  verdict           text,
  left_value        numeric,
  right_value       numeric,
  delta             numeric,
  tolerance_applied numeric,
  ack_id            uuid,
  suppressed        boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month     date;
  v_proc      text;
  v_registry  uuid;
  v_mid       text := nullif(regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g'), '');
  v_t1        numeric;
  v_t2        numeric;
  v_t3        numeric;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read residual verdicts.'
      using errcode = '42501';
  end if;

  -- ONE call replaces R6a's inline gate, month lookup, processor derivation and
  -- registry lookup. See residual_period_context for why it is shared with
  -- residual_grid_rows rather than copied into it.
  select c.processor, c.registry_id, c.statement_month
    into v_proc, v_registry, v_month
    from public.residual_period_context(p_period_id, p_processor) c;

  -- Raises if any of the three is uncovered. Resolved ONCE, before any row is
  -- read, so a partially-covered month cannot produce a half-verdicted period.
  select max(x.tolerance) filter (where x.step = 1),
         max(x.tolerance) filter (where x.step = 2),
         max(x.tolerance) filter (where x.step = 3)
    into v_t1, v_t2, v_t3
    from public.residual_tolerances_for_month(v_month) x;

  return query
  with
  -- ---------- the rule shapes, one pass over the registry ----------
  rule_shape as (
    select ru.id                as rule_id,
           ru.fee_item_name     as fin,
           ru.group_key         as gkey,
           -- Step-2 exemption, derived. TRUE when the buy side has no terms at
           -- all, or is exactly one net_revenue mirror term.
           (count(t.id) filter (where t.side = 'buy_rate') = 0
            or (count(t.id) filter (where t.side = 'buy_rate') = 1
                and count(t.id) filter (where t.side = 'buy_rate'
                                          and t.rate_source = 'net_revenue') = 1)
           )                    as step2_exempt
      from public.residual_formula_rules ru
      left join public.residual_formula_terms t
             on t.rule_id = ru.id and t.deleted_at is null
     where ru.registry_id = v_registry
       and ru.deleted_at is null
     group by ru.id, ru.fee_item_name, ru.group_key
  ),
  -- ---------- the period's lines, matched to their rule ----------
  ln as (
    select l.id, l.mid as lmid, l.fee_item_name as fin,
           l.amount, l.agent_expense, l.net_revenue,
           l.total_buy_rate, l.tapdash_net_before_split,
           rs.rule_id, rs.gkey, rs.step2_exempt
      from public.residual_lines l
      join rule_shape rs on rs.fin = l.fee_item_name
     where l.period_id = p_period_id
       and l.deleted_at is null
       and (v_mid is null or l.mid = v_mid)
  ),
  -- ---------- volumes for this period, one row per mid ----------
  vol as (
    select v.mid as vmid, v.amex_volume, v.vmd_volume,
           v.debit_volume, v.ebt_volume,
           v.amex_credits, v.vmd_credits,
           v.debit_credits, v.ebt_credits
      from public.residual_merchant_volumes v
     where v.period_id = p_period_id
       and v.deleted_at is null
  ),
  -- ---------- the sibling set, for conditional mappings ----------
  -- Every fee item each merchant carries this period. Built with the SAME
  -- query the engine uses for residual_formula_terms.applies_when
  -- (residual_calc_engine, "Read ONCE per merchant"), so a conditional
  -- mapping and the conditional income term it verifies can never disagree
  -- about whether the sibling is there.
  sib as (
    select regexp_replace(l.mid, '[^0-9]', '', 'g') as smid,
           array_agg(distinct l.fee_item_name)      as items
      from public.residual_lines l
     where l.period_id = p_period_id
       and l.deleted_at is null
     group by 1
  ),
  -- ---------- step 1: mapped rows only ----------
  -- The bucket-sum is built by matching the mapping's text against the volume
  -- row's columns. bool_or(... is null) is what makes a partially-extracted
  -- statement absent rather than wrong: the unreconciled-PDF path writes all
  -- four buckets NULL by design, and summing NULLs as zero would compare a real
  -- Amount against a fabricated 0.00 and call it a mismatch.
  s1 as (
    select ln.id, ln.lmid, ln.fin, ln.gkey,
           ln.amount as lv,
           -- Gross, less this bucket's credits where the mapping says net.
           -- Measured on August 2026: BIN Sponsorship is assessed net of
           -- refunds while Cash Discount and Interchange are assessed gross on
           -- the very same statements, so the basis belongs to the mapping and
           -- not to the period.
           sum(case m.volume_bucket
                 when 'amex_volume'  then vol.amex_volume
                   - case when m.basis = 'net' then coalesce(vol.amex_credits, 0) else 0 end
                 when 'vmd_volume'   then vol.vmd_volume
                   - case when m.basis = 'net' then coalesce(vol.vmd_credits, 0) else 0 end
                 when 'debit_volume' then vol.debit_volume
                   - case when m.basis = 'net' then coalesce(vol.debit_credits, 0) else 0 end
                 when 'ebt_volume'   then vol.ebt_volume
                   - case when m.basis = 'net' then coalesce(vol.ebt_credits, 0) else 0 end
               end) as rv,
           -- Unchanged, and deliberately tested on the VOLUME rather than on
           -- the credits: a NULL bucket is what makes a partially-extracted
           -- statement absent instead of wrong, while a NULL credit figure
           -- only means the statement did not print the column.
           bool_or(case m.volume_bucket
                     when 'amex_volume'  then vol.amex_volume
                     when 'vmd_volume'   then vol.vmd_volume
                     when 'debit_volume' then vol.debit_volume
                     when 'ebt_volume'   then vol.ebt_volume
                   end is null) as any_bucket_null
      from ln
      join public.residual_volume_row_mappings m
        on m.rule_id = ln.rule_id and m.deleted_at is null
      join vol on vol.vmid = ln.lmid
      left join sib on sib.smid = regexp_replace(ln.lmid, '[^0-9]', '', 'g')
     where ln.amount is not null
       -- A conditional bucket drops out of the sum entirely when its condition
       -- fails, which is what `continue` does to a conditional term in the
       -- engine's own evaluator.
       and (m.applies_when = 'always'
            or (m.applies_when = 'sibling_absent'
                and not (m.sibling_fee_item_name = any(coalesce(sib.items, '{}'::text[]))))
            or (m.applies_when = 'sibling_present'
                and m.sibling_fee_item_name = any(coalesce(sib.items, '{}'::text[]))))
     group by ln.id, ln.lmid, ln.fin, ln.gkey, ln.amount
  ),
  -- ---------- the group rows ----------
  grp as (
    select g.id, g.mid as gmid, g.group_key as gkey,
           g.stated_net_revenue, g.tapdash_net_before_split, g.total_buy_rate,
           -- The group's stated buy side is the SUM over its member lines;
           -- residual_line_groups stores the stated NET but not the stated
           -- expense, so step 2 at group grain has to add it up here.
           (select sum(l2.agent_expense)
              from public.residual_lines l2
              join rule_shape rs2 on rs2.fin = l2.fee_item_name
             where l2.period_id = p_period_id
               and l2.deleted_at is null
               and l2.mid = g.mid
               and rs2.gkey = g.group_key) as stated_expense,
           -- A group is step-2 exempt when its ANCHOR is: the anchor carries
           -- the terms, so the anchor's shape is the group's shape.
           (select bool_and(rs3.step2_exempt)
              from rule_shape rs3
              join public.residual_formula_rules ru3 on ru3.id = rs3.rule_id
             where rs3.gkey = g.group_key
               and ru3.is_group_anchor) as step2_exempt
      from public.residual_line_groups g
     where g.period_id = p_period_id
       and g.deleted_at is null
       and (v_mid is null or g.mid = v_mid)
  ),
  -- ---------- every comparison, before acks ----------
  raw as (
    -- step 1 (line grain, mapped rows with a usable volume row)
    select 'line'::text as sc, s1.id as sid, s1.lmid as m, s1.fin as fi,
           s1.gkey as gk, 1::smallint as st,
           false as exempt, s1.lv as lv, s1.rv as rv, v_t1 as tol
      from s1
     where not s1.any_bucket_null

    union all
    -- step 2 (line grain, non-group-member lines)
    select 'line', ln.id, ln.lmid, ln.fin, ln.gkey, 2::smallint,
           ln.step2_exempt, ln.agent_expense, ln.total_buy_rate, v_t2
      from ln
     where ln.gkey is null
       and (ln.step2_exempt or (ln.agent_expense is not null
                                and ln.total_buy_rate is not null))

    union all
    -- step 3 (line grain, non-group-member lines)
    select 'line', ln.id, ln.lmid, ln.fin, ln.gkey, 3::smallint,
           false, ln.net_revenue, ln.tapdash_net_before_split, v_t3
      from ln
     where ln.gkey is null
       and ln.net_revenue is not null
       and ln.tapdash_net_before_split is not null

    union all
    -- step 2 (group grain)
    select 'group', grp.id, grp.gmid, null, grp.gkey, 2::smallint,
           coalesce(grp.step2_exempt, false), grp.stated_expense, grp.total_buy_rate, v_t2
      from grp
     where coalesce(grp.step2_exempt, false)
        or (grp.stated_expense is not null and grp.total_buy_rate is not null)

    union all
    -- step 3 (group grain)
    select 'group', grp.id, grp.gmid, null, grp.gkey, 3::smallint,
           false, grp.stated_net_revenue, grp.tapdash_net_before_split, v_t3
      from grp
     where grp.stated_net_revenue is not null
       and grp.tapdash_net_before_split is not null
  ),
  scored as (
    select raw.*,
           case when raw.exempt then null::numeric
                else round(raw.rv - raw.lv, 4) end as d
      from raw
  )
  select s.sc,
         s.sid,
         s.m,
         s.fi,
         s.gk,
         s.st,
         case when s.exempt              then 'exempt'
              when abs(s.d) <= s.tol     then 'match'
              else                            'mismatch' end,
         s.lv,
         s.rv,
         s.d,
         s.tol,
         a.id,
         -- SUPPRESSION, rule 2. A live ack suppresses only while the delta it
         -- forgave is still the delta, judged by the tolerance IN FORCE NOW
         -- rather than the one captured on the ack: if the bound has since
         -- tightened, an old forgiveness should not go on being honoured under
         -- the looser rule it was written under.
         (a.id is not null
          and not s.exempt
          and abs(s.d) > s.tol
          and abs(s.d - a.delta_acknowledged) <= s.tol) as suppressed
    from scored s
    left join public.residual_verdict_acknowledgments a
           on coalesce(a.line_id, a.group_id) = s.sid
          and a.step = s.st
          and a.retired_at is null
          and a.deleted_at is null
   order by s.m, s.sc, s.fi nulls last, s.gk nulls last, s.st;
end;
$$;


comment on function public.residual_derive_plan_rollup(jsonb, numeric) is
  'Rolls a statement''s plan rows into the four dollar buckets, the four transaction counts and the four credit totals, and reconciles the GROSS derived total against the statement''s stated total. Credits are carried for mappings whose basis is net; they are deliberately NOT part of derived_total or of the reconciliation, which compare what the statement itself prints. SQL only — no JavaScript arithmetic on money.';

comment on function public.residual_verdicts(uuid, text, text) is
  'All three reconciliation steps at both grains, for one period. Step 1 compares each volume-assessed line''s stated Amount against the sum of its mapped buckets, honouring the mapping''s applies_when against the same sibling set the calc engine uses, and subtracting that bucket''s credits where the mapping''s basis is net. Steps 2 and 3 compare the engine''s buy side and net against the processor''s. delta is always computed minus stated; the tolerance test is on its absolute value and the tolerance is effective-dated per step.';

-- ════════════════════════════════════════════════════════════════════════
-- The mapping, corrected by measurement
-- ════════════════════════════════════════════════════════════════════════
-- BOTH registries, for the reason 20260819009728 gives: the report's LAYOUT
-- did not change at the June monthly-fee changeover, only rule #2 did, so
-- seeding one registry would make a recomputed pre-June month report every
-- volume row as unmapped — a gap caused by the seed rather than by the data.

-- ── BIN Sponsorship is assessed NET of refunds ─────────────────────────
update public.residual_volume_row_mappings m
   set basis = 'net',
       notes = 'BIN is assessed on VMD + debit, NET of refunds, plus Amex when '
               'the merchant is not on Cash Discount. Measured on August 2026 '
               '(migration 747): the 91.98 gap on MID 201100272922 is exactly '
               'that statement''s credits, while Cash Disc and Interchange on '
               'the same statement agree on gross.'
  from public.residual_formula_rules ru
 where ru.id = m.rule_id
   and ru.fee_item_name = 'BIN Sponsorship Fees'
   and m.deleted_at is null
   and ru.deleted_at is null;

-- ── and picks up Amex when there is no Cash Discount line ──────────────
-- The same condition BIN's income terms already carry for this exact sibling.
insert into public.residual_volume_row_mappings
  (rule_id, volume_bucket, applies_when, sibling_fee_item_name, basis, notes)
select ru.id,
       'amex_volume',
       'sibling_absent',
       'Cash Disc/Surcharge Program',
       'net',
       'Amex counts towards BIN only when the merchant is NOT on Cash Discount, '
       'which accounts for Amex itself. Measured on August 2026: the report''s '
       'BIN volume exceeds vmd+debit by exactly the Amex volume on MID '
       '30119889965 (10,777.00) and on MID 201100241497, and matches vmd+debit '
       'exactly on the two merchants that do carry a Cash Discount line.'
  from public.residual_formula_rules ru
 where ru.fee_item_name = 'BIN Sponsorship Fees'
   and ru.deleted_at is null
   and not exists (
     select 1 from public.residual_volume_row_mappings x
      where x.rule_id = ru.id
        and x.volume_bucket = 'amex_volume'
        and x.deleted_at is null
   );

-- ── EBT: still open, now for a measured reason ─────────────────────────
update public.residual_volume_row_mappings m
   set notes = m.notes || ' [747: still unarbitrated. The first overlapping '
               'merchant-month was expected to settle whether EBT belongs '
               'inside the BIN and Cash Disc sums, but none of August 2026''s '
               'seven statements carries any EBT volume at all, so it could '
               'not. A statement for an EBT merchant settles it.]'
  from public.residual_formula_rules ru
 where ru.id = m.rule_id
   and m.volume_bucket = 'ebt_volume'
   and m.deleted_at is null
   and ru.deleted_at is null;

-- ── the step-1 tolerance is now a measurement ──────────────────────────
-- The VALUE is unchanged, so this opens no dated successor and cannot
-- disturb a reconciled month — only the claim about where the number came
-- from changes.
update public.residual_verdict_tolerances
   set notes = 'MEASURED on August 2026 (migration 747), replacing the '
               'placeholder. Sixteen step-1 comparisons, the first this project '
               'has ever had: fifteen agree to the cent once the BIN mapping is '
               'corrected for net-of-refunds and conditional Amex, and the one '
               'that does not is MID 201100241497 at 1.34 on 430,881.10. Exact '
               'agreement is therefore the norm, so 0.05 forgives nothing '
               'material and still surfaces that 1.34. Kept at 0.05 because the '
               'measurement supports it, not because it was already there.'
 where step = 1
   and deleted_at is null
   and effective_to is null;

-- `create or replace` preserves a function's ACL, so these restate rather than
-- change it — the house style keeps them beside the definition so a reader
-- never has to go looking for who can execute what.
revoke all on function public.residual_derive_plan_rollup(jsonb, numeric) from public;
grant execute on function public.residual_derive_plan_rollup(jsonb, numeric) to authenticated;

revoke all on function public.commit_residual_pdf_import(uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.commit_residual_pdf_import(uuid, uuid, jsonb, jsonb) to authenticated;

revoke all on function public.residual_verdicts(uuid, text, text) from public, anon, service_role;
grant execute on function public.residual_verdicts(uuid, text, text) to authenticated;

commit;
