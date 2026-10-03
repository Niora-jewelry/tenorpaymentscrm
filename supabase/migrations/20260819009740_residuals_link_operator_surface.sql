-- ============================================================================
-- The six operator-facing link functions.
--
-- Ported from Daniel Weissman's `20260826120000_residuals_merchant_link_r5b.sql`,
-- deferred out of the kernel migration because nothing in the schema depends on
-- them — they are the entry points an admin screen calls, and they belong with
-- it.
--
-- ── THE SHAPE OF THE DESIGN, WHICH IS THE POINT ─────────────────────────────
-- `residual_resolve_mid` and `residual_reconcile_mid_links` are UNGATED
-- kernels, reachable by no client role, because they must also run from the
-- relink trigger under a service-role connection where auth.uid() is NULL.
--
-- These six are the gated entry points onto them. Every one opens with an
-- admin check, and the check is a RAISE rather than a silent empty result: an
-- operator who is not permitted to see the worklist should be told so, not
-- shown an empty one and left to conclude there is nothing to do.
--
-- Our gate is `auth_is_admin()`; his admitted admin and super_admin.
-- `thread_id` is `record_id` here, and the merchant table is `records`.
-- ============================================================================

-- ============================================================================
-- 1. residual_link_worklist — what still needs a human
-- ============================================================================
-- Every unlinked MID across the three tables, with how many rows each has and
-- what the resolver would say about it today. The candidate list is included
-- so the screen can offer the choices without a second round trip per row.
--
-- Ordered by row count descending: the MID holding forty lines matters more
-- than the one holding a single volume row, and an operator working down the
-- list should meet them in that order.
-- ============================================================================
create or replace function public.residual_link_worklist(
  p_period_id uuid default null
) returns table (
  mid             text,
  line_rows       integer,
  volume_rows     integer,
  plan_rows       integer,
  match_kind      text,
  candidate_count integer,
  candidates      jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not auth_is_admin() then
    raise exception 'Not authorized to read the residual link worklist.'
      using errcode = '42501';
  end if;

  return query
  with unlinked as (
    select regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') as n_mid,
           1 as l, 0 as v, 0 as p
      from public.residual_lines rl
     where rl.deleted_at is null
       and rl.record_id is null
       and (p_period_id is null or rl.period_id = p_period_id)
    union all
    select regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g'), 0, 1, 0
      from public.residual_merchant_volumes rv
     where rv.deleted_at is null
       and rv.record_id is null
       and (p_period_id is null or rv.period_id = p_period_id)
    union all
    select regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g'), 0, 0, 1
      from public.residual_plan_volumes pv
     where pv.deleted_at is null
       and pv.record_id is null
       and (p_period_id is null or pv.period_id = p_period_id)
  ),
  grouped as (
    select u.n_mid,
           sum(u.l)::integer as l,
           sum(u.v)::integer as v,
           sum(u.p)::integer as p
      from unlinked u
     where u.n_mid <> ''
     group by u.n_mid
  )
  select
    g.n_mid,
    g.l,
    g.v,
    g.p,
    x.match_kind,
    x.candidate_count,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'record_id', c.record_id,
               'mid',       c.mid,
               'deal_name', c.deal_name))
        from public.find_live_records_by_mid_suffix(g.n_mid) c
    ), '[]'::jsonb)
  from grouped g
  cross join lateral public.residual_resolve_mid(g.n_mid) x
  order by (g.l + g.v + g.p) desc, g.n_mid;
end;
$$;

-- ============================================================================
-- 2. residual_preview_mid_link — what would happen
-- ============================================================================
-- Answers "if I linked this MID, what would it touch", without touching it.
-- The screen shows this before asking for a confirmation, so the operator is
-- agreeing to a specific number of rows rather than to a verb.
-- ============================================================================
create or replace function public.residual_preview_mid_link(
  p_mid       text,
  p_period_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_l   integer;
  v_v   integer;
  v_p   integer;
  v_res record;
begin
  if not auth_is_admin() then
    raise exception 'Not authorized to preview a residual link.'
      using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'p_mid has no digits.' using errcode = '22023';
  end if;

  select count(*)::integer into v_l from public.residual_lines rl
   where rl.deleted_at is null
     and regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rl.period_id = p_period_id);

  select count(*)::integer into v_v from public.residual_merchant_volumes rv
   where rv.deleted_at is null
     and regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rv.period_id = p_period_id);

  select count(*)::integer into v_p from public.residual_plan_volumes pv
   where pv.deleted_at is null
     and regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or pv.period_id = p_period_id);

  select * into v_res from public.residual_resolve_mid(v_mid);

  return jsonb_build_object(
    'mid',             v_mid,
    'lines',           v_l,
    'volumes',         v_v,
    'plans',           v_p,
    'match_kind',      v_res.match_kind,
    'record_id',       v_res.record_id,
    'candidate_count', v_res.candidate_count
  );
end;
$$;

-- ============================================================================
-- 3. residual_link_mid_to_record — a human decides
-- ============================================================================
-- Sets 'manual' and names the actor. Daniel's note, kept because it explains
-- why this does NOT re-run the resolver to check the human's work:
--
--   "A human MAY deliberately link a MID to a record whose own mid field says
--    something else — that is the entire point of a manual override. What they
--    may NOT do is link to a record that is gone. Note this is the ONE place a
--    live check is required: retention preserves links to soft-deleted
--    records, but creating a NEW one to a retired merchant is an error, not
--    provenance."
-- ============================================================================
create or replace function public.residual_link_mid_to_record(
  p_mid       text,
  p_record_id uuid,
  p_period_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_mid     text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_lines   integer;
  v_volumes integer;
  v_plans   integer;
begin
  if not auth_is_admin() then
    raise exception 'Not authorized to link a residual MID.' using errcode = '42501';
  end if;

  if v_mid = '' then
    raise exception 'p_mid has no digits.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.records r where r.id = p_record_id and r.deleted_at is null) then
    raise exception 'Merchant record % is not a live record.', p_record_id using errcode = '22023';
  end if;

  update public.residual_lines rl
     set record_id = p_record_id, thread_match = 'manual',
         thread_matched_at = now(), thread_confirmed_by_id = v_actor
   where rl.deleted_at is null
     and regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rl.period_id = p_period_id);
  get diagnostics v_lines = row_count;

  update public.residual_merchant_volumes rv
     set record_id = p_record_id, thread_match = 'manual',
         thread_matched_at = now(), thread_confirmed_by_id = v_actor
   where rv.deleted_at is null
     and regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rv.period_id = p_period_id);
  get diagnostics v_volumes = row_count;

  update public.residual_plan_volumes pv
     set record_id = p_record_id, thread_match = 'manual',
         thread_matched_at = now(), thread_confirmed_by_id = v_actor
   where pv.deleted_at is null
     and regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or pv.period_id = p_period_id);
  get diagnostics v_plans = row_count;

  return jsonb_build_object(
    'mid', v_mid, 'record_id', p_record_id,
    'lines_linked', v_lines, 'volumes_linked', v_volumes, 'plans_linked', v_plans
  );
end;
$$;

-- ============================================================================
-- 4. residual_confirm_mid_link — a human vouches for a machine's answer
-- ============================================================================
-- Stamps the actor WITHOUT changing the verdict. A confirmed 'suffix' link
-- stays 'suffix' — how it was found is a fact about the past and does not
-- become 'manual' because somebody later agreed with it. What changes is that
-- a person is now answerable for it, which is what
-- `thread_confirmed_by_id` means.
-- ============================================================================
create or replace function public.residual_confirm_mid_link(
  p_mid       text,
  p_period_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_mid   text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_n     integer;
  v_total integer := 0;
begin
  if not auth_is_admin() then
    raise exception 'Not authorized to confirm a residual link.' using errcode = '42501';
  end if;

  -- Only a row that HAS a link can be vouched for. The table's CHECK forbids
  -- a confirmed row with no record_id, so this filter is what keeps the write
  -- legal rather than merely sensible.
  update public.residual_lines rl set thread_confirmed_by_id = v_actor
   where rl.deleted_at is null and rl.record_id is not null
     and rl.thread_match in ('exact','suffix','manual')
     and regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rl.period_id = p_period_id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  update public.residual_merchant_volumes rv set thread_confirmed_by_id = v_actor
   where rv.deleted_at is null and rv.record_id is not null
     and rv.thread_match in ('exact','suffix','manual')
     and regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rv.period_id = p_period_id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  update public.residual_plan_volumes pv set thread_confirmed_by_id = v_actor
   where pv.deleted_at is null and pv.record_id is not null
     and pv.thread_match in ('exact','suffix','manual')
     and regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or pv.period_id = p_period_id);
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  return jsonb_build_object('mid', v_mid, 'rows_confirmed', v_total);
end;
$$;

-- ============================================================================
-- 5. residual_unlink_mid — take it back
-- ============================================================================
-- Clears the link and lets the resolver decide again. All four columns go
-- together: the table's CHECK ties the verdict, the pointer, the timestamp and
-- the voucher into one consistent state, so clearing three of them would be
-- refused by the database — which is the constraint doing its job.
-- ============================================================================
create or replace function public.residual_unlink_mid(
  p_mid       text,
  p_period_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mid text := regexp_replace(coalesce(p_mid,''),'[^0-9]','','g');
  v_n   integer;
  v_tot integer := 0;
begin
  if not auth_is_admin() then
    raise exception 'Not authorized to unlink a residual MID.' using errcode = '42501';
  end if;

  update public.residual_lines rl
     set record_id = null, thread_match = null,
         thread_matched_at = null, thread_confirmed_by_id = null
   where rl.deleted_at is null
     and regexp_replace(coalesce(rl.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rl.period_id = p_period_id);
  get diagnostics v_n = row_count; v_tot := v_tot + v_n;

  update public.residual_merchant_volumes rv
     set record_id = null, thread_match = null,
         thread_matched_at = null, thread_confirmed_by_id = null
   where rv.deleted_at is null
     and regexp_replace(coalesce(rv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or rv.period_id = p_period_id);
  get diagnostics v_n = row_count; v_tot := v_tot + v_n;

  update public.residual_plan_volumes pv
     set record_id = null, thread_match = null,
         thread_matched_at = null, thread_confirmed_by_id = null
   where pv.deleted_at is null
     and regexp_replace(coalesce(pv.mid,''),'[^0-9]','','g') = v_mid
     and (p_period_id is null or pv.period_id = p_period_id);
  get diagnostics v_n = row_count; v_tot := v_tot + v_n;

  return jsonb_build_object('mid', v_mid, 'rows_unlinked', v_tot);
end;
$$;

-- ============================================================================
-- 6. residual_sweep_mid_links — re-adjudicate everything
-- ============================================================================
-- The gated entry point onto the ungated kernel. Manual links are untouched by
-- the kernel, so a sweep cannot quietly overturn a human.
-- ============================================================================
create or replace function public.residual_sweep_mid_links()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_is_admin() then
    raise exception 'Not authorized to sweep residual links.' using errcode = '42501';
  end if;
  return public.residual_reconcile_mid_links(null);
end;
$$;

-- ============================================================================
-- Grants.
--
-- These six ARE reachable by a signed-in user, unlike the kernels — they carry
-- their own admin check, and a non-admin calling one is told so. The REVOKE
-- still names the roles explicitly, for the reason Daniel measured: Supabase
-- grants EXECUTE on new functions to anon and authenticated by default, so
-- `revoke from public` alone leaves those grants entirely in place.
-- ============================================================================
revoke all on function public.residual_link_worklist(uuid)                from public, anon, authenticated;
revoke all on function public.residual_preview_mid_link(text, uuid)       from public, anon, authenticated;
revoke all on function public.residual_link_mid_to_record(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.residual_confirm_mid_link(text, uuid)       from public, anon, authenticated;
revoke all on function public.residual_unlink_mid(text, uuid)             from public, anon, authenticated;
revoke all on function public.residual_sweep_mid_links()                  from public, anon, authenticated;

grant execute on function public.residual_link_worklist(uuid)                to authenticated, service_role;
grant execute on function public.residual_preview_mid_link(text, uuid)       to authenticated, service_role;
grant execute on function public.residual_link_mid_to_record(text, uuid, uuid) to authenticated, service_role;
grant execute on function public.residual_confirm_mid_link(text, uuid)       to authenticated, service_role;
grant execute on function public.residual_unlink_mid(text, uuid)             to authenticated, service_role;
grant execute on function public.residual_sweep_mid_links()                  to authenticated, service_role;
