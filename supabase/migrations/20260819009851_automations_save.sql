-- =============================================================================
-- Automations: saving one, and the numbers on the list.
--
-- A save is one transaction: the new version, the automation pointing at it, the
-- records moved across if the admin chose that, and the triggers rebuilt. Half a
-- save would leave a live automation listening on the old triggers.
-- =============================================================================

create or replace function automation_save(
  p_id          uuid,
  p_name        text,
  p_steps       jsonb,
  p_stop_teams  uuid[],
  p_stop_users  uuid[],
  p_move_runs   boolean,
  p_actor       uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a        automations;
  v_old    jsonb;
  v_number int;
  v_ver    uuid;
begin
  if p_id is null then
    insert into automations (name, stop_team_ids, stop_user_ids, created_by, updated_by)
    values (btrim(p_name), coalesce(p_stop_teams, '{}'), coalesce(p_stop_users, '{}'), p_actor, p_actor)
    returning * into a;
    insert into automation_versions (automation_id, number, steps, created_by)
    values (a.id, 1, p_steps, p_actor)
    returning id into v_ver;
    update automations set current_version_id = v_ver where id = a.id;
    return a.id;
  end if;

  select * into a from automations where id = p_id and deleted_at is null for update;
  if not found then raise exception 'That automation no longer exists.'; end if;

  select v.steps into v_old from automation_versions v where v.id = a.current_version_id;
  v_ver := a.current_version_id;
  if v_old is distinct from p_steps then
    select coalesce(max(v.number), 0) + 1 into v_number from automation_versions v where v.automation_id = a.id;
    insert into automation_versions (automation_id, number, steps, created_by)
    values (a.id, v_number, p_steps, p_actor)
    returning id into v_ver;
  end if;

  update automations
     set name = btrim(p_name), stop_team_ids = coalesce(p_stop_teams, '{}'), stop_user_ids = coalesce(p_stop_users, '{}'),
         current_version_id = v_ver, updated_by = p_actor, updated_at = now()
   where id = a.id;

  if v_ver is distinct from a.current_version_id then
    if p_move_runs then perform automation_move_runs(a.id, v_ver); end if;
    perform automation_refresh_triggers(a.id);
  end if;
  return a.id;
end;
$$;

create or replace function automation_stats()
returns table (automation_id uuid, waiting int, last_run_at timestamptz, runs int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.automation_id,
         count(*) filter (where r.status = 'waiting')::int,
         max(r.started_at) filter (where r.status <> 'not_matched'),
         count(*) filter (where r.status <> 'not_matched')::int
    from automation_runs r
   group by r.automation_id;
$$;

revoke all on function automation_save(uuid, text, jsonb, uuid[], uuid[], boolean, uuid) from public, anon, authenticated;
revoke all on function automation_stats() from public, anon, authenticated;
grant execute on function automation_save(uuid, text, jsonb, uuid[], uuid[], boolean, uuid) to service_role;
grant execute on function automation_stats() to service_role;
