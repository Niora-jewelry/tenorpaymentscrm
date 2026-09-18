-- =============================================================================
-- Part 83: the value-writing RPCs check the grant chain, not just visibility.
--
-- ── WHY CLOSING DIRECT UPDATE (81) WAS NOT ENOUGH ────────────────────────
-- 81 removed `authenticated`'s UPDATE on `records` on the grounds that every
-- write already goes through a SECURITY DEFINER function. True — and those
-- functions are themselves reachable over PostgREST by any signed-in user:
--
--   POST /rest/v1/rpc/set_record_value
--   { "p_record_id": "...", "p_field_key": "ein", "p_new_value": "\"x\"", ... }
--
-- A SECURITY DEFINER function runs as `postgres`, so RLS and column grants do
-- not apply inside it. Its own checks ARE the boundary, and they were:
--
--   set_record_value    record_visible()      -- can I SEE this record?
--   set_record_values   record_visible()      -- can I SEE this record?
--   bulk_set_values     can_see_record()      -- can I SEE this record?
--
-- Visibility, three times. Nothing asked whether the caller may EDIT, whether
-- the field's tab or subtab is open to them, or whether the field itself is
-- Hidden. So a member holding Tickets = View could set any field on any record
-- they could see — including a field they are not allowed to read — by calling
-- the RPC directly. Closing the table left the front door open.
--
-- ── ONE FUNCTION, THE WHOLE CHAIN, CAPPED INSIDE EACH MODULE ─────────────
-- `record_field_grant` is the SQL twin of `fieldCapsFor` in
-- `lib/records/tabAccess.ts`, and it composes the same way for the same
-- reason: module -> tab -> subtab -> field, capped WITHIN each module the
-- record is displayed in, and only then the best across modules.
--
-- ⚠ The tempting shape — `least(record_scope_grant(tab), record_scope_grant(
-- subtab), record_scope_grant(field))` — is wrong, and reads as right. Each
-- `record_scope_grant` already takes the best across modules, so capping the
-- three results together can pass a combination that holds in no single
-- module: tab open in Leads only, subtab open in Deals only, and the caller
-- gets Edit on both. Same defect this project just fixed in TypeScript; the
-- worked example is on `chainCapFor`.
--
-- Best-across-modules at the END is deliberate and matches the app: the write
-- path cannot trust a module named by the browser, so it resolves from
-- `record_modules` — never narrower than what the drawer displayed, so nothing
-- a user can see can be refused on save.
--
-- Read-only fields stay the app layer's job, except the pipeline-synced Status
-- fields, which each RPC already refuses by name. This migration is about who
-- may write, not about which fields are writable at all.
-- =============================================================================

create or replace function public.record_field_grant(rec uuid, p_field_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then 'edit'::permission_level
    else coalesce(
      (
        select max(
          least(
            effective_grant(auth.uid(), 'module'::grant_scope, rm.module_id, null),
            effective_grant(auth.uid(), 'tab'::grant_scope, f.tab_id, rm.module_id),
            case
              when f.subtab_id is null then 'edit'::permission_level
              else effective_grant(auth.uid(), 'subtab'::grant_scope, f.subtab_id, rm.module_id)
            end,
            effective_grant(auth.uid(), 'field'::grant_scope, f.id, rm.module_id)
          )
        )
          from record_modules rm
          join modules m on m.id = rm.module_id
          join fields f on f.key = p_field_key
         where rm.record_id = rec
           and not m.admin_only
      ),
      -- No non-admin-only module, or no such field: nothing to grant through.
      'hidden'::permission_level
    )
  end;
$$;

revoke execute on function public.record_field_grant(uuid, text) from public, anon;
grant execute on function public.record_field_grant(uuid, text) to authenticated, service_role;


-- ── set_record_value ──────────────────────────────────────────────────────
create or replace function public.set_record_value(
  p_record_id uuid,
  p_field_key text,
  p_new_value jsonb,
  p_expected_updated_at timestamp with time zone,
  p_summary text
)
returns table(ok boolean, updated_at timestamp with time zone, current_value jsonb,
              changed_by uuid, changed_at timestamp with time zone)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_old    jsonb;
  v_new_at timestamptz;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  -- The grant chain. Placed before the pipeline check on purpose: "you may not
  -- touch this record" is the more basic answer, and answering the narrower
  -- question first would tell an unauthorised caller which fields are
  -- pipeline-synced.
  if record_field_grant(p_record_id, p_field_key) <> 'edit' then
    raise exception 'You do not have edit access to that field.'
      using errcode = '42501';
  end if;

  if is_pipeline_status_key(p_field_key) then
    raise exception 'That Status field follows its pipeline — move the step bar to change it.'
      using errcode = '42501';
  end if;

  select r.values -> p_field_key into v_old from records r where r.id = p_record_id;

  update records
     set values = case
                    when p_new_value is null or p_new_value = 'null'::jsonb
                      then values - p_field_key
                    else jsonb_set(values, array[p_field_key], p_new_value, true)
                  end,
         updated_at = now()
   where id = p_record_id
     and records.updated_at = p_expected_updated_at
     and deleted_at is null
  returning records.updated_at into v_new_at;

  if v_new_at is not null then
    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
    values (p_record_id, auth.uid(), 'field', p_field_key, p_summary,
            v_old #>> '{}',
            case when p_new_value = 'null'::jsonb then null else p_new_value #>> '{}' end);

    return query select true, v_new_at, null::jsonb, null::uuid, null::timestamptz;
    return;
  end if;

  return query
    select false, r.updated_at, r.values -> p_field_key,
      (select a.actor_id from record_activity a
        where a.record_id = p_record_id and a.kind = 'field' and a.field_key = p_field_key
        order by a.at desc limit 1),
      (select a.at from record_activity a
        where a.record_id = p_record_id and a.kind = 'field' and a.field_key = p_field_key
        order by a.at desc limit 1)
    from records r
    where r.id = p_record_id;
end;
$function$;


-- ── set_record_values ─────────────────────────────────────────────────────
create or replace function public.set_record_values(
  p_record_id uuid,
  p_changes jsonb,
  p_expected_updated_at timestamp with time zone,
  p_summaries jsonb
)
returns table(ok boolean, updated_at timestamp with time zone, current_values jsonb,
              changed_by uuid, changed_at timestamp with time zone)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_old      jsonb;
  v_new_at   timestamptz;
  v_clear    text[];
  v_set      jsonb;
  v_synced   text;
  v_denied   text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'no changes supplied';
  end if;

  -- The WHOLE batch is checked before anything is written, matching
  -- `setValues` in the app: a batch touching one forbidden field is refused
  -- entirely rather than partially applied.
  select k into v_denied
    from jsonb_object_keys(p_changes) k
   where record_field_grant(p_record_id, k) <> 'edit'
   limit 1;
  if v_denied is not null then
    raise exception 'You do not have edit access to %.', v_denied
      using errcode = '42501';
  end if;

  select k into v_synced
    from jsonb_object_keys(p_changes) k
   where is_pipeline_status_key(k)
   limit 1;
  if v_synced is not null then
    raise exception 'That Status field follows its pipeline — move the step bar to change it.'
      using errcode = '42501';
  end if;

  select r.values into v_old from records r where r.id = p_record_id;

  -- Top-level keys only, deliberately: a null nested INSIDE an address or a
  -- repeat-group instance is a real value and must survive.
  select coalesce(array_agg(k), '{}')
    into v_clear
    from jsonb_object_keys(p_changes) k
   where p_changes -> k = 'null'::jsonb;

  select coalesce(jsonb_object_agg(k, p_changes -> k), '{}'::jsonb)
    into v_set
    from jsonb_object_keys(p_changes) k
   where p_changes -> k <> 'null'::jsonb;

  update records
     set values     = (values || v_set) - v_clear,
         updated_at = now()
   where id = p_record_id
     and records.updated_at = p_expected_updated_at
     and deleted_at is null
  returning records.updated_at into v_new_at;

  if v_new_at is not null then
    -- One history row per field, in the same statement as the write above.
    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
    select p_record_id,
           auth.uid(),
           'field',
           k,
           coalesce(p_summaries ->> k, k || ' changed'),
           v_old -> k #>> '{}',
           case when p_changes -> k = 'null'::jsonb then null else p_changes -> k #>> '{}' end
      from jsonb_object_keys(p_changes) k;

    return query select true, v_new_at, null::jsonb, null::uuid, null::timestamptz;
    return;
  end if;

  -- CAS lost. Hand back only the fields this batch tried to write.
  return query
    select
      false,
      r.updated_at,
      (select coalesce(jsonb_object_agg(k, r.values -> k), '{}'::jsonb)
         from jsonb_object_keys(p_changes) k),
      (select a.actor_id from record_activity a
        where a.record_id = p_record_id and a.kind = 'field'
        order by a.at desc limit 1),
      (select a.at from record_activity a
        where a.record_id = p_record_id and a.kind = 'field'
        order by a.at desc limit 1)
    from records r
    where r.id = p_record_id;
end;
$function$;


-- ── bulk_set_values ───────────────────────────────────────────────────────
-- Refuses PER RECORD rather than raising, because that is what this function
-- already does and what the caller is built to read: ids requested but not
-- returned are the skip list ("changed since your selection", SCHEMA-DECISIONS
-- §8). A record the caller may not edit belongs in exactly that list — the
-- grant can differ record by record, since it depends on the modules each one
-- is displayed in, so a single all-or-nothing answer would be wrong.
create or replace function public.bulk_set_values(
  p_record_ids uuid[],
  p_field_key text,
  p_new_value jsonb,
  p_summary text
)
returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_updated uuid[];
begin
  set local statement_timeout = '5s';

  if is_pipeline_status_key(p_field_key) then
    raise exception 'That Status field follows its pipeline — move the step bar to change it.'
      using errcode = '42501';
  end if;

  with upd as (
    update records
       set values = case
                      when p_new_value is null then values - p_field_key
                      else jsonb_set(values, array[p_field_key], p_new_value, true)
                    end,
           updated_at = now()
     where id = any(p_record_ids)
       and deleted_at is null
       and can_see_record(id)
       and record_field_grant(id, p_field_key) = 'edit'
    returning id
  )
  select array_agg(id) into v_updated from upd;

  insert into record_activity (record_id, actor_id, kind, field_key, summary, to_value)
  select u, auth.uid(), 'field', p_field_key, p_summary, p_new_value #>> '{}'
    from unnest(coalesce(v_updated, '{}')) as u;

  return coalesce(v_updated, '{}');
end;
$function$;
