-- =============================================================================
-- The `membership` grant: who may add a record to, or remove it from, a module.
--
-- Client, 16 Oct 2026 (Addition 2): "a permission setting in the admin panel
-- which allows the admin to set permissions for which users can add/remove
-- records from modules … Izzy can also only choose to add to deals or remove
-- from contacts if the admin panel permissions tab allows him to."
--
-- ── WHAT IS STORED ───────────────────────────────────────────────────────
-- One `template_grants` / `user_grants` / `invite_grants` row per module with
-- `scope_kind = 'membership'` and `scope_id` = the module's id, `module_id`
-- NULL (it already names its module, like a `module` grant). The level reuses
-- `permission_level` so that no second enum, resolver or editor is needed:
--
--     edit    Yes — may add records to and remove them from this module
--     view    No  — may not
--     hidden  never stored; the writer refuses it (`grantWriteRefusal`)
--
-- ── HOW IT RESOLVES ──────────────────────────────────────────────────────
-- Same precedence as every grant: the user's own row, else the template's.
-- But the fallthrough is NOT `'edit'` — it is the module grant. Until an admin
-- sets this row, "may add/remove" means exactly what it meant yesterday: Edit
-- on the module. So this migration changes nobody's access by itself.
--
--     allowed = module grant ≠ Hidden
--           and coalesce(membership row, module grant) = Edit
--
-- A module the person cannot see is never one they can move records into or
-- out of, whatever this row says — the module grant stays the ceiling.
--
-- ── WHERE IT IS ENFORCED ─────────────────────────────────────────────────
-- Three places, as for every other write to a record's memberships:
--   1. `set_record_memberships` — the one writer every chip, Archive and bulk
--      action goes through — checks it for every module being ADDED or
--      REMOVED. The record-level requirement (Edit on the record through some
--      module it is in, or a fresh record placed by its creator) is unchanged:
--      this setting decides WHICH modules a person may move a record between,
--      not whether they may touch the record at all.
--   2. RLS on `record_modules`, for any path that is not the RPC.
--   3. `setMemberships` in the app, which also drives what the drawer offers.
-- =============================================================================

-- ── A membership row names its module in scope_id, like a module row ─────
alter table user_grants
  drop constraint if exists user_grants_module_scope_shape,
  add constraint user_grants_module_scope_shape
    check (scope_kind not in ('module', 'membership') or module_id is null);

alter table template_grants
  drop constraint if exists template_grants_module_scope_shape,
  add constraint template_grants_module_scope_shape
    check (scope_kind not in ('module', 'membership') or module_id is null);

alter table invite_grants
  drop constraint if exists invite_grants_module_scope_shape,
  add constraint invite_grants_module_scope_shape
    check (scope_kind not in ('module', 'membership') or module_id is null);

-- ── The existence guard knows the fifth kind ─────────────────────────────
create or replace function grant_scope_must_exist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exists boolean;
begin
  if new.scope_kind = 'module' or new.scope_kind = 'membership' then
    select exists (select 1 from modules m where m.id = new.scope_id) into v_exists;
  elsif new.scope_kind = 'tab' then
    select exists (select 1 from tabs t where t.id = new.scope_id) into v_exists;
  elsif new.scope_kind = 'subtab' then
    select exists (select 1 from subtabs s where s.id = new.scope_id) into v_exists;
  elsif new.scope_kind = 'field' then
    select exists (select 1 from fields f where f.id = new.scope_id) into v_exists;
  else
    v_exists := false;
  end if;

  if not v_exists then
    raise exception 'No % exists with id % — a grant on it would resolve for every request and be invisible to every screen.',
      new.scope_kind, new.scope_id
      using errcode = '23503';
  end if;

  return new;
end;
$$;

-- ── The stored membership level, or NULL when nothing is set ─────────────
-- `effective_grant()` cannot be used for this: its last coalesce arm is
-- 'edit', and here "not set" must fall through to the module grant instead.
create or replace function public.membership_grant_raw(u uuid, p_module uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select ug.grant_level from user_grants ug
      where ug.user_id = u and ug.scope_kind = 'membership'
        and ug.scope_id = p_module and ug.module_id is null),
    (select tg.grant_level from user_templates ut
       join template_grants tg on tg.template_id = ut.template_id
      where ut.user_id = u and tg.scope_kind = 'membership'
        and tg.scope_id = p_module and tg.module_id is null)
  );
$$;

revoke execute on function public.membership_grant_raw(uuid, uuid) from public, anon, authenticated;

-- ── May the caller add records to / remove them from this module? ────────
create or replace function public.module_membership_allowed(p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then true
    else exists (
      select 1
        from modules m
       where m.id = p_module
         and not m.admin_only
         and effective_grant(auth.uid(), 'module'::grant_scope, m.id, null) <> 'hidden'
         and coalesce(
               membership_grant_raw(auth.uid(), m.id),
               effective_grant(auth.uid(), 'module'::grant_scope, m.id, null)
             ) = 'edit'
    )
  end;
$$;

-- Evaluated inside RLS policies as the signed-in role, so it must be callable.
revoke execute on function public.module_membership_allowed(uuid) from public, anon;
grant execute on function public.module_membership_allowed(uuid) to authenticated;

-- ── RLS on record_modules asks the new question ──────────────────────────
drop policy if exists record_modules_insert on public.record_modules;
drop policy if exists record_modules_update on public.record_modules;
drop policy if exists record_modules_delete on public.record_modules;

create policy record_modules_insert on public.record_modules for insert to authenticated
  with check (record_module_editable(record_id) and module_membership_allowed(module_id));
create policy record_modules_update on public.record_modules for update to authenticated
  using (record_module_editable(record_id) and module_membership_allowed(module_id))
  with check (record_module_editable(record_id) and module_membership_allowed(module_id));
create policy record_modules_delete on public.record_modules for delete to authenticated
  using (record_module_editable(record_id) and module_membership_allowed(module_id));

-- ── The writer asks it for every module being added or removed ───────────
-- Identical to 9764's version except the check in the loop and its message.
create or replace function public.set_record_memberships(p_record_id uuid, p_module_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_had_any   boolean;
  v_has_now   boolean;
  v_ever_had  boolean;
  v_is_fresh  boolean;
  v_auto      uuid[];
  v_ids       uuid[];
  v_mod       record;
begin
  select coalesce(array_agg(m.id), '{}') into v_auto from modules m where m.shows_open_cases;

  select coalesce(array_agg(x), '{}') into v_ids
    from unnest(coalesce(p_module_ids, '{}')) as x
   where x <> all (v_auto);

  select exists(select 1 from record_modules where record_id = p_record_id) into v_had_any;

  select exists(
    select 1 from record_activity ra
     where ra.record_id = p_record_id and ra.kind = 'membership'
  ) into v_ever_had;

  v_is_fresh := not v_had_any
            and not v_ever_had
            and exists (
                  select 1 from records r
                   where r.id = p_record_id
                     and r.deleted_at is null
                     and r.creator_user_id = auth.uid()
                );

  if not (record_visible(p_record_id) or (v_is_fresh and can_see_record(p_record_id))) then
    raise exception 'not found';
  end if;

  if not auth_is_admin() then
    if v_had_any and not record_module_editable(p_record_id) then
      raise exception 'You do not have edit access to this record.'
        using errcode = '42501';
    end if;

    for v_mod in
      select m.id, m.label
        from modules m
       where m.id <> all (v_auto)
         and (m.id = any (v_ids))
             is distinct from
             (exists (select 1
                        from record_modules rm
                       where rm.record_id = p_record_id
                         and rm.module_id = m.id))
    loop
      if not module_membership_allowed(v_mod.id) then
        raise exception 'You cannot add records to or remove them from %.', v_mod.label
          using errcode = '42501';
      end if;
    end loop;
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
$function$;
