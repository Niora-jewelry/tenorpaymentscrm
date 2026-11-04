-- Integrations (client, 4 Nov 2026):
--   "inside integration give on off toggle of twillio etc"
--   "add mavrik api integration also in integration page"
--
-- 1. A service can be switched off without removing its keys. Off means the CRM
--    treats it as not connected everywhere (lib/integrations/resolve.ts), and On
--    brings it straight back with the keys already saved.
--    Alert email has no switch: sign-in codes go out through it, so turning it
--    off would lock everyone out, the super admin included.
-- 2. Maverick Payments joins the services whose keys can be entered here.
--
-- Same posture as 9900: no browser role can read or write these tables or call
-- these functions. The server reaches them with the service role after checking
-- the caller is a super admin.

alter table integration_settings drop constraint if exists integration_settings_grp_check;
alter table integration_settings add constraint integration_settings_grp_check
  check (grp in ('twilio', 'microsoft', 'signwell', 'alerts', 'maverick'));

alter table integration_tests drop constraint if exists integration_tests_grp_check;
alter table integration_tests add constraint integration_tests_grp_check
  check (grp in ('twilio', 'microsoft', 'signwell', 'alerts', 'maverick'));

alter table integration_changes drop constraint if exists integration_changes_action_check;
alter table integration_changes add constraint integration_changes_action_check
  check (action in ('set', 'removed', 'turned_on', 'turned_off'));

-- No row = on. Only a deliberate Off is stored.
create table if not exists integration_switches (
  id          uuid primary key default gen_random_uuid(),
  grp         text not null unique check (grp in ('twilio', 'microsoft', 'signwell', 'maverick')),
  enabled     boolean not null,
  updated_by  uuid references profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table integration_switches enable row level security;
alter table integration_switches force row level security;
revoke all on integration_switches from public, anon, authenticated;

-- The switch and its history row succeed or fail together.
create or replace function integration_set_enabled(p_actor uuid, p_group text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_was  boolean;
begin
  if p_group not in ('twilio', 'microsoft', 'signwell', 'maverick') then
    raise exception 'that service has no switch' using errcode = '22023';
  end if;
  select coalesce(nullif(trim(p.full_name), ''), p.email, 'Unknown') into v_name from profiles p where p.id = p_actor;
  if v_name is null then raise exception 'unknown user' using errcode = '42501'; end if;

  select enabled into v_was from integration_switches where grp = p_group for update;
  if coalesce(v_was, true) = p_enabled then return; end if;

  insert into integration_switches (grp, enabled, updated_by, updated_at)
  values (p_group, p_enabled, p_actor, now())
  on conflict (grp) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  insert into integration_changes (key, grp, action, hint, actor_id, actor_name)
  values ('(service)', p_group, case when p_enabled then 'turned_on' else 'turned_off' end, null, p_actor, v_name);
end;
$$;
revoke all on function integration_set_enabled(uuid, text, boolean) from public, anon, authenticated;
grant execute on function integration_set_enabled(uuid, text, boolean) to service_role;
