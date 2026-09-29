-- Ported from Daniel Weissman's residuals branch, file
-- `20260901130000_residuals_buy_rate_admin_r5d3.sql`.
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
-- Residuals R5d Part 3 — the buy-rate template, administered
-- ============================================================
--
-- The template grid has been read-only reference data since R5c: seeded by
-- migration, read by residual_buy_rates_for_month, editable by nobody. This
-- adds the three things an operator needs and nothing else — see what is in
-- effect, see what it does not cover, and put a dated successor in front of it.
--
-- THE SAME LOCK DISCIPLINE AS MERCHANT RATES, FOR A STRONGER REASON. A
-- merchant rate version, edited in place, silently rewrites the basis of one
-- merchant's numbers. A buy-rate schedule, edited in place, rewrites EVERY
-- merchant's — the schedule is the shared half of every line in the period.
-- So the guard is the same shape as tg_residual_merchant_rates_guard_locked,
-- and it makes the same one exception: closing a schedule stays legal, because
-- closing is how a successor is created and it does not change what the
-- schedule said about the months it already covered.
--
-- WHAT THIS DOES NOT ADD: any way to edit a schedule that is NOT locked. That
-- is not an oversight and it is not a gap the UI works around — the successor
-- is the only write path offered, for locked and unlocked alike. A schedule
-- covers all merchants at once, so "nothing depends on it yet" is a much
-- weaker claim here than it is for one merchant's rate card, and the operator
-- has no way to see, at the moment of editing, that it is still true. The
-- merchant-rate table earns its in-place edit because R5d 1c could name the
-- exact population it applies to (33 merchants, no computed period, a field
-- the sheet simply lacked). Nothing comparable is true of the template.
--
-- MONEY RULE unchanged: rates numeric(14,6), shares numeric, every value cast
-- in SQL, no arithmetic anywhere near TypeScript.
--
-- Idempotent throughout.

begin;

-- ============================================================
-- 1. residual_buy_rate_schedule_is_locked
-- ============================================================
-- True when a computed, STILL-STANDING period falls inside this schedule's
-- effective range. "Still standing" is calculation_version IS NOT NULL, the
-- same test residual_merchant_rate_is_locked uses and for the same reason:
-- R5d Part 1's invalidation trigger nulls that column the moment any line's
-- stated data changes, so a non-null version means the stored outputs are
-- current for the lines that exist now.
--
-- NO MID FILTER, and that is the difference from the merchant-rate version.
-- There, a computed period locks only the merchants that actually had lines in
-- it, because a merchant boarded but never billed has nothing depending on its
-- rates. Here every computed line read this schedule — the tier map is built
-- once per run and every merchant is priced from it — so a computed period in
-- range locks the schedule outright.
create or replace function public.residual_buy_rate_schedule_is_locked(
  p_processor text,
  p_from      date,
  p_to        date
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
  );
$$;

comment on function public.residual_buy_rate_schedule_is_locked(text, date, date) is
  'True when a computed, still-standing period falls inside this buy-rate schedule''s effective range. Unlike the merchant-rate equivalent there is no MID filter: every computed line in a period reads the schedule, so a computed period in range locks it outright. p_processor is accepted for symmetry with the caller and for the day residual_periods becomes processor-attributable — see the LIMITATION note on compute_residual_period.';

revoke all on function public.residual_buy_rate_schedule_is_locked(text, date, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_buy_rate_schedule_is_locked(text, date, date)
  to authenticated;

-- ============================================================
-- 2. The in-place-edit guards
-- ============================================================
-- Three tables, one function. residual_buy_rates and residual_buy_rate_tiers
-- carry no dates of their own — they are keyed by schedule_id — so the guard
-- resolves the schedule and asks it. The schedule's own trigger already has
-- the columns in OLD.
--
-- THE SCHEDULE ID IS READ VIA to_jsonb(old), not by casting OLD to a composite
-- type. OLD is a plpgsql RECORD whose shape differs per table, and a record
-- cannot be cast to a named row type; to_jsonb accepts any record and yields
-- the same value. It is the technique residual_eval_side already uses to reach
-- a column named at runtime, so the module has exactly one answer to
-- "read a column whose owning type is not fixed at write time".
create or replace function public.tg_residual_buy_rate_schedule_guard_locked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sched public.residual_buy_rate_schedules%rowtype;
begin
  if tg_table_name = 'residual_buy_rate_schedules' then
    select s.* into v_sched
      from public.residual_buy_rate_schedules s
     where s.id = (to_jsonb(old) ->> 'id')::uuid;
  else
    select s.* into v_sched
      from public.residual_buy_rate_schedules s
     where s.id = (to_jsonb(old) ->> 'schedule_id')::uuid;
  end if;

  -- A row whose schedule has been hard-deleted cannot be judged, and there is
  -- nothing standing that could depend on it. Refusing here would be a raise
  -- nobody can act on.
  if v_sched.id is null then
    return new;
  end if;

  if public.residual_buy_rate_schedule_is_locked(
       v_sched.processor, v_sched.effective_from, v_sched.effective_to) then
    raise exception
      'Buy-rate schedule "%" (% to %) has been used in a computed period and cannot be edited in place.',
      v_sched.label, v_sched.effective_from,
      coalesce(v_sched.effective_to::text, 'open')
      using errcode = '42501',
            hint = 'Open a dated successor instead: residual_supersede_buy_rate_schedule().';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_residual_buy_rate_schedule_guard_locked()
  from public, anon, authenticated, service_role;

-- NOTE WHAT IS DELIBERATELY *NOT* GUARDED on the schedule: effective_to.
-- Closing is how a successor is created and must stay legal on a locked
-- schedule, exactly as it does for a locked merchant rate version.
drop trigger if exists residual_buy_rate_schedules_guard_locked
  on public.residual_buy_rate_schedules;
create trigger residual_buy_rate_schedules_guard_locked
  before update of processor, label, effective_from, deleted_at
  on public.residual_buy_rate_schedules
  for each row execute function public.tg_residual_buy_rate_schedule_guard_locked();

drop trigger if exists residual_buy_rate_tiers_guard_locked
  on public.residual_buy_rate_tiers;
create trigger residual_buy_rate_tiers_guard_locked
  before update of risk_tier, tapdash_share, deleted_at
  on public.residual_buy_rate_tiers
  for each row execute function public.tg_residual_buy_rate_schedule_guard_locked();

drop trigger if exists residual_buy_rates_guard_locked
  on public.residual_buy_rates;
create trigger residual_buy_rates_guard_locked
  before update of risk_tier, fee_item_key, rate, deleted_at
  on public.residual_buy_rates
  for each row execute function public.tg_residual_buy_rate_schedule_guard_locked();

-- ============================================================
-- 3. residual_buy_rate_schedules_list — what exists, and its state
-- ============================================================
-- ONE read for the screen's header: every schedule for the processor, whether
-- it is the one in force for the month being viewed, whether anything computed
-- depends on it, and how much of the grid it actually fills.
--
-- cell_count IS REPORTED, AND IT IS RAGGED ON PURPOSE. The supplied Maverick
-- grid has 12 rates at the low tier and 11 at each of the others, because the
-- source workbook genuinely leaves cells blank. An absent cell is NOT zero —
-- the engine reports missing_template_rate for it — so the count is shown
-- rather than a "complete/incomplete" verdict this function has no business
-- reaching.
create or replace function public.residual_buy_rate_schedules_list(
  p_processor text,
  p_month     date default null
)
returns table (
  id             uuid,
  label          text,
  effective_from date,
  effective_to   date,
  notes          text,
  is_in_effect   boolean,
  is_locked      boolean,
  tier_count     integer,
  cell_count     integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- AN EXPLICIT RAISE, NOT A WHERE CLAUSE. Folding the gate into the query
  -- would return zero rows to an unauthorized caller, and zero schedules is a
  -- state this processor can genuinely be in — the screen would say "no
  -- schedule has ever been loaded" to someone who simply lacks the role. The
  -- gate is written as `is null or not in` so it fails closed on a
  -- service-role connection, where auth.uid() and therefore auth_role() are
  -- NULL.
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read buy-rate schedules.'
      using errcode = '42501';
  end if;

  return query
  select s.id,
         s.label,
         s.effective_from,
         s.effective_to,
         s.notes,
         (p_month is not null
            and s.effective_from <= p_month
            and (s.effective_to is null or s.effective_to > p_month)) as is_in_effect,
         public.residual_buy_rate_schedule_is_locked(
           s.processor, s.effective_from, s.effective_to) as is_locked,
         (select count(*)::int from public.residual_buy_rate_tiers t
           where t.schedule_id = s.id and t.deleted_at is null) as tier_count,
         (select count(*)::int from public.residual_buy_rates b
           where b.schedule_id = s.id and b.deleted_at is null) as cell_count
    from public.residual_buy_rate_schedules s
   where s.deleted_at is null
     and s.processor = upper(btrim(coalesce(p_processor, '')))
   order by s.effective_from desc;
end;
$$;

comment on function public.residual_buy_rate_schedules_list(text, date) is
  'Every buy-rate schedule for a processor with the state the admin screen needs: which one covers p_month, whether a computed period locks it, and how many tiers and grid cells it fills. cell_count is reported rather than judged complete — the supplied grid is genuinely ragged, and an absent cell is not zero.';

revoke all on function public.residual_buy_rate_schedules_list(text, date)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_buy_rate_schedules_list(text, date)
  to authenticated;

-- ============================================================
-- 4. residual_supersede_buy_rate_schedule — the atomic close-and-open
-- ============================================================
-- ONE CALL, for the same reason residual_supersede_merchant_rate is one call,
-- and with more at stake. Four writes make up a successor: close the standing
-- schedule, insert the new one, insert its tiers, insert its cells. The
-- EXCLUDE constraint on (processor, daterange) is not deferrable, so the close
-- must precede the insert; and residual_buy_rates carries a composite FK to
-- (schedule_id, risk_tier), so the tiers must precede the cells. Split across
-- client calls, a failure part-way leaves either no schedule in effect — and
-- then residual_buy_rates_for_month returns nothing and the engine's build of
-- the tier map raises for the whole run — or a schedule with tiers and no
-- rates, which is worse, because every line computes and every buy rate is
-- reported missing.
--
-- p_tiers IS AN OBJECT, p_cells AN ARRAY, AND tapdash_share LIVES ONLY IN
-- p_tiers. The schema separated the share from the fee-item rates in R5c
-- because they are different things that the workbook happens to print in the
-- same block: the share is one number per tier that scales the whole net, the
-- rates are per fee item. Accepting the share as just another cell would
-- re-merge them at the only point where it would be expensive to discover —
-- inside the write.
--
-- A SUCCESSOR STATES THE WHOLE GRID, exactly as a merchant successor states
-- the whole rate card. There is no "leave this cell as it was": a schedule
-- that only says what changed cannot be read on its own, and reading a
-- schedule on its own is what the engine does every run.
create or replace function public.residual_supersede_buy_rate_schedule(
  p_processor      text,
  p_effective_from date,
  p_label          text,
  p_tiers          jsonb,
  p_cells          jsonb,
  p_notes          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proc     text := upper(btrim(coalesce(p_processor, '')));
  v_from     date := p_effective_from;
  v_actor    uuid := auth.uid();
  v_standing public.residual_buy_rate_schedules%rowtype;
  v_new_id   uuid;
  v_closed   uuid;
  v_tiers    int := 0;
  v_cells    int := 0;
  v_bad      text;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to change buy-rate schedules.'
      using errcode = '42501';
  end if;

  if v_proc = '' then
    raise exception 'residual_supersede_buy_rate_schedule: p_processor is required.'
      using errcode = '22004';
  end if;

  if v_from is null or extract(day from v_from) <> 1 then
    raise exception 'residual_supersede_buy_rate_schedule: p_effective_from must be the 1st of a month.'
      using errcode = '22007';
  end if;

  if length(btrim(coalesce(p_label, ''))) = 0 then
    raise exception 'residual_supersede_buy_rate_schedule: a label is required.'
      using errcode = '22004';
  end if;

  if p_tiers is null or jsonb_typeof(p_tiers) <> 'object'
     or (select count(*) from jsonb_object_keys(p_tiers)) = 0 then
    raise exception 'residual_supersede_buy_rate_schedule: p_tiers must be a non-empty object of tier_key -> tapdash_share.'
      using errcode = '22004';
  end if;

  if p_cells is null or jsonb_typeof(p_cells) <> 'array' then
    raise exception 'residual_supersede_buy_rate_schedule: p_cells must be an array of {risk_tier, fee_item_key, rate}.'
      using errcode = '22004';
  end if;

  -- ---- validate before writing anything ----
  -- Every tier must be a real tier. The FK would catch this on insert, but the
  -- message it gives names a constraint rather than the value, and by then the
  -- close has already happened inside this transaction.
  select string_agg(k, ', ') into v_bad
    from jsonb_object_keys(p_tiers) k
   where not exists (
     select 1 from public.residual_risk_tiers t
      where t.tier_key = k and t.deleted_at is null);
  if v_bad is not null then
    raise exception 'Unknown risk tier(s): %.', v_bad using errcode = '23503';
  end if;

  select string_agg(distinct c.risk_tier, ', ') into v_bad
    from jsonb_to_recordset(p_cells) as c(risk_tier text, fee_item_key text, rate numeric)
   where not (p_tiers ? c.risk_tier);
  if v_bad is not null then
    raise exception
      'p_cells names tier(s) the schedule does not define: %. Every tier carrying a rate must appear in p_tiers with its tapdash_share.',
      v_bad using errcode = '23503';
  end if;

  select string_agg(distinct c.fee_item_key, ', ') into v_bad
    from jsonb_to_recordset(p_cells) as c(risk_tier text, fee_item_key text, rate numeric)
   where not exists (
     select 1 from public.residual_fee_items f
      where f.fee_item_key = c.fee_item_key and f.deleted_at is null);
  if v_bad is not null then
    raise exception 'Unknown fee item(s): %.', v_bad using errcode = '23503';
  end if;

  -- ---- the schedule in force at or after the new date ----
  select * into v_standing
    from public.residual_buy_rate_schedules s
   where s.deleted_at is null
     and s.processor = v_proc
     and (s.effective_to is null or s.effective_to > v_from)
   order by s.effective_from
   limit 1;

  -- BACKDATING IS REFUSED RATHER THAN GUESSED AT — the same rule as merchant
  -- rates, and here it also protects every merchant at once. A successor dated
  -- at or before the standing schedule's own start cannot be expressed:
  -- closing it would need effective_to <= effective_from, which the range
  -- CHECK forbids.
  if v_standing.id is not null and v_standing.effective_from >= v_from then
    raise exception
      '% already has a buy-rate schedule starting % (on or after %). Backdating is not supported here.',
      v_proc, v_standing.effective_from, v_from
      using errcode = '22007',
            hint = 'Pick a later effective month.';
  end if;

  -- Close first: the EXCLUDE constraint is not deferrable, so two open-ended
  -- ranges would collide. The guard trigger deliberately does not cover
  -- effective_to, so this succeeds even when the standing schedule is locked.
  if v_standing.id is not null then
    update public.residual_buy_rate_schedules
       set effective_to = v_from,
           updated_by_id = v_actor
     where id = v_standing.id;
    v_closed := v_standing.id;
  end if;

  insert into public.residual_buy_rate_schedules
    (processor, label, effective_from, effective_to, notes, created_by_id, updated_by_id)
  values (v_proc, btrim(p_label), v_from, null, p_notes, v_actor, v_actor)
  returning id into v_new_id;

  -- Tiers before cells: residual_buy_rates carries a composite FK to
  -- (schedule_id, risk_tier).
  insert into public.residual_buy_rate_tiers
    (schedule_id, risk_tier, tapdash_share, created_by_id, updated_by_id)
  select v_new_id, k, (p_tiers ->> k)::numeric, v_actor, v_actor
    from jsonb_object_keys(p_tiers) k;
  get diagnostics v_tiers = row_count;

  -- A NULL rate is DROPPED, not stored. The grid is ragged and an absent cell
  -- is the representation of "this tier has no template rate for this item" —
  -- which the engine reports as missing_template_rate. Storing a NULL rate row
  -- would be a second way to say the same thing, and residual_buy_rates.rate
  -- would have to become nullable to allow it.
  insert into public.residual_buy_rates
    (schedule_id, risk_tier, fee_item_key, rate, created_by_id, updated_by_id)
  select v_new_id, c.risk_tier, c.fee_item_key, c.rate, v_actor, v_actor
    from jsonb_to_recordset(p_cells)
      as c(risk_tier text, fee_item_key text, rate numeric)
   where c.rate is not null;
  get diagnostics v_cells = row_count;

  return jsonb_build_object(
    'processor',      v_proc,
    'inserted_id',    v_new_id,
    'closed_id',      v_closed,
    'effective_from', v_from,
    'tiers',          v_tiers,
    'cells',          v_cells
  );
end;
$$;

comment on function public.residual_supersede_buy_rate_schedule(text, date, text, jsonb, jsonb, text) is
  'Closes the standing buy-rate schedule and opens its dated successor — schedule, tiers and grid cells — atomically. Must be one call: the EXCLUDE constraint forces close-before-insert and the composite FK forces tiers-before-cells, so a failure between client calls would leave the processor with no schedule in effect (the engine then raises for the whole run) or with tiers and no rates (every line computes and every buy rate is reported missing). tapdash_share is accepted ONLY in p_tiers, never as a grid cell — the schema separated them and this keeps them separated. A successor states the WHOLE grid; a NULL rate is dropped rather than stored, because an absent cell is how "no template rate" is represented.';

revoke all on function public.residual_supersede_buy_rate_schedule(text, date, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.residual_supersede_buy_rate_schedule(text, date, text, jsonb, jsonb, text)
  to authenticated;

commit;
