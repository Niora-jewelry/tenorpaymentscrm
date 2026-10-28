-- =============================================================================
-- Permissions spec — Guardrails, and "Log every permission change with who
-- changed it, when, and the before and after values."
--
-- Every permission write — a setting, a Hidden/View/Edit grant, a user's type,
-- resetting a user to their type — goes through ONE of the functions below.
-- Each checks the guardrails and writes its audit row in the same transaction
-- as the change, so a change without its history (or history without its
-- change) cannot exist. Called by the server only (service role), after the
-- page's own access check, with the acting user passed in.
--
-- Guardrails ("cannot be turned off"):
--   1. Nobody can edit their own permissions — their own overrides, or the
--      user type they are on.
--   2. Nobody can grant a level higher than their own:
--        Hidden < View < Edit; Hidden < Only mine < All; Own < All; No < Yes.
--   3. Nobody can edit or remove a Super admin except another Super admin
--      (and only a Super admin can make someone one).
--   4. There must always be at least one Super admin.
--
-- A user's type also decides whether they are a Super admin: the Super admin
-- type IS the Super Admin role (roles.is_admin), everyone else is a member.
-- =============================================================================

-- ── the log ──────────────────────────────────────────────────────────────────
create table if not exists permission_audit_log (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  actor_id    uuid references profiles(id) on delete set null,
  target_kind text not null check (target_kind in ('template', 'user', 'invite')),
  target_id   uuid not null,
  what        text not null,
  module_id   uuid,
  before      text,
  after       text
);
create index if not exists permission_audit_log_target on permission_audit_log (target_kind, target_id, at desc);
create index if not exists permission_audit_log_at on permission_audit_log (at desc);
alter table permission_audit_log enable row level security;
alter table permission_audit_log force row level security;
revoke all on permission_audit_log from anon, authenticated;
grant select on permission_audit_log to authenticated;
drop policy if exists permission_audit_log_select on permission_audit_log;
create policy permission_audit_log_select on permission_audit_log for select
  using (auth_is_admin() or auth_perm('admin.permissions') = 'full' or auth_perm('admin.users') = 'full');
drop trigger if exists permission_audit_log_no_update on permission_audit_log;
create trigger permission_audit_log_no_update before update on permission_audit_log
  for each row execute function refuse_mutation();
drop trigger if exists permission_audit_log_no_delete on permission_audit_log;
create trigger permission_audit_log_no_delete before delete on permission_audit_log
  for each row execute function refuse_mutation();

-- ── guardrail helpers ────────────────────────────────────────────────────────
create or replace function perm_template_is_super(p_template uuid)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select user_type = 'super_admin' from permission_templates where id = p_template), false);
$$;

/* 1 and 3, for a change aimed at one user (their overrides, type, reset). */
create or replace function perm_guard_user_target(p_actor uuid, p_user uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if p_actor = p_user then
    raise exception 'You cannot change your own permissions.' using errcode = '42501';
  end if;
  if user_is_admin(p_user) and not user_is_admin(p_actor) then
    raise exception 'Only a Super admin can change a Super admin.' using errcode = '42501';
  end if;
end;
$$;

/* 1 and 3, for a change to a user type (template). */
create or replace function perm_guard_template_target(p_actor uuid, p_template uuid)
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if perm_template_is_super(p_template) and not user_is_admin(p_actor) then
    raise exception 'Only a Super admin can change the Super admin type.' using errcode = '42501';
  end if;
  if not user_is_admin(p_actor)
     and exists (select 1 from user_templates where user_id = p_actor and template_id = p_template) then
    raise exception 'You cannot change the user type you are on — that would change your own permissions.' using errcode = '42501';
  end if;
end;
$$;

/* 4: at least one active Super admin, checked after the change. */
create or replace function perm_require_a_super_admin()
returns void
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from profiles p join roles r on r.id = p.role_id
     where r.is_admin and p.status = 'active' and p.deleted_at is null
  ) then
    raise exception 'There must always be at least one Super admin.' using errcode = '42501';
  end if;
end;
$$;

-- Applies to every route that can take away the last Super admin: pausing,
-- deleting, or moving them off the type — whoever does it.
create or replace function profiles_keep_a_super_admin()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform perm_require_a_super_admin();
  return null;
end;
$$;
drop trigger if exists profiles_keep_a_super_admin on profiles;
create constraint trigger profiles_keep_a_super_admin
  after update of status, deleted_at, role_id on profiles
  deferrable initially deferred
  for each row execute function profiles_keep_a_super_admin();

-- ── settings ─────────────────────────────────────────────────────────────────
-- p_value null on a user = remove the override (back to their type).
create or replace function perm_set_setting(p_actor uuid, p_owner_kind text, p_owner uuid, p_key text, p_value text)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_before text;
begin
  if p_owner_kind = 'user' then perform perm_guard_user_target(p_actor, p_owner);
  elsif p_owner_kind = 'template' then perform perm_guard_template_target(p_actor, p_owner);
  else raise exception 'Unknown owner.';
  end if;
  if p_value is not null then
    if not permission_setting_valid(p_key, p_value) then
      raise exception 'That is not a value % can take.', p_key;
    end if;
    -- 2: never above the actor's own level for the same setting.
    if permission_value_rank(p_value) > permission_value_rank(user_perm(p_actor, p_key)) then
      raise exception 'You cannot give a higher level than you have yourself.' using errcode = '42501';
    end if;
  elsif p_owner_kind = 'template' then
    raise exception 'A user type needs a value for every setting.';
  end if;

  select value into v_before from permission_settings
   where owner_kind = p_owner_kind and owner_id = p_owner and key = p_key;
  if v_before is not distinct from p_value then return; end if;

  if p_value is null then
    delete from permission_settings where owner_kind = p_owner_kind and owner_id = p_owner and key = p_key;
  else
    insert into permission_settings (owner_kind, owner_id, key, value, updated_by)
    values (p_owner_kind, p_owner, p_key, p_value, p_actor)
    on conflict (owner_kind, owner_id, key) do update
      set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  end if;

  insert into permission_audit_log (actor_id, target_kind, target_id, what, before, after)
  values (p_actor, p_owner_kind, p_owner, p_key, v_before, p_value);
end;
$$;

-- ── Hidden / View / Edit grants (tabs, sub-tabs, fields, …) ─────────────────
-- p_level null = remove the grant (falls back to the type / to Edit).
create or replace function perm_set_grant(
  p_actor uuid, p_owner_kind text, p_owner uuid,
  p_scope_kind grant_scope, p_scope_id uuid, p_module uuid, p_level permission_level
)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_before permission_level;
  v_mine   permission_level;
  v_module uuid := case when p_scope_kind in ('module', 'membership') then null else p_module end;
begin
  if p_owner_kind = 'user' then perform perm_guard_user_target(p_actor, p_owner);
  elsif p_owner_kind = 'template' then perform perm_guard_template_target(p_actor, p_owner);
  elsif p_owner_kind <> 'invite' then raise exception 'Unknown owner.';
  end if;

  if p_level is not null and not user_is_admin(p_actor) then
    v_mine := effective_grant(p_actor, p_scope_kind, p_scope_id, v_module);
    if permission_value_rank(p_level::text) > permission_value_rank(v_mine::text) then
      raise exception 'You cannot give a higher level than you have yourself.' using errcode = '42501';
    end if;
  end if;

  if p_owner_kind = 'template' then
    select grant_level into v_before from template_grants
     where template_id = p_owner and scope_kind = p_scope_kind and scope_id = p_scope_id and module_id is not distinct from v_module;
    if v_before is not distinct from p_level then return; end if;
    delete from template_grants
     where template_id = p_owner and scope_kind = p_scope_kind and scope_id = p_scope_id and module_id is not distinct from v_module;
    if p_level is not null then
      insert into template_grants (template_id, scope_kind, scope_id, grant_level, module_id)
      values (p_owner, p_scope_kind, p_scope_id, p_level, v_module);
    end if;
  elsif p_owner_kind = 'user' then
    select grant_level into v_before from user_grants
     where user_id = p_owner and scope_kind = p_scope_kind and scope_id = p_scope_id and module_id is not distinct from v_module;
    if v_before is not distinct from p_level then return; end if;
    delete from user_grants
     where user_id = p_owner and scope_kind = p_scope_kind and scope_id = p_scope_id and module_id is not distinct from v_module;
    if p_level is not null then
      insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
      values (p_owner, p_scope_kind, p_scope_id, p_level, v_module);
    end if;
  else
    select grant_level into v_before from invite_grants
     where invite_id = p_owner and scope_kind = p_scope_kind and scope_id = p_scope_id and module_id is not distinct from v_module;
    if v_before is not distinct from p_level then return; end if;
    delete from invite_grants
     where invite_id = p_owner and scope_kind = p_scope_kind and scope_id = p_scope_id and module_id is not distinct from v_module;
    if p_level is not null then
      insert into invite_grants (invite_id, scope_kind, scope_id, grant_level, module_id)
      values (p_owner, p_scope_kind, p_scope_id, p_level, v_module);
    end if;
  end if;

  insert into permission_audit_log (actor_id, target_kind, target_id, what, module_id, before, after)
  values (p_actor, p_owner_kind, p_owner, p_scope_kind::text || ':' || p_scope_id::text, v_module,
          v_before::text, p_level::text);
end;
$$;

-- ── a user's type ────────────────────────────────────────────────────────────
-- Their overrides stay ("A user with individual overrides still gets template
-- changes. Only the settings that were overridden for them stay as they are").
create or replace function perm_assign_type(p_actor uuid, p_user uuid, p_template uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_before uuid;
  v_super  boolean := perm_template_is_super(p_template);
begin
  perform perm_guard_user_target(p_actor, p_user);
  if v_super and not user_is_admin(p_actor) then
    raise exception 'Only a Super admin can make someone a Super admin.' using errcode = '42501';
  end if;
  if not exists (select 1 from permission_templates where id = p_template) then
    raise exception 'No such user type.';
  end if;
  select template_id into v_before from user_templates where user_id = p_user;
  if v_before is not distinct from p_template then return; end if;

  insert into user_templates (user_id, template_id) values (p_user, p_template)
  on conflict (user_id) do update set template_id = excluded.template_id;
  update profiles
     set role_id = (select id from roles where is_admin = v_super order by slug limit 1)
   where id = p_user;

  insert into permission_audit_log (actor_id, target_kind, target_id, what, before, after)
  values (p_actor, 'user', p_user, 'user_type',
          (select label from permission_templates where id = v_before),
          (select label from permission_templates where id = p_template));
end;
$$;

-- ── back to their type ───────────────────────────────────────────────────────
create or replace function perm_reset_user(p_actor uuid, p_user uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_n int := 0;
  s record;
begin
  perform perm_guard_user_target(p_actor, p_user);
  for s in select key, value from permission_settings where owner_kind = 'user' and owner_id = p_user loop
    insert into permission_audit_log (actor_id, target_kind, target_id, what, before, after)
    values (p_actor, 'user', p_user, s.key, s.value, null);
    v_n := v_n + 1;
  end loop;
  for s in select scope_kind::text || ':' || scope_id::text as what, module_id, grant_level::text as lvl
             from user_grants where user_id = p_user loop
    insert into permission_audit_log (actor_id, target_kind, target_id, what, module_id, before, after)
    values (p_actor, 'user', p_user, s.what, s.module_id, s.lvl, null);
    v_n := v_n + 1;
  end loop;
  delete from permission_settings where owner_kind = 'user' and owner_id = p_user;
  delete from user_grants where user_id = p_user;
  return v_n;
end;
$$;

revoke execute on function perm_set_setting(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function perm_set_grant(uuid, text, uuid, grant_scope, uuid, uuid, permission_level) from public, anon, authenticated;
revoke execute on function perm_assign_type(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function perm_reset_user(uuid, uuid) from public, anon, authenticated;
revoke execute on function perm_guard_user_target(uuid, uuid) from public, anon, authenticated;
revoke execute on function perm_guard_template_target(uuid, uuid) from public, anon, authenticated;
