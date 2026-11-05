-- =============================================================================
-- Part 9913: Module access and the other settings can be set ON THE INVITE.
--
-- Client, 5 Nov 2026, looking at step two of Invite a user: "How do i edit module
-- permissions?" They could not: that step has only tabs and fields. Module access is
-- a setting (Permissions spec), settings could only belong to a user type or a user,
-- and a user does not exist until they finish signing up.
--
-- This does for settings what part 9300 did for grants: the same table gains a third
-- owner, `complete_signup` copies the rows across in the transaction that creates the
-- account, so nobody is ever briefly live on their type alone. The rows are then
-- removed: from there on the Users screen is the one place they live.
-- =============================================================================

alter table permission_settings drop constraint if exists permission_settings_owner_kind_check;
alter table permission_settings add constraint permission_settings_owner_kind_check
  check (owner_kind in ('template', 'user', 'invite'));

create or replace function permission_settings_owner_exists()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.owner_kind = 'user' and not exists (select 1 from profiles where id = new.owner_id) then
    raise exception 'No such user.';
  end if;
  if new.owner_kind = 'template' and not exists (select 1 from permission_templates where id = new.owner_id) then
    raise exception 'No such user type.';
  end if;
  if new.owner_kind = 'invite' and not exists (select 1 from invites where id = new.owner_id) then
    raise exception 'No such invite.';
  end if;
  return new;
end;
$$;

-- Invite rows go with their invite, as template rows go with their template.
create or replace function permission_settings_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from permission_settings
   where owner_kind = case tg_table_name when 'profiles' then 'user' when 'invites' then 'invite' else 'template' end
     and owner_id = old.id;
  return old;
end;
$$;
drop trigger if exists permission_settings_cleanup on invites;
create trigger permission_settings_cleanup after delete on invites
  for each row execute function permission_settings_cleanup();

-- Guardrail 3 for somebody who does not exist yet, and nothing on a closed invite: an
-- accepted one's rows have been copied, so a change there would quietly do nothing.
create or replace function perm_guard_invite_target(p_actor uuid, p_invite uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_status   text;
  v_is_admin boolean;
begin
  select i.status::text, r.is_admin into v_status, v_is_admin
    from invites i
    join roles r on r.id = i.role_id
   where i.id = p_invite;
  if not found then
    raise exception 'No such invite.';
  end if;
  if v_status <> 'pending' then
    raise exception 'This invite is no longer open.' using errcode = '42501';
  end if;
  if v_is_admin and not user_is_admin(p_actor) then
    raise exception 'Only a Super admin can change a Super admin.' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function perm_guard_invite_target(uuid, uuid) from public, anon, authenticated;

-- As part 9843 left it, with the third owner. Null on an invite, as on a user, means
-- back to their type.
create or replace function perm_set_setting(p_actor uuid, p_owner_kind text, p_owner uuid, p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before text;
begin
  if p_owner_kind = 'user' then perform perm_guard_user_target(p_actor, p_owner);
  elsif p_owner_kind = 'template' then perform perm_guard_template_target(p_actor, p_owner);
  elsif p_owner_kind = 'invite' then perform perm_guard_invite_target(p_actor, p_owner);
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

  if p_value = 'yes' and p_key ~ '^team\.[a-z_]+\.assign$' then
    perform perm_set_setting(p_actor, p_owner_kind, p_owner, regexp_replace(p_key, '\.assign$', '.see_team'), 'yes');
  end if;
end;
$$;

-- As part 9300 left it, with the settings copied beside the grants.
create or replace function public.complete_signup(p_user_id uuid, p_email citext, p_full_name text default null::text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_email  citext := lower(btrim(p_email));
  v_invite invites%rowtype;
begin
  select * into v_invite
    from invites
   where email = v_email
     and status = 'pending'
     and expires_at > now()
   for update;

  if not found then
    raise exception 'INVITE_NOT_VALID' using errcode = 'P0001';
  end if;

  insert into profiles (id, email, full_name, role_id)
  values (p_user_id, v_email, nullif(btrim(coalesce(p_full_name, '')), ''), v_invite.role_id);

  -- The permissions the admin chose when they sent the invite, applied before
  -- the account is usable rather than after.
  if v_invite.template_id is not null then
    insert into user_templates (user_id, template_id)
    values (p_user_id, v_invite.template_id)
    on conflict do nothing;
  end if;

  /*
   * The personal overrides chosen on the same screen. Copied rather than
   * linked — see part 9300. `on conflict do nothing` guards only against a
   * repeat of this statement; the unique index means the invite cannot hold
   * two rows for the same scope in the first place.
   */
  insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
  select p_user_id, ig.scope_kind, ig.scope_id, ig.grant_level, ig.module_id
    from invite_grants ig
   where ig.invite_id = v_invite.id
  on conflict do nothing;

  insert into permission_settings (owner_kind, owner_id, key, value, updated_by)
  select 'user', p_user_id, ps.key, ps.value, ps.updated_by
    from permission_settings ps
   where ps.owner_kind = 'invite' and ps.owner_id = v_invite.id
  on conflict (owner_kind, owner_id, key) do nothing;

  delete from permission_settings where owner_kind = 'invite' and owner_id = v_invite.id;

  update invites
     set status = 'accepted', accepted_at = now()
   where id = v_invite.id;

  return v_invite.role_id;
end;
$function$;
