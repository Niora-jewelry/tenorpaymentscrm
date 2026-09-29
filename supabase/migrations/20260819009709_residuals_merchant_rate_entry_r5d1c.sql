-- Ported from Daniel Weissman's residuals branch, file
-- `20260829120000_residuals_merchant_rate_entry_r5d1c.sql`.
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
-- Residuals R5d Part 1c — merchant rate ENTRY: importer + panel
-- ============================================================
--
-- STRICTLY ADDITIVE except one widened CHECK on residual_imports.source_type.
-- No table gains or loses a column, no seeded row is edited, no policy is
-- narrowed.
--
-- WHY THIS EXISTS. residual_merchant_rates_for_month() raises for all 21 MIDs
-- carrying May 2026 fee lines, because no merchant has rates. The Part 2
-- engine can be written but cannot produce a number, and
-- 20260828130000 (retire the drawer fields) stays blocked until an entry path
-- exists. This migration is the SQL half of that entry path: three RPCs and
-- one guard. The app half is the importer wizard and the rates panel.
--
-- MONEY RULE unchanged: dollars numeric(14,2), rates numeric(14,6), no float,
-- every sum and every cast in SQL.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. residual_imports.source_type gains 'merchant_rates'
-- ============================================================
-- WHY KEEP AN IMPORT ROW AT ALL, when this is reference data rather than a
-- periodic statement. Two reasons, and the second is load-bearing:
--
--   a) A file that writes money-adjacent reference data should be traceable
--      to the file. residual_imports already carries original_filename,
--      size_bytes, storage_path, row_count and the actor.
--
--   b) IT IS WHAT MAKES "UNCHANGED -> NO NEW ROW" SAFE. The importer
--      deliberately writes NO rate row for a merchant whose values have not
--      moved (section 4). The objection to that is "we lose the evidence that
--      the file re-confirmed these values on date X". We do not: that
--      evidence belongs on the import record, which says a file was read on a
--      date and how many rows it matched. Putting it on the rate table
--      instead would mean a version that changes nothing, which makes the
--      history unreadable — you could no longer tell which versions represent
--      real repricing.
--
-- A NEW source_type VALUE RATHER THAN REUSING 'excel'. Two consequences, both
-- wanted. It keeps merchant-rate imports distinguishable from fee-report
-- imports in the admin list. And R4a's supersede sweep keys on
-- `ri.source_type = v_source_type`, so a distinct value is automatically
-- outside the sweep's scope — a merchant-rate import can never be mistaken
-- for a superseded fee-report import and have its lines swept.
--
-- The (processor, period_id, source_type) idempotency index does not apply
-- here either: it is partial on `period_id IS NOT NULL`, and merchant rates
-- have no period. Nothing to disarm.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'residual_imports_source_type_check'
      and conrelid = 'public.residual_imports'::regclass
  ) then
    alter table public.residual_imports
      drop constraint residual_imports_source_type_check;
  end if;

  alter table public.residual_imports
    add constraint residual_imports_source_type_check
    check (source_type in ('excel', 'pdf', 'merchant_rates'));
end$$;

comment on column public.residual_imports.source_type is
  'excel = processor fee report (R4a); pdf = merchant statement (R4b); merchant_rates = the TapDash sell-side rate sheet (R5d 1c). A merchant_rates row has period_id NULL and processor NULL — it is reference data, not a period''s artifact — which also keeps it outside R4a''s supersede sweep and outside the (processor, period_id, source_type) idempotency index.';

-- ============================================================
-- 2. residual_merchant_rate_is_locked — has this version been used?
-- ============================================================
-- A rate version is LOCKED once a period it covers has been computed and the
-- computation still stands. Editing it in place would silently change the
-- basis of a number somebody has already seen, with no version history
-- showing that anything moved.
--
-- "STILL STANDS" IS calculation_version IS NOT NULL, and that is precise
-- rather than approximate: R5d Part 1's invalidation trigger nulls
-- calculation_version the moment any line's stated data changes, so a
-- non-null version means the stored outputs are current for the lines that
-- exist now. A period whose version has been invalidated is not locked,
-- because nothing standing depends on these rates.
--
-- THE MID FILTER MATTERS. A computed period locks only the rate versions of
-- the merchants that actually had lines in it. A merchant boarded but never
-- billed has nothing depending on its rates, so its first version stays
-- freely editable, which is the common case during setup.
create or replace function public.residual_merchant_rate_is_locked(
  p_mid  text,
  p_from date,
  p_to   date
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.residual_periods p
     where p.deleted_at is null
       and p.calculation_version is not null
       and p.statement_month >= p_from
       and (p_to is null or p.statement_month < p_to)
       and exists (
         select 1 from public.residual_lines l
          where l.period_id = p.id
            and l.deleted_at is null
            and regexp_replace(l.mid, '[^0-9]', '', 'g') = p_mid
       )
  );
$$;

comment on function public.residual_merchant_rate_is_locked(text, date, date) is
  'True when a computed, still-standing period falls inside this rate version''s effective range AND that period carried lines for this MID. The test for "this version has been used to produce a number somebody has seen".';

revoke all on function public.residual_merchant_rate_is_locked(text, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_rate_is_locked(text, date, date)
  to authenticated;

-- ============================================================
-- 3. The in-place-edit guard
-- ============================================================
-- NOTE WHAT IS DELIBERATELY *NOT* GUARDED: effective_to.
--
-- Closing a standing row is how a successor is created, and it must stay
-- legal on a locked row — otherwise a merchant whose rates have ever been
-- used could never be repriced at all. Closing does not change what the
-- version SAYS about the months it already covered; it only stops it
-- covering later ones. Editing a rate, the tier, or effective_from DOES
-- rewrite history, and so does soft-deleting the row, which is why
-- deleted_at is in the guarded list and effective_to is not.
create or replace function public.tg_residual_merchant_rates_guard_locked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.residual_merchant_rate_is_locked(old.mid, old.effective_from, old.effective_to) then
    raise exception
      'Merchant rate version for MID % (% to %) has been used in a computed period and cannot be edited in place.',
      old.mid, old.effective_from, coalesce(old.effective_to::text, 'open')
      using errcode = '42501',
            hint = 'Create a dated successor instead: residual_supersede_merchant_rate().';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_residual_merchant_rates_guard_locked()
  from public, anon, authenticated, service_role;

drop trigger if exists residual_merchant_rates_guard_locked
  on public.residual_merchant_rates;
create trigger residual_merchant_rates_guard_locked
  before update of
    risk_tier, effective_from, deleted_at,
    vmd_auth_fee, pin_debit_auth_fee, avs_fee, batch_fee, vmd_transaction_fee,
    amex_volume, vmd_volume, pin_debit_volume, amex_template_volume_fee,
    gateway_provider_mav, gateway_monthly_mav,
    terminal_provider_mav, terminal_monthly_mav,
    monthly_fee_tapdash, monthly_fee_maverick, chargeback_fee
  on public.residual_merchant_rates
  for each row execute function public.tg_residual_merchant_rates_guard_locked();

-- ============================================================
-- 4. residual_supersede_merchant_rate — the atomic close-and-insert
-- ============================================================
-- THE OPERATION THAT MUST NOT BE TWO ROUND TRIPS. Closing the standing row
-- and inserting its successor are one fact. Split across two client calls,
-- a failure between them leaves either a merchant with NO rates in effect
-- (the close succeeded, the insert did not — and the engine then raises for
-- a merchant that is perfectly well configured), or an EXCLUDE violation.
--
-- ORDERING IS FORCED BY THE EXCLUDE CONSTRAINT, which is not DEFERRABLE:
-- the standing row must be closed BEFORE the successor is inserted, or the
-- two open-ended ranges overlap and the insert is rejected. Inside one
-- function this is just statement order; across two calls it is a race.
--
-- p_values IS A jsonb OBJECT of column name -> value. Absent key and JSON
-- null both mean SQL NULL, which is the "no arrangement" state that must
-- fail loud at calc time. There is no way to express "leave this one as it
-- was": a successor states the merchant's WHOLE rate card as of its date,
-- because a version that only says what changed cannot be read on its own.
create or replace function public.residual_supersede_merchant_rate(
  p_mid            text,
  p_effective_from date,
  p_risk_tier      text,
  p_values         jsonb,
  p_notes          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mid       text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
  v_from      date := p_effective_from;
  v_actor     uuid := auth.uid();
  v_standing  public.residual_merchant_rates%rowtype;
  v_new_id    uuid;
  v_closed    uuid;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to change merchant rates.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'residual_supersede_merchant_rate: p_mid must contain digits.'
      using errcode = '22004';
  end if;

  if v_from is null or extract(day from v_from) <> 1 then
    raise exception 'residual_supersede_merchant_rate: p_effective_from must be the 1st of a month.'
      using errcode = '22007';
  end if;

  if not exists (
    select 1 from public.residual_risk_tiers t
     where t.tier_key = p_risk_tier and t.deleted_at is null
  ) then
    raise exception 'Unknown risk tier %.', p_risk_tier
      using errcode = '23503';
  end if;

  -- The row in force at (or after) the new date, if any.
  select * into v_standing
    from public.residual_merchant_rates r
   where r.deleted_at is null
     and r.mid = v_mid
     and (r.effective_to is null or r.effective_to > v_from)
   order by r.effective_from
   limit 1;

  -- BACKDATING IS REFUSED RATHER THAN GUESSED AT. A successor dated at or
  -- before the standing version's own start cannot be expressed: closing the
  -- standing row would need effective_to <= effective_from, which the range
  -- CHECK forbids. Correcting a historical version is a different operation
  -- with different consequences (it rewrites months that may already be
  -- computed), so it is not something this function should quietly attempt.
  if v_standing.id is not null and v_standing.effective_from >= v_from then
    raise exception
      'MID % already has a rate version starting % (on or after %). Backdating is not supported here.',
      v_mid, v_standing.effective_from, v_from
      using errcode = '22007',
            hint = 'Pick a later effective month, or correct the existing version directly if it has not been used in a computed period.';
  end if;

  -- Close first. The guard trigger deliberately does not cover effective_to,
  -- so this succeeds even when the standing version is locked.
  if v_standing.id is not null then
    update public.residual_merchant_rates
       set effective_to = v_from,
           updated_by_id = v_actor
     where id = v_standing.id;
    v_closed := v_standing.id;
  end if;

  insert into public.residual_merchant_rates (
    mid, effective_from, effective_to, risk_tier,
    vmd_auth_fee, pin_debit_auth_fee, avs_fee, batch_fee, vmd_transaction_fee,
    amex_volume, vmd_volume, pin_debit_volume, amex_template_volume_fee,
    gateway_provider_mav, gateway_monthly_mav,
    terminal_provider_mav, terminal_monthly_mav,
    monthly_fee_tapdash, monthly_fee_maverick, chargeback_fee,
    notes, created_by_id, updated_by_id
  ) values (
    v_mid, v_from, null, p_risk_tier,
    (p_values->>'vmd_auth_fee')::numeric(14,6),
    (p_values->>'pin_debit_auth_fee')::numeric(14,6),
    (p_values->>'avs_fee')::numeric(14,6),
    (p_values->>'batch_fee')::numeric(14,6),
    (p_values->>'vmd_transaction_fee')::numeric(14,6),
    (p_values->>'amex_volume')::numeric(14,6),
    (p_values->>'vmd_volume')::numeric(14,6),
    (p_values->>'pin_debit_volume')::numeric(14,6),
    (p_values->>'amex_template_volume_fee')::numeric(14,6),
    nullif(btrim(coalesce(p_values->>'gateway_provider_mav', '')), ''),
    (p_values->>'gateway_monthly_mav')::numeric(14,6),
    nullif(btrim(coalesce(p_values->>'terminal_provider_mav', '')), ''),
    (p_values->>'terminal_monthly_mav')::numeric(14,6),
    (p_values->>'monthly_fee_tapdash')::numeric(14,6),
    (p_values->>'monthly_fee_maverick')::numeric(14,6),
    (p_values->>'chargeback_fee')::numeric(14,6),
    p_notes, v_actor, v_actor
  )
  returning id into v_new_id;

  return jsonb_build_object(
    'mid', v_mid,
    'inserted_id', v_new_id,
    'closed_id', v_closed,
    'effective_from', v_from
  );
end;
$$;

comment on function public.residual_supersede_merchant_rate(text, date, text, jsonb, text) is
  'Closes the standing rate version and inserts its dated successor, atomically. Must be one call: the EXCLUDE constraint is not deferrable, so close-then-insert is forced ordering, and a failure between two client calls would leave a merchant with no rates in effect. A successor states the merchant''s WHOLE rate card as of its date.';

revoke all on function public.residual_supersede_merchant_rate(text, date, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_supersede_merchant_rate(text, date, text, jsonb, text)
  to authenticated;

-- ============================================================
-- 5. residual_merchant_rate_versions — the history read
-- ============================================================
create or replace function public.residual_merchant_rate_versions(
  p_mid text
)
returns table (
  id                        uuid,
  effective_from            date,
  effective_to              date,
  is_standing               boolean,
  is_locked                 boolean,
  risk_tier                 text,
  vmd_auth_fee              numeric(14,6),
  pin_debit_auth_fee        numeric(14,6),
  avs_fee                   numeric(14,6),
  batch_fee                 numeric(14,6),
  vmd_transaction_fee       numeric(14,6),
  amex_volume               numeric(14,6),
  vmd_volume                numeric(14,6),
  pin_debit_volume          numeric(14,6),
  amex_template_volume_fee  numeric(14,6),
  gateway_provider_mav      text,
  gateway_monthly_mav       numeric(14,6),
  terminal_provider_mav     text,
  terminal_monthly_mav      numeric(14,6),
  monthly_fee_tapdash       numeric(14,6),
  monthly_fee_maverick      numeric(14,6),
  chargeback_fee            numeric(14,6),
  notes                     text,
  created_at                timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_mid text := regexp_replace(coalesce(p_mid, ''), '[^0-9]', '', 'g');
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read merchant rates.'
      using errcode = '42501';
  end if;

  return query
    select r.id, r.effective_from, r.effective_to,
           r.effective_to is null,
           public.residual_merchant_rate_is_locked(r.mid, r.effective_from, r.effective_to),
           r.risk_tier,
           r.vmd_auth_fee, r.pin_debit_auth_fee, r.avs_fee, r.batch_fee,
           r.vmd_transaction_fee, r.amex_volume, r.vmd_volume,
           r.pin_debit_volume, r.amex_template_volume_fee,
           r.gateway_provider_mav, r.gateway_monthly_mav,
           r.terminal_provider_mav, r.terminal_monthly_mav,
           r.monthly_fee_tapdash, r.monthly_fee_maverick, r.chargeback_fee,
           r.notes, r.created_at
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.mid = v_mid
     order by r.effective_from desc;
end;
$$;

comment on function public.residual_merchant_rate_versions(text) is
  'Full version history for one MID, newest first, with is_standing and is_locked computed per row. is_locked drives whether the panel offers "edit" or only "create successor".';

revoke all on function public.residual_merchant_rate_versions(text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_merchant_rate_versions(text)
  to authenticated;

-- ============================================================
-- 6. commit_residual_merchant_rates_import — the importer's one call
-- ============================================================
-- ALL-OR-NOTHING, AND THAT IS THE POINT. A half-loaded rate table is worse
-- than an unloaded one: coverage would report partial success, somebody would
-- run the engine, and the merchants that failed to load would raise while the
-- ones that loaded would produce numbers — a run that looks like it worked.
-- Every row is validated before any row is written; one bad row rejects the
-- file and names every problem found.
--
-- That is only tolerable because the WIZARD SHOWS THE SAME VALIDATION IN A
-- PREVIEW before the operator commits. Reaching this function with a bad row
-- means the file changed under them, which is worth failing on.
--
-- WHAT THIS DELIBERATELY DOES NOT DO, and why, against the R4a pipeline it
-- otherwise resembles:
--
--   * NO SUPERSEDE SWEEP. R4a sweeps because a re-imported fee report
--     REPLACES the previous one for that month — two imports of the same
--     month are two attempts at one fact. Reference data is not replaced, it
--     is VERSIONED: a re-import is a new dated statement of the rate card,
--     and the previous version stays true of the months it covered.
--
--   * NO (processor, period_id, source_type) IDEMPOTENCY TRIPLE. There is no
--     period. Idempotency comes from the value comparison in section 6c
--     instead: importing the same file twice at the same date writes nothing
--     the second time, because nothing changed.
--
--     >> CORRECTION (annotation added after this migration was applied; the
--     >> SQL below is untouched and is the record of what ran).
--     >>
--     >> THAT LAST SENTENCE WAS FALSE AS SHIPPED. The backdating check in 6a
--     >> runs during validation and rejected a same-date re-import with 23514
--     >> before 6c's comparison was ever reached; idempotency by value only
--     >> worked at a LATER date. Fixed in
--     >> 20260829140000_residuals_merchant_rate_import_idempotency_r5d1c.sql,
--     >> which replaces this function so that an exact-date, exact-value
--     >> re-import is exempted from the backdating error and counted
--     >> unchanged — while the same date with any value CHANGED stays 23514.
--     >> That migration also extracts the seventeen-field comparison into
--     >> residual_merchant_rate_unchanged(), called from both passes.
--
--   * NO residual_column_mappings. R4a's mapping table exists because vendor
--     fee reports have unstable headers that differ per processor. This sheet
--     is TapDash's OWN internal workbook with a fixed layout, and the target
--     columns are a closed set. A mapping table would be a configurable
--     indirection over a layout nobody else controls, and a second place the
--     layout is described. The parser pins the columns in code and fails loud
--     on an unexpected header, which is the same protection without the
--     second source of truth.
--
-- p_rows: jsonb array. Each element is
--   { "mid": "...", "risk_code": 2, "notes": "...", <rate column>: number|null }
-- The client has already resolved the workbook's three cell states —
-- number / "$ -" / blank — into number / 0 / null. SQL re-validates rather
-- than re-interprets.
create or replace function public.commit_residual_merchant_rates_import(
  p_import_id      uuid,
  p_effective_from date,
  p_rows           jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor     uuid := auth.uid();
  v_from      date := p_effective_from;
  v_elem      jsonb;
  v_mid       text;
  v_tier      text;
  v_errors    text[] := '{}';
  v_inserted  int := 0;
  v_unchanged int := 0;
  v_closed    int := 0;
  v_standing  public.residual_merchant_rates%rowtype;
  v_seen      text[] := '{}';
  v_vol       numeric;
  v_key       text;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to import merchant rates.'
      using errcode = '42501';
  end if;

  if v_from is null or extract(day from v_from) <> 1 then
    raise exception 'commit_residual_merchant_rates_import: p_effective_from must be the 1st of a month.'
      using errcode = '22007';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'commit_residual_merchant_rates_import: p_rows must be a non-empty array.'
      using errcode = '22004';
  end if;

  -- ---------- 6a. validate every row before writing any ----------
  for v_elem in select * from jsonb_array_elements(p_rows) loop
    v_mid := regexp_replace(coalesce(v_elem->>'mid', ''), '[^0-9]', '', 'g');

    if v_mid = '' then
      v_errors := v_errors || format('row with merchant "%s": no digits in MID',
                                     coalesce(v_elem->>'merchant_name', '?'));
      continue;
    end if;

    -- A MID twice in one file is an ambiguity, not a merge: the two rows
    -- would fight over one dated version and the last one would silently win.
    --
    -- THE BACKDATING CHECK BELOW DEPENDS ON THIS ONE. It validates each row
    -- against the PRE-WRITE state of residual_merchant_rates, which is only
    -- sound while no two rows in the file touch the same MID — otherwise the
    -- second row for a MID would be checked against a standing version that
    -- the first row is about to close, and a genuine conflict could pass
    -- validation and then fail (or worse, silently succeed) in the write loop.
    -- IF THIS CHECK IS EVER RELAXED — to "merge duplicates", say, or to take
    -- the last row wins — the backdating check must be reworked in the same
    -- change to simulate the file's own writes.
    if v_mid = any(v_seen) then
      v_errors := v_errors || format('MID %s appears more than once in the file', v_mid);
      continue;
    end if;
    v_seen := v_seen || v_mid;

    -- RISK TIER RESOLVES THROUGH residual_risk_tiers.statement_code, never a
    -- hardcoded 1/2/3 map. That table exists to own this vocabulary and R5c
    -- seeded it; a second copy of the mapping here is how the two drift.
    select t.tier_key into v_tier
      from public.residual_risk_tiers t
     where t.statement_code = (v_elem->>'risk_code')::int
       and t.deleted_at is null;

    if v_tier is null then
      v_errors := v_errors || format('MID %s: risk code %s matches no live risk tier',
                                     v_mid, coalesce(v_elem->>'risk_code', 'NULL'));
    end if;

    -- PERCENT-SCALE GUARD. The workbook stores volume rates as unscaled
    -- decimal fractions (0.0385 = 3.85%), and a CSV export of those columns
    -- renders them as "3.85%" instead. A percent-scaled value is exactly 100x
    -- the true one — silent, and it would propagate into every income figure.
    --
    -- THE THRESHOLD IS 0.10, DERIVED FROM THE DATA RATHER THAN CHOSEN.
    -- Measured across all 104 volume-rate values in the source sheet (four
    -- columns x 33 merchants, numeric cells only):
    --
    --     real values        span [0.001,  0.047619]   (0.1% .. 4.7619%)
    --     the same values
    --       percent-scaled   span [0.1,    4.7619  ]
    --
    -- THE TWO POPULATIONS ARE DISJOINT, with a 2.10x gap between the largest
    -- real value (0.047619) and the smallest possible scaled one (0.1, which
    -- is 100 x the smallest real rate). Any threshold in that gap separates
    -- them perfectly, and 0.10 is chosen from within it because:
    --
    --   * it sits EXACTLY at the scaled floor, so a scale error is caught even
    --     on the smallest rate in the book — hence >= rather than >;
    --   * it leaves 2.10x headroom above the largest real rate. 0.05 would
    --     also separate the observed data but only by 1.05x, and the book
    --     already contains a "5% Dual pricing" merchant whose rate is
    --     0.047619 — a slightly different 5% program could legitimately land
    --     on 0.05 and be falsely rejected, with no override path.
    --
    -- Scored against every observed value, false rejections / missed scale
    -- errors: >=0.10 gives 0/0. >=0.25 gives 0/11 — eleven real rates are
    -- below 0.0025, so scaled they land under 0.25 and slip through. >=0.5
    -- (the original) gives 0/24.
    --
    -- RESIDUAL GAP, STATED HONESTLY: a percent-scaled value derived from a
    -- true rate below 0.1% would land under 0.10 and not be caught. No such
    -- rate exists in the 104 observations, and a volume fee that small would
    -- be unusual, but the guard is a net not a proof.
    --
    -- NO LOWER BOUND, DELIBERATELY. There is no implausible band just above
    -- zero to guard: the real values run continuously down to 0.001 with no
    -- gap, "$ -" already produces legitimate exact zeros through a different
    -- path, and nothing in the data shows a characteristic unit error landing
    -- low. A lower guard would buy false rejections and detect nothing.
    --
    -- IT REJECTS RATHER THAN DIVIDING BY 100. Auto-scaling would make a wrong
    -- file load successfully, and would half-correct a file that mixed both
    -- conventions. The message names the observed maximum so an operator can
    -- tell a genuine outlier from a scale error.
    foreach v_key in array array['amex_volume','vmd_volume','pin_debit_volume','amex_template_volume_fee'] loop
      v_vol := (v_elem->>v_key)::numeric;
      if v_vol is not null and v_vol >= 0.10 then
        v_errors := v_errors || format(
          'MID %s: %s is %s. Volume rates are unscaled decimal fractions (0.0385 = 3.85%%) and the largest rate observed in the source sheet is 0.047619 (4.7619%%). A value at or above 0.10 is almost certainly percent-scaled — 100x too large. It is rejected, not rescaled: fix it at source.',
          v_mid, v_key, v_vol);
      end if;
    end loop;

    foreach v_key in array array[
      'vmd_auth_fee','pin_debit_auth_fee','avs_fee','batch_fee','vmd_transaction_fee',
      'amex_volume','vmd_volume','pin_debit_volume','amex_template_volume_fee',
      'gateway_monthly_mav','terminal_monthly_mav',
      'monthly_fee_tapdash','monthly_fee_maverick','chargeback_fee'
    ] loop
      v_vol := (v_elem->>v_key)::numeric;
      if v_vol is not null and v_vol < 0 then
        v_errors := v_errors || format('MID %s: %s is negative (%s)', v_mid, v_key, v_vol);
      end if;
    end loop;

    -- Backdating check, same rule as residual_supersede_merchant_rate.
    --
    -- ASSUMES AT MOST ONE ROW PER MID IN THE FILE, which the duplicate-MID
    -- check above enforces. This reads the PRE-WRITE state — nothing has been
    -- written yet, by design — so it is only correct while no earlier row in
    -- the same file could have changed this MID's standing version. That
    -- property comes entirely from the duplicate check; it is not implied by
    -- anything here.
    select * into v_standing
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.mid = v_mid
       and (r.effective_to is null or r.effective_to > v_from)
     order by r.effective_from
     limit 1;

    if v_standing.id is not null and v_standing.effective_from >= v_from then
      v_errors := v_errors || format(
        'MID %s: already has a version starting %s; cannot import at %s',
        v_mid, v_standing.effective_from, v_from);
    end if;
  end loop;

  if array_length(v_errors, 1) > 0 then
    raise exception 'Merchant rate import rejected (% problem(s)): %',
      array_length(v_errors, 1), array_to_string(v_errors, ' | ')
      using errcode = '23514',
            hint = 'Nothing was written. Fix the file and re-import.';
  end if;

  -- ---------- 6b/6c. write ----------
  for v_elem in select * from jsonb_array_elements(p_rows) loop
    v_mid := regexp_replace(v_elem->>'mid', '[^0-9]', '', 'g');

    select t.tier_key into v_tier
      from public.residual_risk_tiers t
     where t.statement_code = (v_elem->>'risk_code')::int
       and t.deleted_at is null;

    -- RE-SELECTING v_standing HERE IS SAFE, and reads like a re-entrancy
    -- hazard without being one: earlier iterations of this loop may have
    -- closed a standing row, but only ever for a DIFFERENT MID (the
    -- duplicate-MID check guarantees one row per MID), so no iteration can
    -- observe state that an earlier one changed for its own merchant. The
    -- re-select therefore returns exactly what 6a saw for this MID. It is a
    -- re-select rather than a value carried from 6a only because holding one
    -- %rowtype per MID would need an array or a temp table for no gain.
    select * into v_standing
      from public.residual_merchant_rates r
     where r.deleted_at is null
       and r.mid = v_mid
       and (r.effective_to is null or r.effective_to > v_from)
     order by r.effective_from
     limit 1;

    -- 6c. UNCHANGED -> NO NEW ROW.
    -- IS NOT DISTINCT FROM throughout, so NULL = NULL counts as equal. A
    -- plain = would treat two identical "no arrangement" states as different
    -- and write a spurious version on every re-import.
    if v_standing.id is not null
       and v_standing.risk_tier                is not distinct from v_tier
       and v_standing.vmd_auth_fee             is not distinct from (v_elem->>'vmd_auth_fee')::numeric(14,6)
       and v_standing.pin_debit_auth_fee       is not distinct from (v_elem->>'pin_debit_auth_fee')::numeric(14,6)
       and v_standing.avs_fee                  is not distinct from (v_elem->>'avs_fee')::numeric(14,6)
       and v_standing.batch_fee                is not distinct from (v_elem->>'batch_fee')::numeric(14,6)
       and v_standing.vmd_transaction_fee      is not distinct from (v_elem->>'vmd_transaction_fee')::numeric(14,6)
       and v_standing.amex_volume              is not distinct from (v_elem->>'amex_volume')::numeric(14,6)
       and v_standing.vmd_volume               is not distinct from (v_elem->>'vmd_volume')::numeric(14,6)
       and v_standing.pin_debit_volume         is not distinct from (v_elem->>'pin_debit_volume')::numeric(14,6)
       and v_standing.amex_template_volume_fee is not distinct from (v_elem->>'amex_template_volume_fee')::numeric(14,6)
       and v_standing.gateway_monthly_mav      is not distinct from (v_elem->>'gateway_monthly_mav')::numeric(14,6)
       and v_standing.terminal_monthly_mav     is not distinct from (v_elem->>'terminal_monthly_mav')::numeric(14,6)
       and v_standing.monthly_fee_tapdash      is not distinct from (v_elem->>'monthly_fee_tapdash')::numeric(14,6)
       and v_standing.monthly_fee_maverick     is not distinct from (v_elem->>'monthly_fee_maverick')::numeric(14,6)
       and v_standing.chargeback_fee           is not distinct from (v_elem->>'chargeback_fee')::numeric(14,6)
       and v_standing.gateway_provider_mav     is not distinct from nullif(btrim(coalesce(v_elem->>'gateway_provider_mav','')),'')
       and v_standing.terminal_provider_mav    is not distinct from nullif(btrim(coalesce(v_elem->>'terminal_provider_mav','')),'')
    then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    -- Close then insert. Forced order: the EXCLUDE is not deferrable.
    if v_standing.id is not null then
      update public.residual_merchant_rates
         set effective_to = v_from, updated_by_id = v_actor
       where id = v_standing.id;
      v_closed := v_closed + 1;
    end if;

    insert into public.residual_merchant_rates (
      mid, effective_from, effective_to, risk_tier,
      vmd_auth_fee, pin_debit_auth_fee, avs_fee, batch_fee, vmd_transaction_fee,
      amex_volume, vmd_volume, pin_debit_volume, amex_template_volume_fee,
      gateway_provider_mav, gateway_monthly_mav,
      terminal_provider_mav, terminal_monthly_mav,
      monthly_fee_tapdash, monthly_fee_maverick, chargeback_fee,
      notes, created_by_id, updated_by_id
    ) values (
      v_mid, v_from, null, v_tier,
      (v_elem->>'vmd_auth_fee')::numeric(14,6),
      (v_elem->>'pin_debit_auth_fee')::numeric(14,6),
      (v_elem->>'avs_fee')::numeric(14,6),
      (v_elem->>'batch_fee')::numeric(14,6),
      (v_elem->>'vmd_transaction_fee')::numeric(14,6),
      (v_elem->>'amex_volume')::numeric(14,6),
      (v_elem->>'vmd_volume')::numeric(14,6),
      (v_elem->>'pin_debit_volume')::numeric(14,6),
      (v_elem->>'amex_template_volume_fee')::numeric(14,6),
      nullif(btrim(coalesce(v_elem->>'gateway_provider_mav','')),''),
      (v_elem->>'gateway_monthly_mav')::numeric(14,6),
      nullif(btrim(coalesce(v_elem->>'terminal_provider_mav','')),''),
      (v_elem->>'terminal_monthly_mav')::numeric(14,6),
      (v_elem->>'monthly_fee_tapdash')::numeric(14,6),
      (v_elem->>'monthly_fee_maverick')::numeric(14,6),
      (v_elem->>'chargeback_fee')::numeric(14,6),
      nullif(btrim(coalesce(v_elem->>'notes','')),''),
      v_actor, v_actor
    );
    v_inserted := v_inserted + 1;
  end loop;

  update public.residual_imports
     set status = 'completed',
         processed_at = now(),
         row_count = jsonb_array_length(p_rows),
         updated_by_id = v_actor
   where id = p_import_id;

  return jsonb_build_object(
    'effective_from', v_from,
    'rows_read',      jsonb_array_length(p_rows),
    'inserted',       v_inserted,
    'unchanged',      v_unchanged,
    'closed',         v_closed
  );
end;
$$;

comment on function public.commit_residual_merchant_rates_import(uuid, date, jsonb) is
  'Atomic all-or-nothing import of the TapDash sell-side rate sheet. Validates every row first (MID, risk code via residual_risk_tiers.statement_code, percent-scale guard, non-negative, no backdating, no duplicate MID) and writes nothing if any row fails. Merchants whose values are unchanged get NO new version — a version that changes nothing makes the history unreadable, and the fact that a file re-confirmed them lives on the residual_imports row.';

revoke all on function public.commit_residual_merchant_rates_import(uuid, date, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.commit_residual_merchant_rates_import(uuid, date, jsonb)
  to authenticated;

commit;
