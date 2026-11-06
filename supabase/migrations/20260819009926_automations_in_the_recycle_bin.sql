-- Automations: Delete only once off, and the Recycle Bin holds what is deleted
-- (client, 6 Nov 2026: "If turned off then turn off button changes to Delete", and
-- on a deleted automation, "it lives in recycle bin. It can also be deleted from
-- recycle bin").
--
-- Both sorts land there: the ones built in the builder and the hard-coded ones.
-- Restoring brings one back off, so nothing starts running because of a restore.
--
-- Purging the two sorts differs, and on purpose. A built automation is data, so its
-- row goes and its versions and run history go with it. A hard-coded one is code that
-- keeps calling `system_automation_on`, and an unknown key there means ON, so removing
-- the row would quietly start the job again. Its row stays as a marker: `deleted_at`
-- keeps the job off, `purged_at` takes it out of the Recycle Bin.

-- ── Delete only once it is off ────────────────────────────────────────────
create or replace function automation_delete(p_automation uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a automations;
begin
  select * into a from automations where id = p_automation and deleted_at is null for update;
  if not found then raise exception 'That automation no longer exists.'; end if;
  if a.status in ('on', 'test') then raise exception 'Turn it off before deleting it.'; end if;
  update automations set deleted_at = now(), updated_by = p_actor, updated_at = now() where id = p_automation;
  perform automation_refresh_triggers(p_automation);
end;
$$;

-- ── Built automations: restore and purge ──────────────────────────────────
create or replace function restore_automation(p_automation uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore from the Recycle Bin.' using errcode = '42501';
  end if;
  update automations
     set deleted_at = null,
         status = case when status in ('on', 'test') then 'off' else status end,
         updated_by = auth.uid(), updated_at = now()
   where id = p_automation and deleted_at is not null;
  if not found then raise exception 'That automation is no longer in the Recycle Bin.'; end if;
  perform automation_refresh_triggers(p_automation);
end;
$$;

create or replace function purge_automation(p_automation uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may purge from the Recycle Bin.' using errcode = '42501';
  end if;
  delete from automations where id = p_automation and deleted_at is not null;
  if not found then raise exception 'That automation is no longer in the Recycle Bin.'; end if;
end;
$$;

-- ── Hard-coded automations: restore and purge ─────────────────────────────
alter table public.system_automations
  add column purged_at timestamptz,
  add column purged_by uuid references public.profiles(id) on delete set null,
  add constraint system_automations_purged_was_deleted check (purged_at is null or deleted_at is not null);

alter table public.system_automation_events drop constraint system_automation_events_kind_check;
alter table public.system_automation_events add constraint system_automation_events_kind_check
  check (kind in ('ran', 'failed', 'turned_on', 'turned_off', 'deleted', 'restored', 'purged'));

create or replace function restore_system_automation(p_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore from the Recycle Bin.' using errcode = '42501';
  end if;
  update system_automations
     set deleted_at = null, deleted_by = null
   where key = p_key and deleted_at is not null and purged_at is null;
  if not found then raise exception 'That automation is no longer in the Recycle Bin.'; end if;
  insert into system_automation_events (key, kind, actor_id) values (p_key, 'restored', auth.uid());
end;
$$;

create or replace function purge_system_automation(p_key text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may purge from the Recycle Bin.' using errcode = '42501';
  end if;
  update system_automations
     set purged_at = now(), purged_by = auth.uid()
   where key = p_key and deleted_at is not null and purged_at is null;
  if not found then raise exception 'That automation is no longer in the Recycle Bin.'; end if;
  insert into system_automation_events (key, kind, actor_id) values (p_key, 'purged', auth.uid());
end;
$$;

-- Each asks `auth_admin_page`, which needs the signed-in caller, so they are called
-- as the admin rather than through the service role.
revoke all on function restore_automation(uuid) from public, anon;
revoke all on function purge_automation(uuid) from public, anon;
revoke all on function restore_system_automation(text) from public, anon;
revoke all on function purge_system_automation(text) from public, anon;
grant execute on function restore_automation(uuid) to authenticated;
grant execute on function purge_automation(uuid) to authenticated;
grant execute on function restore_system_automation(text) to authenticated;
grant execute on function purge_system_automation(text) to authenticated;
