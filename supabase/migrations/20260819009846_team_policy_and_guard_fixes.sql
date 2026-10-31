-- =============================================================================
-- Two regressions from migration 9843, found by the record-lifecycle tests.
--
-- `records_select` asked `record_listable`, which looks the row up. During
-- INSERT ... RETURNING the row is not there yet, so a read-back of a brand new
-- record was refused. The policy already has the row, so it asks the rules alone.
--
-- The field guard took any session carrying claims for a signed-in viewer. It
-- belongs to a viewer's own session: an owner-level statement is not one, even
-- when claims from earlier in the transaction are still set.
-- =============================================================================

create or replace function record_row_listable(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (user_can_see_record_by_rules(auth.uid(), rec) or user_open_level(auth.uid(), rec) <> 'none')
     and record_module_visible(rec);
$$;

create or replace function record_listable(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from records r where r.id = rec and r.deleted_at is null)
     and record_row_listable(rec);
$$;

drop policy if exists records_select on records;
create policy records_select on records for select using (deleted_at is null and record_row_listable(id));

revoke all on function record_row_listable(uuid) from public, anon;
grant execute on function record_row_listable(uuid) to authenticated;

create or replace function records_guard_team_field()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_new   jsonb := coalesce(new.values -> 'team_members_assigned', '[]'::jsonb);
  v_old   jsonb := '[]'::jsonb;
  v_id    text;
  v_team  uuid;
  v_seen  uuid[] := '{}';
begin
  if tg_op = 'UPDATE' then v_old := coalesce(old.values -> 'team_members_assigned', '[]'::jsonb); end if;
  -- `role` is the session's, unchanged by SECURITY DEFINER: only a signed-in
  -- viewer's request runs as `authenticated`.
  if current_setting('role', true) is distinct from 'authenticated'
     or v_actor is null or v_new = v_old or jsonb_typeof(v_new) <> 'array' or jsonb_typeof(v_old) <> 'array'
     or current_setting('tapdash.team_write', true) = 'on'
     or user_is_admin(v_actor) or auth_admin_page('users') then
    return new;
  end if;

  for v_id in select x from jsonb_array_elements_text(v_new) x where not (v_old ? x) loop
    continue when tg_op = 'INSERT' and v_id = v_actor::text; -- the creator is always on their own record
    v_team := user_team(v_id::uuid);
    if v_team is null then continue; end if;
    if not (user_can_assign_team(v_actor, v_team) and team_perm(v_actor, v_team, 'assign_member')) then
      raise exception 'You cannot assign a specific member of %.', team_name(v_team) using errcode = '42501';
    end if;
    if v_team = any(v_seen)
       or exists (select 1 from record_team_assignments a
                   where a.record_id = new.id and a.team_id = v_team and a.taken_by is not null
                     and not exists (select 1 from jsonb_array_elements_text(v_old) o where o = a.taken_by::text and not (v_new ? o))) then
      raise exception '% is already taken on this record. Unassign it first.', team_name(v_team) using errcode = '23505';
    end if;
    v_seen := v_seen || v_team;
  end loop;

  for v_id in select x from jsonb_array_elements_text(v_old) x where not (v_new ? x) loop
    v_team := user_team(v_id::uuid);
    if v_team is not null and not team_perm(v_actor, v_team, 'unassign') then
      raise exception 'You cannot unassign members of %.', team_name(v_team) using errcode = '42501';
    end if;
  end loop;

  return new;
end;
$$;
