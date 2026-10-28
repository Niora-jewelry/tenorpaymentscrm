-- =============================================================================
-- Permissions spec — part 2: enforce the model in the database.
--
-- ── RECORD ACCESS ("Record access comes first") ──────────────────────────────
-- A user may open a record through any module that holds it — and through the
-- Records List, which holds every record — when their access to that module is
--     All records                 → always
--     Only mine                   → when they are a team member or the
--                                   relationship manager (user_owns_record)
--     Hidden                      → never
-- Super admin sees everything, as before. "Only mine" adds the relationship
-- manager: until now that field granted nothing.
--
-- ── WHAT A MODULE GRANT MEANS NOW ────────────────────────────────────────────
-- Module access is Hidden / Only mine / All (Residuals: Hidden / Full). It is no
-- longer a Hidden / View / Edit level: what a user can change is decided by the
-- tabs and fields. So wherever the resolvers took a module's level, they now
-- take "hidden" for a Hidden module and "edit" otherwise — and the Records List
-- takes part like any other module instead of being skipped for everyone who
-- is not a Super admin.
--
-- ── COMPANY-WIDE ACTIONS ─────────────────────────────────────────────────────
--   Create new records          records_insert
--   Add / remove team members   Team picker fields resolve to at most View
--                               without it (so every writer refuses and every
--                               screen shows them read-only)
--   Delete / archive records    archiving (taking a record out of its last
--                               module) and delete_record
--   Display / remove from modules  every other change to the In modules chips
--   Move through pipeline stages   set_pipeline_step, clear_pipeline
-- =============================================================================

-- ── record access ────────────────────────────────────────────────────────────
create or replace function user_can_see_record(u uuid, rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_is_admin(u) or exists (
    select 1
      from modules m
     where (m.kind = 'storage'
            or exists (select 1 from record_modules rm where rm.record_id = rec and rm.module_id = m.id))
       and case user_module_scope(u, m.id)
             when 'all' then true
             when 'mine' then user_owns_record(u, rec)
             else false
           end
  );
$$;

-- Subsumed by user_can_see_record (it already requires a module the user can
-- open), kept because record_visible() and policies call it.
create or replace function user_record_module_visible(u uuid, rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_is_admin(u) or exists (
    select 1
      from modules m
     where (m.kind = 'storage'
            or exists (select 1 from record_modules rm where rm.record_id = rec and rm.module_id = m.id))
       and user_module_scope(u, m.id) <> 'hidden'
  );
$$;

-- ── the field / tab resolvers ────────────────────────────────────────────────
create or replace function user_record_scope_grant(u uuid, rec uuid, p_kind grant_scope, p_scope uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when user_is_admin(u) then 'edit'::permission_level
    else coalesce((
      select max(effective_grant(u, p_kind, p_scope, m.id))
        from modules m
       where (m.kind = 'storage'
              or exists (select 1 from record_modules rm where rm.record_id = rec and rm.module_id = m.id))
         and user_module_scope(u, m.id) <> 'hidden'
    ), 'hidden'::permission_level)
  end;
$$;

create or replace function user_record_field_grant(u uuid, rec uuid, p_field_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when user_is_admin(u) then 'edit'::permission_level
    else (
      select case
        -- Team picker fields need "Add / remove team members" to change.
        when f.type = 'team_member' and user_perm(u, 'action.team') <> 'yes'
          then least(g.level, 'view'::permission_level)
        else g.level
      end
      from fields f
      cross join lateral (
        select coalesce(max(
                 least(
                   effective_grant(u, 'tab'::grant_scope, f.tab_id, m.id),
                   case when f.subtab_id is null then 'edit'::permission_level
                        else effective_grant(u, 'subtab'::grant_scope, f.subtab_id, m.id) end,
                   effective_grant(u, 'field'::grant_scope, f.id, m.id)
                 )), 'hidden'::permission_level) as level
          from modules m
         where (m.kind = 'storage'
                or exists (select 1 from record_modules rm where rm.record_id = rec and rm.module_id = m.id))
           and user_module_scope(u, m.id) <> 'hidden'
      ) g
      where f.key = p_field_key
    )
  end;
$$;

create or replace function module_editable(p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth_is_admin() or coalesce(user_module_scope(auth.uid(), p_module) <> 'hidden', false);
$$;

create or replace function record_module_editable(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_record_module_visible(auth.uid(), rec);
$$;

/* "Display / remove records from modules" is one company-wide yes/no. A
   module the user cannot open is never one they can add a record to. */
create or replace function module_membership_allowed(p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth_is_admin() or (
    auth_perm('action.modules') = 'yes'
    and exists (select 1 from modules m where m.id = p_module and m.kind = 'display' and not m.shows_open_cases)
    and coalesce(user_module_scope(auth.uid(), p_module) <> 'hidden', false)
  );
$$;

-- ── Create new records ───────────────────────────────────────────────────────
drop policy if exists records_insert on records;
create policy records_insert on records for insert
  with check (creator_kind = 'user' and creator_user_id = auth.uid()
              and (auth_is_admin() or auth_perm('action.create') = 'yes'));

-- ── In modules chips, Archive ───────────────────────────────────────────────
create or replace function set_record_memberships(p_record_id uuid, p_module_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_had_any   boolean;
  v_has_now   boolean;
  v_ever_had  boolean;
  v_is_fresh  boolean;
  v_auto      uuid[];
  v_ids       uuid[];
  v_mod       record;
begin
  -- Modules that show open cases (Tickets) are automatic: never set by hand.
  select coalesce(array_agg(m.id), '{}') into v_auto from modules m where m.shows_open_cases;
  select coalesce(array_agg(x), '{}') into v_ids
    from unnest(coalesce(p_module_ids, '{}')) as x
   where x <> all (v_auto);

  select exists(select 1 from record_modules where record_id = p_record_id) into v_had_any;
  select exists(select 1 from record_activity ra where ra.record_id = p_record_id and ra.kind = 'membership')
    into v_ever_had;
  -- A record its creator just made, getting its first modules.
  v_is_fresh := not v_had_any and not v_ever_had
            and exists (select 1 from records r
                         where r.id = p_record_id and r.deleted_at is null and r.creator_user_id = auth.uid());

  if not (record_visible(p_record_id) or (v_is_fresh and can_see_record(p_record_id))) then
    raise exception 'not found';
  end if;

  if not auth_is_admin() then
    if v_is_fresh then
      if auth_perm('action.create') <> 'yes' then
        raise exception 'You cannot create records.' using errcode = '42501';
      end if;
    elsif v_had_any and cardinality(v_ids) = 0
          and not exists (select 1 from record_modules rm where rm.record_id = p_record_id and rm.module_id = any (v_auto)) then
      -- Out of its last module: that is archiving.
      if auth_perm('action.archive') <> 'yes' then
        raise exception 'You do not have permission to archive records.' using errcode = '42501';
      end if;
    else
      for v_mod in
        select m.id, m.label
          from modules m
         where m.id <> all (v_auto)
           and (m.id = any (v_ids))
               is distinct from
               (exists (select 1 from record_modules rm where rm.record_id = p_record_id and rm.module_id = m.id))
      loop
        if not module_membership_allowed(v_mod.id) then
          raise exception 'You cannot add records to or remove them from %.', v_mod.label
            using errcode = '42501';
        end if;
      end loop;
    end if;
  end if;

  delete from record_modules
   where record_id = p_record_id
     and module_id <> all (v_ids)
     and module_id <> all (v_auto);
  insert into record_modules (record_id, module_id, added_by)
  select p_record_id, m, auth.uid()
    from unnest(v_ids) as m
  on conflict (record_id, module_id) do nothing;

  select exists(select 1 from record_modules where record_id = p_record_id) into v_has_now;
  if v_had_any and not v_has_now then
    insert into record_activity (record_id, actor_id, kind, summary)
    values (p_record_id, auth.uid(), 'membership', 'Archived — no longer displayed in any module');
  else
    insert into record_activity (record_id, actor_id, kind, summary)
    values (p_record_id, auth.uid(), 'membership', 'Module membership updated');
  end if;
end;
$$;

-- ── Delete (to the Recycle Bin): Delete / archive records ────────────────────
create or replace function delete_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(rec) then
    raise exception 'not found';
  end if;
  if exists (select 1 from record_modules where record_id = rec) then
    raise exception 'Archive this record before deleting it — it is still displayed in a module'
      using errcode = '23514';
  end if;
  if not auth_is_admin() and auth_perm('action.archive') <> 'yes' then
    raise exception 'You do not have permission to delete records.' using errcode = '42501';
  end if;
  update records set deleted_at = now() where id = rec;
  insert into record_activity (record_id, actor_id, kind, summary)
  values (rec, auth.uid(), 'record', 'Deleted — moved to the Recycle Bin');
end;
$$;

-- ── Move records through pipeline stages ─────────────────────────────────────
create or replace function require_pipeline_action()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_is_admin() and auth_perm('action.pipeline') <> 'yes' then
    raise exception 'You do not have permission to move records through pipeline stages.'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function set_pipeline_step(p_record_id uuid, p_module_id uuid, p_pipeline_id uuid, p_step_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step_label text;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_module_edit_on_record(p_record_id, p_module_id);
  perform require_pipeline_action();
  if not exists (select 1 from pipelines p where p.id = p_pipeline_id and p.module_id = p_module_id) then
    raise exception 'That pipeline does not belong to that module' using errcode = '23503';
  end if;
  if not exists (select 1 from pipeline_steps s where s.id = p_step_id and s.pipeline_id = p_pipeline_id) then
    raise exception 'That step does not belong to that pipeline' using errcode = '23503';
  end if;
  select label into v_step_label from pipeline_steps where id = p_step_id;
  insert into record_pipelines (record_id, module_id, pipeline_id, step_id)
  values (p_record_id, p_module_id, p_pipeline_id, p_step_id)
  on conflict (record_id, module_id) do update
    set pipeline_id = excluded.pipeline_id, step_id = excluded.step_id, updated_at = now();
  insert into record_activity (record_id, actor_id, kind, summary, to_value)
  values (p_record_id, auth.uid(), 'pipeline', 'Pipeline step changed', v_step_label);
end;
$$;

create or replace function clear_pipeline(p_record_id uuid, p_module_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  perform require_module_edit_on_record(p_record_id, p_module_id);
  perform require_pipeline_action();
  delete from record_pipelines where record_id = p_record_id and module_id = p_module_id;
  insert into record_activity (record_id, actor_id, kind, summary)
  values (p_record_id, auth.uid(), 'pipeline', 'Pipeline removed');
end;
$$;

revoke execute on function require_pipeline_action() from public, anon;
grant execute on function require_pipeline_action() to authenticated;
