-- ============================================================================
-- Repair: restore six functions dropped during the public.auth.uid() fix.
--
-- They were dropped so a repaired body could replace them, and the migrations
-- that define them cannot be replayed: a later file redefines other functions
-- in those same files with a different OUT-parameter row type, so replaying an
-- earlier one collides every time. The bodies below are lifted verbatim from
-- the migration that LAST defines each, which is the shape the database is
-- meant to have.
--
-- Grants are restated rather than extracted. Dropping a function drops its
-- grants with it, and Supabase hands every new function direct EXECUTE to anon
-- and authenticated - so a restored function with no explicit revoke would be
-- MORE reachable than the one it replaced.
--
-- Found by the engine raising on a missing function during an end-to-end run,
-- not by reading the migrations, which all looked applied.
-- ============================================================================

-- from 20260819009707_residuals_reference_data_r5c.sql
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

-- from 20260819009707_residuals_reference_data_r5c.sql
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

-- from 20260819009732_residuals_verdicts_r6a.sql
create or replace function public.residual_acknowledge_verdict(
  p_scope     text,
  p_scope_id  uuid,
  p_step      smallint,
  p_reason    text,
  p_processor text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_period  uuid;
  v_status  text;
  v_month   date;
  v_ver     integer;
  v_row     record;
  v_id      uuid;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to acknowledge a residual verdict.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'An acknowledgment requires an identified actor.'
      using errcode = '42501',
            hint = 'This function cannot be called on a service-role connection.';
  end if;

  if p_scope not in ('line','group') then
    raise exception 'residual_acknowledge_verdict: p_scope must be line or group.'
      using errcode = '22023';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'An acknowledgment requires a reason.'
      using errcode = '22004',
            hint = 'The reason is what makes the forgiveness auditable; it is not optional.';
  end if;

  -- Resolve the target's period from the target itself, so a caller cannot
  -- file an ack against the wrong month.
  if p_scope = 'line' then
    select l.period_id into v_period
      from public.residual_lines l
     where l.id = p_scope_id and l.deleted_at is null;
  else
    select g.period_id into v_period
      from public.residual_line_groups g
     where g.id = p_scope_id and g.deleted_at is null;
  end if;

  if v_period is null then
    raise exception 'No live % with id %.', p_scope, p_scope_id
      using errcode = 'P0002';
  end if;

  select p.status, p.statement_month, p.calculation_version
    into v_status, v_month, v_ver
    from public.residual_periods p
   where p.id = v_period;

  -- Pre-check for a friendly message. The INSERT trigger would refuse anyway;
  -- this names the act rather than the table.
  if v_status = 'reconciled' then
    raise exception
      'Statement month % is signed off. A new acknowledgment requires reopening it first.',
      to_char(v_month, 'YYYY-MM')
      using errcode = '42501',
            hint = 'residual_reopen_period(period_id, reason).';
  end if;

  select w.verdict, w.delta, w.tolerance_applied
    into v_row
    from public.residual_verdicts(v_period, null, p_processor) w
   where w.scope_id = p_scope_id and w.step = p_step;

  if not found then
    raise exception
      'Step % has no verdict on this % — the comparison could not be made.',
      p_step, p_scope
      using errcode = 'P0002',
            hint = 'An uncomputed line, an unmapped fee item, or a merchant with no volume row. There is nothing to acknowledge.';
  end if;

  if v_row.verdict <> 'mismatch' then
    raise exception 'Step % on this % is %, not a mismatch.',
      p_step, p_scope, v_row.verdict
      using errcode = '22023',
            hint = 'Only a mismatch can be acknowledged.';
  end if;

  insert into public.residual_verdict_acknowledgments
    (period_id, scope, line_id, group_id, step,
     delta_acknowledged, tolerance_applied, calculation_version,
     reason, created_by_id)
  values
    (v_period, p_scope,
     case when p_scope = 'line'  then p_scope_id end,
     case when p_scope = 'group' then p_scope_id end,
     p_step,
     v_row.delta, v_row.tolerance_applied, v_ver,
     btrim(p_reason), v_actor)
  returning id into v_id;

  return v_id;
end;
$$;

-- from 20260819009732_residuals_verdicts_r6a.sql
create or replace function public.residual_period_state(
  p_period_id uuid,
  p_processor text default null
)
returns table (
  derived_status    text,
  stored_status     text,
  merchant_count    bigint,
  blocked           bigint,
  awaiting_volumes  bigint,
  mismatch          bigint,
  ready             bigint,
  reconciled        bigint,
  signable          boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stored text;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to read residual period state.'
      using errcode = '42501';
  end if;

  select p.status into v_stored
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_stored is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  return query
  with s as (
    select * from public.residual_merchant_states(p_period_id, p_processor)
  ),
  agg as (
    select count(*)                                          as n,
           count(*) filter (where s.state = 'blocked')          as n_blocked,
           count(*) filter (where s.state = 'awaiting_volumes') as n_await,
           count(*) filter (where s.state = 'mismatch')         as n_mismatch,
           count(*) filter (where s.state = 'ready')            as n_ready,
           count(*) filter (where s.state = 'reconciled')       as n_recon
      from s
  )
  select case
           when agg.n = 0            then 'open'
           when agg.n_blocked  > 0   then 'open'
           when agg.n_await    > 0   then 'awaiting_volumes'
           when agg.n_mismatch > 0   then 'mismatch'
           when v_stored = 'reconciled' then 'reconciled'
           else                           'ready'
         end,
         v_stored,
         agg.n, agg.n_blocked, agg.n_await, agg.n_mismatch, agg.n_ready, agg.n_recon,
         -- SIGNABLE: at least one merchant, and every one of them clean. The
         -- "at least one" clause is not pedantry — without it an empty period
         -- is vacuously signable, and signing an empty month freezes it against
         -- the import that was about to arrive.
         (agg.n > 0 and agg.n = agg.n_ready + agg.n_recon)
    from agg;
end;
$$;

-- from 20260819009732_residuals_verdicts_r6a.sql
create or replace function public.residual_retire_resolved_acks(
  p_period_id uuid,
  p_processor text default null
)
returns table (resolved integer, superseded integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_res    int := 0;
  v_sup    int := 0;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to retire residual acknowledgments.'
      using errcode = '42501';
  end if;

  select p.status into v_status
    from public.residual_periods p
   where p.id = p_period_id and p.deleted_at is null;

  if v_status is null then
    raise exception 'No live residual period with id %.', p_period_id
      using errcode = 'P0002';
  end if;

  -- A signed month's verdicts are constant, so there is nothing to retire. Not
  -- an error — a caller sweeping every period should not have to special-case
  -- the signed ones.
  if v_status = 'reconciled' then
    return query select 0, 0;
    return;
  end if;

  -- ONE STATEMENT, ONE SNAPSHOT, AND NO TEMP TABLE.
  --
  -- Both reasons are decided from a single evaluation of residual_verdicts.
  -- Two statements — one per reason — could see two different states if
  -- anything moved between them and would retire as 'resolved' an ack the
  -- second pass considered 'superseded', or retire nothing twice.
  --
  -- The obvious way to share one evaluation is a temp table, and it is
  -- deliberately not used: this function is SECURITY DEFINER with
  -- search_path = public, and pg_temp is searched ahead of an explicit
  -- search_path whether or not it is listed. An unqualified reference to a
  -- temp table inside a definer function is the classic shadowing hazard, and
  -- a CTE has the same sharing property with none of it.
  with v as (
    select w.scope_id, w.step, w.verdict, w.delta, w.tolerance_applied as tol
      from public.residual_verdicts(p_period_id, null, p_processor) w
  ),
  tgt as (
    select a.id,
           case
             -- resolved: no verdict row at all (the line was recomputed to
             -- NULL, soft-deleted, or its fee item stopped being comparable),
             -- or one that no longer fails.
             when not exists (
               select 1 from v
                where v.scope_id = coalesce(a.line_id, a.group_id)
                  and v.step = a.step
                  and v.verdict = 'mismatch')
             then 'resolved'
             -- superseded: still failing, but not at the delta forgiven.
             when exists (
               select 1 from v
                where v.scope_id = coalesce(a.line_id, a.group_id)
                  and v.step = a.step
                  and v.verdict = 'mismatch'
                  and abs(v.delta - a.delta_acknowledged) > v.tol)
             then 'superseded'
           end as why
      from public.residual_verdict_acknowledgments a
     where a.period_id = p_period_id
       and a.retired_at is null
       and a.deleted_at is null
  ),
  upd as (
    update public.residual_verdict_acknowledgments a
       set retired_at     = now(),
           retired_reason = tgt.why
      from tgt
     where a.id = tgt.id
       and tgt.why is not null
    returning tgt.why as why
  )
  select coalesce(count(*) filter (where upd.why = 'resolved'), 0)::int,
         coalesce(count(*) filter (where upd.why = 'superseded'), 0)::int
    into v_res, v_sup
    from upd;

  return query select v_res, v_sup;
end;
$$;

-- from 20260819009732_residuals_verdicts_r6a.sql
create or replace function public.residual_withdraw_acknowledgment(
  p_ack_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_n     int;
begin
  if auth.uid() is null
     or not public.auth_is_admin() then
    raise exception 'Not authorized to withdraw a residual acknowledgment.'
      using errcode = '42501';
  end if;

  if v_actor is null then
    raise exception 'Withdrawing an acknowledgment requires an identified actor.'
      using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Withdrawing an acknowledgment requires a reason.'
      using errcode = '22004';
  end if;

  update public.residual_verdict_acknowledgments
     set retired_at     = now(),
         retired_reason = 'withdrawn',
         retired_by_id  = v_actor,
         retired_note   = btrim(p_reason)
   where id = p_ack_id
     and retired_at is null
     and deleted_at is null;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'No live acknowledgment with id %.', p_ack_id
      using errcode = 'P0002',
            hint = 'It may already be retired.';
  end if;
end;
$$;

-- Admin-facing, every one: each carries its own auth_is_admin() check.
revoke all on function public.residual_buy_rate_coverage(text) from public, anon, authenticated;
revoke all on function public.residual_reference_coverage(uuid) from public, anon, authenticated;
revoke all on function public.residual_acknowledge_verdict(text, uuid, smallint, text, text) from public, anon, authenticated;
revoke all on function public.residual_period_state(uuid, text) from public, anon, authenticated;
revoke all on function public.residual_retire_resolved_acks(uuid, text) from public, anon, authenticated;
revoke all on function public.residual_withdraw_acknowledgment(uuid, text) from public, anon, authenticated;
grant execute on function public.residual_buy_rate_coverage(text) to authenticated, service_role;
grant execute on function public.residual_reference_coverage(uuid) to authenticated, service_role;
grant execute on function public.residual_acknowledge_verdict(text, uuid, smallint, text, text) to authenticated, service_role;
grant execute on function public.residual_period_state(uuid, text) to authenticated, service_role;
grant execute on function public.residual_retire_resolved_acks(uuid, text) to authenticated, service_role;
grant execute on function public.residual_withdraw_acknowledgment(uuid, text) to authenticated, service_role;
