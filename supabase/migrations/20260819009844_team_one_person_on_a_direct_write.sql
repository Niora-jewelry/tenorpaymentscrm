-- =============================================================================
-- One person per team, on a direct write of the field too: naming two people
-- from one team in a single write would otherwise pass the "already taken"
-- check, because neither has taken it yet. Admins and the Users page keep their
-- bypass: offboarding moves records and must not stop on this.
-- =============================================================================

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
  if v_actor is null or v_new = v_old or jsonb_typeof(v_new) <> 'array' or jsonb_typeof(v_old) <> 'array'
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

-- The create dialog needs to know which team is the viewer's own: the creator
-- takes it, so it has nothing left to offer there.
create or replace function team_assign_options()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', pt.id,
           'label', coalesce(pt.team_label, pt.label),
           'own', pt.id = user_team(auth.uid()),
           'members', case when team_perm(auth.uid(), pt.id, 'assign_member') then coalesce((
             select jsonb_agg(p.id order by coalesce(p.full_name, p.email::text))
               from user_templates ut
               join profiles p on p.id = ut.user_id
              where ut.template_id = pt.id and p.status = 'active' and p.deleted_at is null
           ), '[]'::jsonb) else '[]'::jsonb end
         ) order by pt.position), '[]'::jsonb)
    from permission_templates pt
   where pt.user_type is not null
     and user_can_assign_team(auth.uid(), pt.id);
$$;
