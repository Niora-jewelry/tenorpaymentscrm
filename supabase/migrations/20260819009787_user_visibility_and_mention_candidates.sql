-- =============================================================================
-- @Mentions — 2 of 5: "who may be mentioned here?"
--
-- The client's rule: a person can be mentioned only if THEY can see the exact
-- thing — the record and its module for an update; plus the Cases tab for a
-- case; plus the tab, sub-tab and field for a field mention. Every grant
-- resolver in this schema answers for `auth.uid()` only, so each is mirrored
-- with a `u uuid` parameter, and the `auth.uid()` versions now delegate to
-- the mirrors so the two can never disagree (the rule 7200 set for
-- record_tab_grant). The mirrors have no client grant: they answer about
-- OTHER people and are only ever called from `mention_candidates` and the
-- write RPCs.
--
-- `mention_candidates` enumerates exactly `can_see_record`'s universe —
-- admins, the record's team, and viewers holding a visibility grant on a
-- team member — then keeps the active, non-self ones who pass the scope's
-- grant. Bounded by that pool (not all profiles), so it costs a few hundred
-- index probes.
--
-- One deliberate deviation from the plan's table, to tell the client: an
-- update mention also requires the Updates tab to be visible to the person
-- (the plan says record + module). Otherwise they would receive an alert
-- they can never open or clear.
-- =============================================================================

create or replace function public.user_is_admin(u uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select r.is_admin
      from profiles p
      join roles r on r.id = p.role_id
     where p.id = u and p.status = 'active' and p.deleted_at is null
  ), false);
$$;

create or replace function public.user_can_see_record(u uuid, rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_is_admin(u)
    or exists (select 1 from record_team_members t where t.record_id = rec and t.user_id = u)
    or exists (select 1 from record_visibility_grants g
                join record_team_members t on t.user_id = g.owner_id
               where g.viewer_id = u and t.record_id = rec);
$$;

create or replace function public.user_record_module_visible(u uuid, rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_is_admin(u) or exists (
    select 1
      from record_modules rm
      join modules m on m.id = rm.module_id
     where rm.record_id = rec
       and not m.admin_only
       and effective_grant(u, 'module'::grant_scope, rm.module_id) <> 'hidden'
  );
$$;

create or replace function public.user_record_visible(u uuid, rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from records r where r.id = rec and r.deleted_at is null)
     and user_can_see_record(u, rec)
     and user_record_module_visible(u, rec);
$$;

create or replace function public.user_record_scope_grant(u uuid, rec uuid, p_kind grant_scope, p_scope uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when user_is_admin(u) then 'edit'::permission_level
    else coalesce(
      (
        select max(
          least(
            effective_grant(u, 'module'::grant_scope, rm.module_id, null),
            effective_grant(u, p_kind, p_scope, rm.module_id)
          )
        )
          from record_modules rm
          join modules m on m.id = rm.module_id
         where rm.record_id = rec
           and not m.admin_only
      ),
      'hidden'::permission_level
    )
  end;
$$;

create or replace function public.user_record_tab_grant(u uuid, rec uuid, p_tab_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select user_record_scope_grant(u, rec, 'tab'::grant_scope, t.id) from tabs t where t.key = p_tab_key),
    'hidden'::permission_level
  );
$$;

create or replace function public.user_record_field_grant(u uuid, rec uuid, p_field_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when user_is_admin(u) then 'edit'::permission_level
    else coalesce(
      (
        select max(
          least(
            effective_grant(u, 'module'::grant_scope, rm.module_id, null),
            effective_grant(u, 'tab'::grant_scope, f.tab_id, rm.module_id),
            case
              when f.subtab_id is null then 'edit'::permission_level
              else effective_grant(u, 'subtab'::grant_scope, f.subtab_id, rm.module_id)
            end,
            effective_grant(u, 'field'::grant_scope, f.id, rm.module_id)
          )
        )
          from record_modules rm
          join modules m on m.id = rm.module_id
          join fields f on f.key = p_field_key
         where rm.record_id = rec
           and not m.admin_only
      ),
      'hidden'::permission_level
    )
  end;
$$;

revoke execute on function public.user_is_admin(uuid) from public, anon, authenticated;
revoke execute on function public.user_can_see_record(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.user_record_module_visible(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.user_record_visible(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.user_record_scope_grant(uuid, uuid, grant_scope, uuid) from public, anon, authenticated;
revoke execute on function public.user_record_tab_grant(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.user_record_field_grant(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.user_is_admin(uuid) to service_role;
grant execute on function public.user_can_see_record(uuid, uuid) to service_role;
grant execute on function public.user_record_module_visible(uuid, uuid) to service_role;
grant execute on function public.user_record_visible(uuid, uuid) to service_role;
grant execute on function public.user_record_scope_grant(uuid, uuid, grant_scope, uuid) to service_role;
grant execute on function public.user_record_tab_grant(uuid, uuid, text) to service_role;
grant execute on function public.user_record_field_grant(uuid, uuid, text) to service_role;

-- ── The auth.uid() versions delegate ─────────────────────────────────────
-- Same answers as before (bodies were copied verbatim above); grants and
-- callers untouched.
create or replace function public.auth_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_is_admin(auth.uid());
$$;

create or replace function public.can_see_record(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_can_see_record(auth.uid(), rec);
$$;

create or replace function public.record_module_visible(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_record_module_visible(auth.uid(), rec);
$$;

create or replace function public.record_scope_grant(rec uuid, p_kind grant_scope, p_scope uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_record_scope_grant(auth.uid(), rec, p_kind, p_scope);
$$;

create or replace function public.record_field_grant(rec uuid, p_field_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_record_field_grant(auth.uid(), rec, p_field_key);
$$;

-- ── mention_candidates ───────────────────────────────────────────────────
-- p_scope: 'updates' | 'cases' | 'field:<field key>'. Ordered by name for
-- the picker. Raises for a record the caller cannot see, like every other
-- per-record RPC.
create or replace function public.mention_candidates(p_record_id uuid, p_scope text)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_field text := case when p_scope like 'field:%' then substr(p_scope, 7) else null end;
  v_out   uuid[];
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  if p_scope not in ('updates', 'cases') and v_field is null then
    raise exception 'Unknown mention scope' using errcode = '22023';
  end if;

  with pool as (
    select p.id from profiles p join roles r on r.id = p.role_id where r.is_admin
    union
    select t.user_id from record_team_members t where t.record_id = p_record_id
    union
    select g.viewer_id from record_visibility_grants g
      join record_team_members t on t.user_id = g.owner_id
     where t.record_id = p_record_id
  )
  select coalesce(array_agg(p.id order by lower(coalesce(p.full_name, p.email::text)), p.id), '{}')
    into v_out
    from pool
    join profiles p on p.id = pool.id
   where p.status = 'active'
     and p.deleted_at is null
     and p.id <> auth.uid()
     and user_record_visible(p.id, p_record_id)
     and case
           when p_scope = 'updates' then user_record_tab_grant(p.id, p_record_id, 'updates') <> 'hidden'
           when p_scope = 'cases'   then user_record_tab_grant(p.id, p_record_id, 'cases') <> 'hidden'
           else user_record_field_grant(p.id, p_record_id, v_field) <> 'hidden'
         end;
  return v_out;
end;
$$;

revoke execute on function public.mention_candidates(uuid, text) from public, anon;
grant execute on function public.mention_candidates(uuid, text) to authenticated, service_role;
