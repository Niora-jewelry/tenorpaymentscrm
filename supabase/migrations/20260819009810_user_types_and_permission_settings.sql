-- =============================================================================
-- Permissions spec (26 Oct 2026) — part 1: the model.
--
-- Every user gets a USER TYPE, and each user type is a template of defaults:
-- Super admin, Admin, Underwriter, Accounting, Customer service, Sales agent.
-- A template can be changed, and one user can be changed without touching
-- their template (an override); "a user's own setting beats their template".
--
-- What already existed stays: Hidden / View / Edit grants on tabs, sub-tabs and
-- fields (template_grants / user_grants). What did not exist gets ONE table,
-- `permission_settings`, holding every setting the spec adds that is not a
-- Hidden/View/Edit level:
--
--   action.create | action.team | action.archive | action.modules | action.pipeline
--                                              yes | no        company-wide actions
--   module:<module id>                         hidden | mine | all   record access
--   notifications.scope | email.scope | phone.scope
--                                              own | all
--   admin.users | admin.permissions | admin.presets | admin.numbers |
--   admin.residuals | admin.integrations | admin.automations | admin.recycle_bin
--                                              hidden | full    admin pages
--   communication.scope                        own | org       the drawer's Communication tab
--   items.cases                                hidden | mine | all   (Tickets follows it)
--   items.updates | items.notes                mine | all
--
-- One resolver, `user_perm(user, key)`: the user's own setting, else their
-- template's, else the most restrictive value. A Super admin resolves every
-- key to its highest value — Super admin is "everything", and is the only type
-- that bypasses the grant tables (roles.is_admin), as before.
--
-- This migration changes no access by itself. It creates the model, seeds the
-- six templates from the spec's default tables, and puts every user on a type:
--   Izzy, brimesh, admin@tapdash.test (Super Admin role)  → Super admin
--   Maylyn                                                 → Underwriter (brimesh's choice)
--   everyone else (test and integration accounts)          → Sales agent
-- The two old templates ("admin template", "Support Agent") are removed and
-- their users moved — backed up first to backups/izzy-2026-10-28/. Individual
-- overrides from the old model are cleared with them: they were written for a
-- model where nobody had a type, and a user's type is the starting point now.
-- =============================================================================

-- ── user types on templates ─────────────────────────────────────────────────
alter table permission_templates
  add column if not exists user_type text unique
    check (user_type in ('super_admin', 'admin', 'underwriter', 'accounting', 'customer_service', 'sales_agent')),
  add column if not exists is_system boolean not null default false,
  add column if not exists position int not null default 100;

comment on column permission_templates.user_type is
  'One of the six user types (Permissions spec). Null for any extra template an admin creates.';

-- ── what a setting may hold ─────────────────────────────────────────────────
create or replace function permission_setting_valid(p_key text, p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key ~ '^action\.(create|team|archive|modules|pipeline)$' then p_value in ('yes', 'no')
    when p_key ~ '^module:[0-9a-f-]{36}$'                          then p_value in ('hidden', 'mine', 'all')
    when p_key in ('notifications.scope', 'email.scope', 'phone.scope') then p_value in ('own', 'all')
    when p_key ~ '^admin\.(users|permissions|presets|numbers|residuals|integrations|automations|recycle_bin)$'
                                                                    then p_value in ('hidden', 'full')
    when p_key = 'communication.scope'                              then p_value in ('own', 'org')
    when p_key = 'items.cases'                                      then p_value in ('hidden', 'mine', 'all')
    when p_key in ('items.updates', 'items.notes')                  then p_value in ('mine', 'all')
    else false
  end;
$$;

/* Ranks for "nobody can grant a level higher than their own" (Guardrails):
   Hidden < View < Edit; Hidden < Only mine < All; Own < All; No < Yes. */
create or replace function permission_value_rank(p_value text)
returns int
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_value
    when 'no' then 0 when 'hidden' then 0 when 'own' then 0
    when 'mine' then 1 when 'view' then 1
    when 'yes' then 2 when 'all' then 2 when 'full' then 2 when 'org' then 2 when 'edit' then 2
    else 0
  end;
$$;

/* The highest and lowest value a key can take. */
create or replace function permission_setting_max(p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key like 'action.%' then 'yes'
    when p_key like 'module:%' then 'all'
    when p_key like 'admin.%' then 'full'
    when p_key = 'communication.scope' then 'org'
    when p_key like '%.scope' then 'all'
    when p_key like 'items.%' then 'all'
  end;
$$;

create or replace function permission_setting_min(p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key like 'action.%' then 'no'
    when p_key like 'module:%' then 'hidden'
    when p_key like 'admin.%' then 'hidden'
    when p_key = 'communication.scope' then 'own'
    when p_key like '%.scope' then 'own'
    when p_key = 'items.cases' then 'hidden'
    when p_key like 'items.%' then 'mine'
  end;
$$;

create table if not exists permission_settings (
  owner_kind text not null check (owner_kind in ('template', 'user')),
  owner_id   uuid not null,
  key        text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null,
  primary key (owner_kind, owner_id, key),
  constraint permission_setting_valid check (permission_setting_valid(key, value))
);
create index if not exists permission_settings_owner on permission_settings (owner_kind, owner_id);
alter table permission_settings enable row level security;
alter table permission_settings force row level security;
-- Read and written by the server (service role) behind the Users and
-- Permissions pages' own checks, and by the SECURITY DEFINER resolvers below.
-- No policy: nobody reads this table directly.
revoke all on permission_settings from anon, authenticated;

-- A user's own setting must belong to a real user, a template's to a real template.
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
  return new;
end;
$$;
drop trigger if exists permission_settings_owner_exists on permission_settings;
create trigger permission_settings_owner_exists
  before insert or update on permission_settings
  for each row execute function permission_settings_owner_exists();

-- Template rows go with their template; user rows with their user.
create or replace function permission_settings_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from permission_settings
   where owner_kind = case when tg_table_name = 'profiles' then 'user' else 'template' end
     and owner_id = old.id;
  return old;
end;
$$;
drop trigger if exists permission_settings_cleanup on permission_templates;
create trigger permission_settings_cleanup after delete on permission_templates
  for each row execute function permission_settings_cleanup();
drop trigger if exists permission_settings_cleanup on profiles;
create trigger permission_settings_cleanup after delete on profiles
  for each row execute function permission_settings_cleanup();

-- ── the one resolver ─────────────────────────────────────────────────────────
create or replace function user_perm(u uuid, p_key text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when user_is_admin(u) then permission_setting_max(p_key)
    else coalesce(
      (select ps.value from permission_settings ps
        where ps.owner_kind = 'user' and ps.owner_id = u and ps.key = p_key),
      (select ps.value from user_templates ut
         join permission_settings ps on ps.owner_kind = 'template' and ps.owner_id = ut.template_id and ps.key = p_key
        where ut.user_id = u),
      permission_setting_min(p_key))
  end;
$$;

create or replace function auth_perm(p_key text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_perm(auth.uid(), p_key);
$$;

/* A user's access to one module's records. A module that shows open cases
   (Tickets) has no setting of its own: it follows the Cases setting. */
create or replace function user_module_scope(u uuid, p_module uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when m.shows_open_cases then user_perm(u, 'items.cases')
    else user_perm(u, 'module:' || m.id::text)
  end
  from modules m where m.id = p_module;
$$;

/* "Only mine = records where the user is a team member or the relationship
   manager" — plus records whose team includes someone who shared their view
   with this user (record_visibility_grants, unchanged). */
create or replace function user_owns_record(u uuid, rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from record_team_members t where t.record_id = rec and t.user_id = u)
      or exists (select 1 from records r
                  where r.id = rec
                    and jsonb_typeof(r.values -> 'relationship_manager') = 'array'
                    and (r.values -> 'relationship_manager') ? u::text)
      or exists (select 1 from record_visibility_grants g
                   join record_team_members t on t.user_id = g.owner_id
                  where g.viewer_id = u and t.record_id = rec);
$$;

revoke execute on function user_perm(uuid, text) from public, anon;
revoke execute on function user_module_scope(uuid, uuid) from public, anon;
revoke execute on function user_owns_record(uuid, uuid) from public, anon;
grant execute on function auth_perm(text) to authenticated;

-- ── the six templates ────────────────────────────────────────────────────────
insert into permission_templates (label, user_type, is_system, position)
values ('Super admin', 'super_admin', true, 10),
       ('Admin', 'admin', true, 20),
       ('Underwriter', 'underwriter', true, 30),
       ('Accounting', 'accounting', true, 40),
       ('Customer service', 'customer_service', true, 50),
       ('Sales agent', 'sales_agent', true, 60)
on conflict (user_type) do update set label = excluded.label, is_system = true, position = excluded.position;

-- ── their defaults (spec: "Default templates") ──────────────────────────────
-- One row per (type, key); the columns are the six types in the spec's order.
with types(t, i) as (
  values ('super_admin', 1), ('admin', 2), ('underwriter', 3), ('accounting', 4), ('customer_service', 5), ('sales_agent', 6)
),
defaults(k, v) as (
  values
    ('action.create',   array['yes','yes','yes','no','no','yes']),
    ('action.team',     array['yes','yes','yes','no','yes','no']),
    ('action.archive',  array['yes','yes','no','no','no','no']),
    ('action.modules',  array['yes','yes','yes','no','no','no']),
    ('action.pipeline', array['yes','yes','yes','no','yes','yes']),
    ('notifications.scope', array['all','own','own','own','own','own']),
    ('email.scope',         array['all','own','own','own','own','own']),
    ('phone.scope',         array['all','own','own','own','own','own']),
    ('admin.users',        array['full','full','hidden','hidden','hidden','hidden']),
    ('admin.permissions',  array['full','full','hidden','hidden','hidden','hidden']),
    ('admin.presets',      array['full','full','hidden','hidden','hidden','hidden']),
    ('admin.numbers',      array['full','full','hidden','hidden','hidden','hidden']),
    ('admin.residuals',    array['full','full','hidden','hidden','hidden','hidden']),
    ('admin.integrations', array['full','full','hidden','hidden','hidden','hidden']),
    ('admin.automations',  array['full','full','hidden','hidden','hidden','hidden']),
    ('admin.recycle_bin',  array['full','hidden','hidden','hidden','hidden','hidden']),
    ('communication.scope', array['org','org','org','org','org','own']),
    ('items.cases',   array['all','all','all','all','all','mine']),
    ('items.updates', array['all','all','all','all','all','mine']),
    ('items.notes',   array['all','all','all','all','all','mine'])
)
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, d.k, d.v[ty.i]
  from defaults d
  cross join types ty
  join permission_templates pt on pt.user_type = ty.t
on conflict (owner_kind, owner_id, key) do update set value = excluded.value, updated_at = now();

-- Module access. Records List: All for Super admin and Admin, Hidden for the
-- rest; Leads / Deals / Contacts: Only mine for Sales agent, All otherwise;
-- Residuals: Full (= all) for Super admin, Admin and Accounting.
with types(t, i) as (
  values ('super_admin', 1), ('admin', 2), ('underwriter', 3), ('accounting', 4), ('customer_service', 5), ('sales_agent', 6)
),
defaults(slug, v) as (
  values
    ('records',   array['all','all','hidden','hidden','hidden','hidden']),
    ('leads',     array['all','all','all','all','all','mine']),
    ('deals',     array['all','all','all','all','all','mine']),
    ('contacts',  array['all','all','all','all','all','mine']),
    ('residuals', array['all','all','hidden','all','hidden','hidden'])
)
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'module:' || m.id::text, d.v[ty.i]
  from defaults d
  join modules m on m.slug = d.slug
  cross join types ty
  join permission_templates pt on pt.user_type = ty.t
on conflict (owner_kind, owner_id, key) do update set value = excluded.value, updated_at = now();

-- A module that offers only Hidden / Full access (Residuals: "Full access
-- means they can edit and do anything in Residuals").
alter table modules add column if not exists full_access_only boolean not null default false;
update modules set full_access_only = true where slug = 'residuals';
comment on column modules.full_access_only is
  'Access is Hidden or Full only — no "Only mine" (Permissions spec: Residuals).';

-- Drawer tabs (spec: "Drawer tabs"). Super admin needs none (it bypasses).
-- Marketing "Full" is Edit; Logins "View / copy" is View (a copy is logged as
-- one); the Residuals tab follows Residuals access.
delete from template_grants tg using permission_templates pt
 where tg.template_id = pt.id and pt.user_type is not null and tg.scope_kind = 'tab';
with types(t, i) as (
  values ('admin', 1), ('underwriter', 2), ('accounting', 3), ('customer_service', 4), ('sales_agent', 5)
),
defaults(tab, v) as (
  values
    ('contact',          array['edit','edit','edit','edit','edit']),
    ('overview',         array['edit','edit','edit','edit','edit']),
    ('pricing',          array['edit','edit','edit','edit','view']),
    ('application',      array['edit','edit','edit','edit','edit']),
    ('equipment',        array['edit','edit','edit','edit','view']),
    ('files',            array['edit','edit','edit','edit','view']),
    ('statements',       array['edit','edit','edit','edit','view']),
    ('logins',           array['edit','edit','hidden','view','hidden']),
    ('marketing',        array['edit','hidden','hidden','hidden','hidden']),
    ('communication',    array['edit','edit','edit','edit','edit']),
    ('updates',          array['edit','edit','edit','edit','edit']),
    ('cases',            array['edit','edit','edit','edit','edit']),
    ('residual_figures', array['edit','hidden','edit','hidden','hidden'])
)
insert into template_grants (template_id, scope_kind, scope_id, grant_level, module_id)
select pt.id, 'tab', t.id, d.v[ty.i]::permission_level, null
  from defaults d
  join tabs t on t.key = d.tab
  cross join types ty
  join permission_templates pt on pt.user_type = ty.t;

-- ── every user on a type ─────────────────────────────────────────────────────
delete from user_grants;                       -- backed up; see the header
insert into user_templates (user_id, template_id)
select p.id,
       (select id from permission_templates where user_type =
          case
            when r.is_admin then 'super_admin'
            when lower(p.email::text) = 'maylyn@tapdash.co' then 'underwriter'
            else 'sales_agent'
          end)
  from profiles p
  join roles r on r.id = p.role_id
on conflict (user_id) do update set template_id = excluded.template_id;

delete from permission_templates where user_type is null and label in ('admin template', 'Support Agent');

-- New users default to Sales agent until someone picks a type.
comment on table user_templates is
  'Each user''s user type (Permissions spec). Every user has exactly one.';
