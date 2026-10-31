-- =============================================================================
-- Team Assignment (client spec, 29 Oct 2026).
--
-- A team is a user type. A record can carry any number of teams; each stays
-- Open until one of its members takes it (or is named), and then nobody else
-- on that team can take it until it is unassigned.
--
--   record_team_assignments   one row per team on a record. `taken_by` null = Open.
--   team_members_assigned     the field that grants record visibility, unchanged.
--                             Taking adds the person to it, so "after it's taken"
--                             is the normal rules, with nothing new to maintain.
--   team_assignments_reconcile keeps the two in step, from the trigger that
--                             already follows the field, so every writer of the
--                             field (create, bulk edit, offboarding) stays right.
--
-- Twelve live records carry two people from one team, from before this feature.
-- Nobody is removed: the first is the team's taker, and the second stays on the
-- record and shows under the team. Only new assignments are one person per team.
--
-- Three levels of sight:
--   rules    the existing module and team-member rules      can do everything
--   open     See open records + Can view open items         can open, read only
--   list     See open records, no Can view open items       a list row, no drawer
-- See open records only ever ADDS sight: it does not take a record away from
-- someone the existing rules already let in. A sales agent's own record that
-- gets assigned to Underwriting must not vanish from them.
-- =============================================================================

alter type activity_kind add value if not exists 'assignment';

-- ── teams ────────────────────────────────────────────────────────────────────

-- The spec names the team "Underwriting"; the user type is "Underwriter".
alter table permission_templates add column if not exists team_label text;
update permission_templates set team_label = 'Underwriting' where user_type = 'underwriter';

create table record_team_assignments (
  record_id   uuid not null references records on delete cascade,
  team_id     uuid not null references permission_templates on delete cascade,
  taken_by    uuid references profiles on delete set null,
  taken_at    timestamptz,
  assigned_by uuid references profiles on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (record_id, team_id)
);
create index record_team_assignments_open on record_team_assignments (record_id) where taken_by is null;
create index record_team_assignments_taker on record_team_assignments (taken_by) where taken_by is not null;
alter table record_team_assignments enable row level security;
alter table record_team_assignments force row level security;
-- No policy: `team_assignment_view()` is the only reader, because what a viewer
-- may see of a row depends on their settings for that row's team.
revoke all on record_team_assignments from anon, authenticated;

-- The history of an assignment is hidden by the same rules as the assignment.
alter table updates add column if not exists team_id uuid references permission_templates on delete set null;
alter table updates add column if not exists names_person boolean not null default false;
alter table record_activity add column if not exists team_id uuid;
alter table record_activity add column if not exists names_person boolean not null default false;

-- ── settings ─────────────────────────────────────────────────────────────────

create or replace function permission_setting_valid(p_key text, p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key ~ '^action\.(create|team|archive|modules|pipeline|pipeline_change|team_view_open|team_take)$' then p_value in ('yes', 'no')
    when p_key ~ '^team\.[a-z_]+\.(assign|assign_member|unassign|see_open|see_team|see_users)$' then p_value in ('yes', 'no')
    when p_key ~ '^module:[0-9a-f-]{36}$'                          then p_value in ('hidden', 'mine', 'all')
    when p_key in ('notifications.scope', 'email.scope', 'phone.scope') then p_value in ('own', 'all')
    when p_key ~ '^admin\.(users|permissions|presets|numbers|residuals|integrations|automations|recycle_bin)$'
                                                                    then p_value in ('hidden', 'full')
    when p_key = 'communication.scope'                              then p_value in ('own', 'org')
    when p_key = 'items.cases'                                      then p_value in ('hidden', 'mine', 'all')
    when p_key in ('items.updates', 'items.notes')                  then p_value in ('mine', 'all')
    when p_key = 'applications.pdfs'                                then p_value in ('hidden', 'full')
    when p_key = 'agreements.send'                                  then p_value in ('yes', 'no')
    else false
  end;
$$;

create or replace function permission_setting_max(p_key text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_key like 'action.%' then 'yes'
    when p_key like 'team.%' then 'yes'
    when p_key like 'module:%' then 'all'
    when p_key like 'admin.%' then 'full'
    when p_key = 'applications.pdfs' then 'full'
    when p_key = 'agreements.send' then 'yes'
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
    when p_key like 'team.%' then 'no'
    when p_key like 'module:%' then 'hidden'
    when p_key like 'admin.%' then 'hidden'
    when p_key = 'applications.pdfs' then 'hidden'
    when p_key = 'agreements.send' then 'no'
    when p_key = 'communication.scope' then 'own'
    when p_key like '%.scope' then 'own'
    when p_key = 'items.cases' then 'hidden'
    when p_key like 'items.%' then 'mine'
  end;
$$;

-- The defaults. Every type is Yes on everything except Sales agent.
insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'team.' || t.user_type || '.' || s.name,
       case
         when pt.user_type <> 'sales_agent' then 'yes'
         when s.name = 'assign'     and t.user_type in ('underwriter', 'customer_service', 'sales_agent') then 'yes'
         when s.name = 'unassign'   and t.user_type = 'customer_service' then 'yes'
         when s.name = 'see_team'   and t.user_type in ('underwriter', 'customer_service', 'sales_agent') then 'yes'
         when s.name = 'see_users'  and t.user_type in ('customer_service', 'sales_agent') then 'yes'
         else 'no'
       end
  from permission_templates pt
 cross join (select user_type from permission_templates where user_type is not null) t
 cross join (values ('assign'), ('assign_member'), ('unassign'), ('see_open'), ('see_team'), ('see_users')) s(name)
 where pt.user_type is not null
on conflict (owner_kind, owner_id, key) do nothing;

insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, s.key, case when s.key = 'action.team_view_open' and pt.user_type = 'sales_agent' then 'no' else 'yes' end
  from permission_templates pt
 cross join (values ('action.team_view_open'), ('action.team_take')) s(key)
 where pt.user_type is not null
on conflict (owner_kind, owner_id, key) do nothing;

-- Rule 3: turning on "Assign this team" turns on "See team when assigned" too.
-- Never "See users when assigned". The same statement as the rest of this
-- function, so the audit log holds both changes.
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

-- The snapshot the app reads. `ceiling` on the admin screens comes from here too.
create or replace function user_permissions(u uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'superAdmin', user_is_admin(u),
    'userType', (select pt.user_type from user_templates ut join permission_templates pt on pt.id = ut.template_id where ut.user_id = u),
    'settings', (
      select jsonb_object_agg(k, user_perm(u, k))
        from unnest(array[
          'action.create', 'action.team', 'action.archive', 'action.modules', 'action.pipeline', 'action.pipeline_change',
          'action.team_view_open', 'action.team_take',
          'notifications.scope', 'email.scope', 'phone.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes',
          'applications.pdfs', 'agreements.send'
        ] || array(
          select 'team.' || pt.user_type || '.' || s
            from permission_templates pt
           cross join unnest(array['assign', 'assign_member', 'unassign', 'see_open', 'see_team', 'see_users']) s
           where pt.user_type is not null
        )) as k
    ),
    'modules', (select coalesce(jsonb_object_agg(m.id::text, user_module_scope(u, m.id)), '{}'::jsonb) from modules m)
  );
$$;

-- ── who is on which team, and what they may do with it ───────────────────────

create or replace function user_team(u uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ut.template_id
    from user_templates ut
    join permission_templates pt on pt.id = ut.template_id
   where ut.user_id = u and pt.user_type is not null
   limit 1;
$$;

create or replace function team_name(p_team uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(team_label, label) from permission_templates where id = p_team;
$$;

create or replace function team_perm(u uuid, p_team uuid, p_setting text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select user_perm(u, 'team.' || pt.user_type || '.' || p_setting) = 'yes'
      from permission_templates pt
     where pt.id = p_team and pt.user_type is not null
  ), false);
$$;

/* Rule 1: a user can always assign their own team, whatever their settings say. */
create or replace function user_can_assign_team(u uuid, p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_team(u) is not distinct from p_team or team_perm(u, p_team, 'assign');
$$;

create or replace function user_sees_team(u uuid, p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select team_perm(u, p_team, 'see_team');
$$;

/* Rule 4: "See users when assigned" works only with "See team when assigned". */
create or replace function user_sees_team_users(u uuid, p_team uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select team_perm(u, p_team, 'see_team') and team_perm(u, p_team, 'see_users');
$$;

-- ── the three levels of sight ────────────────────────────────────────────────

/* 'none', 'list' or 'open', from this record's open assignments alone. Reads
   permissions only when the record HAS an open assignment, so the great
   majority of rows pay for one index probe. */
create or replace function user_open_level(u uuid, rec uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not exists (
      select 1
        from record_team_assignments a
       where a.record_id = rec and a.taken_by is null
         and team_perm(u, a.team_id, 'see_open')
    ) then 'none'
    when user_perm(u, 'action.team_view_open') = 'yes' then 'open'
    else 'list'
  end;
$$;

/* The existing rules, by their own name: admin, or a module's All, or Only mine. */
create or replace function user_can_see_record_by_rules(u uuid, rec uuid)
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

create or replace function user_can_see_record(u uuid, rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_can_see_record_by_rules(u, rec) or user_open_level(u, rec) = 'open';
$$;

/* May this record be a row in this viewer's list? The child tables and the
   drawer stay on `record_visible`, which a 'list' viewer does not pass. */
create or replace function record_listable(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from records r where r.id = rec and r.deleted_at is null)
     and (user_can_see_record_by_rules(auth.uid(), rec) or user_open_level(auth.uid(), rec) <> 'none')
     and record_module_visible(rec);
$$;

/* May this viewer change anything on the record? An 'open' viewer may read it,
   not work it: that takes Assign to me. */
create or replace function record_writable(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select record_visible(rec) and user_can_see_record_by_rules(auth.uid(), rec);
$$;

create or replace function record_field_grant(rec uuid, p_field_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when g.level = 'edit' and not user_can_see_record_by_rules(auth.uid(), rec) then 'view'::permission_level
    else g.level
  end
  from (select user_record_field_grant(auth.uid(), rec, p_field_key) as level) g;
$$;

create or replace function record_scope_grant(rec uuid, p_kind grant_scope, p_scope uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when g.level = 'edit' and not user_can_see_record_by_rules(auth.uid(), rec) then 'view'::permission_level
    else g.level
  end
  from (select user_record_scope_grant(auth.uid(), rec, p_kind, p_scope) as level) g;
$$;

create or replace function record_module_editable(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_record_module_visible(auth.uid(), rec) and user_can_see_record_by_rules(auth.uid(), rec);
$$;

drop policy if exists records_select on records;
create policy records_select on records for select using (deleted_at is null and record_listable(id));

-- ── hiding the people ────────────────────────────────────────────────────────

/* Everyone this viewer may not see on an assignment. A person never hides from
   themselves. */
create or replace function viewer_hidden_assignees()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when auth_is_admin() then '{}'::text[] else coalesce((
    select array_agg(ut.user_id::text)
      from user_templates ut
     where ut.user_id <> auth.uid()
       and not user_sees_team_users(auth.uid(), ut.template_id)
  ), '{}'::text[]) end;
$$;

create or replace function strip_hidden_assignees(p_values jsonb, p_hidden text[])
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when cardinality(p_hidden) = 0 or jsonb_typeof(p_values -> 'team_members_assigned') is distinct from 'array' then p_values
    else jsonb_set(p_values, '{team_members_assigned}', (p_values -> 'team_members_assigned') - p_hidden)
  end;
$$;

create or replace function record_values_for(p_ids uuid[])
returns table (id uuid, "values" jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recs as (
    select r.id, r.values, r.deal_name, r.creator_kind, r.creator_user_id,
           record_display_module_set(r.id) as mods
      from records r
     where r.id = any(p_ids)
       and record_listable(r.id)
  ),
  hidden as (
    select s.mods, hidden_field_keys_for_modules(s.mods) as keys
      from (select distinct mods from recs) s
  ),
  people as (select viewer_hidden_assignees() as ids)
  select r.id,
         strip_hidden_assignees(r.values - h.keys, (select ids from people))
         || case
              when 'deal_name' = any(h.keys) then '{}'::jsonb
              else jsonb_build_object('deal_name', r.deal_name)
            end
         || case
              when 'record_creator' = any(h.keys)
                or r.creator_kind <> 'user'
                or r.creator_user_id is null
                then '{}'::jsonb
              else jsonb_build_object(
                     'record_creator', jsonb_build_array(r.creator_user_id::text))
            end
    from recs r
    join hidden h on h.mods = r.mods;
$$;

-- The list's view: the same two changes, on the definition that is live.
do $$
declare
  v_def  text := pg_get_viewdef('records_filterable'::regclass, true);
  v_opts text[];
  v_with text := '';
begin
  if position('WHERE record_visible(id)' in v_def) = 0 then raise exception 'records_filterable: unexpected filter'; end if;
  if position('r."values" - k.keys' in v_def) = 0 then raise exception 'records_filterable: unexpected values expression'; end if;
  v_def := replace(v_def, 'WHERE record_visible(id)', 'WHERE record_listable(id)');
  v_def := replace(v_def, 'r."values" - k.keys', 'strip_hidden_assignees(r."values" - k.keys, ( SELECT viewer_hidden_assignees() AS viewer_hidden_assignees))');
  select reloptions into v_opts from pg_class where oid = 'records_filterable'::regclass;
  if v_opts is not null then v_with := ' with (' || array_to_string(v_opts, ', ') || ')'; end if;
  execute 'create or replace view records_filterable' || v_with || ' as ' || v_def;
end $$;

create or replace function record_team_member_ids(p_record_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(user_id), '{}')
    from record_team_members
   where record_id = p_record_id and record_visible(p_record_id)
     and user_id::text <> all (viewer_hidden_assignees());
$$;

-- History follows the same rules: "left out completely".
create or replace function team_log_visible(u uuid, p_team uuid, p_names_person boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_is_admin(u)
      or case when p_names_person then user_sees_team_users(u, p_team) else user_sees_team(u, p_team) end;
$$;

drop policy if exists updates_select on updates;
create policy updates_select on updates for select using (
  record_visible(record_id)
  and tab_visible(record_id, 'updates')
  and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden')
  and ((author_id = (select auth.uid())) or update_visible_to((select auth.uid()), id))
  and (team_id is null or author_id = (select auth.uid()) or team_log_visible((select auth.uid()), team_id, names_person))
);

-- A row of the field's own history holds raw user ids, so it is shown only to
-- someone with no one hidden from them.
drop policy if exists record_activity_select on record_activity;
create policy record_activity_select on record_activity for select using (
  record_visible(record_id)
  and (team_id is null or actor_id = (select auth.uid()) or team_log_visible((select auth.uid()), team_id, names_person))
  and (field_key is distinct from 'team_members_assigned' or cardinality((select viewer_hidden_assignees())) = 0)
);

-- ── keeping the assignments and the field in step ────────────────────────────

/* From the field to the assignments, for one record. Idempotent. A team with
   people on the field has a row, and its taker is one of them; a row whose
   taker left the field passes to the next person from that team, or goes back
   to Open (rule 6). */
create or replace function team_assignments_reconcile(p_record uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_raw jsonb;
begin
  select values -> 'team_members_assigned' into v_raw from records where id = p_record;
  if jsonb_typeof(coalesce(v_raw, '[]'::jsonb)) <> 'array' then return; end if;

  with people as (
    select x.ord, x.id::uuid as uid, user_team(x.id::uuid) as team
      from jsonb_array_elements_text(coalesce(v_raw, '[]'::jsonb)) with ordinality as x(id, ord)
  ),
  firsts as (
    select distinct on (team) team, uid from people where team is not null order by team, ord
  )
  update record_team_assignments a
     set taken_by = f.uid,
         taken_at = case when f.uid is null then null else now() end
    from (select a2.team_id, (select f2.uid from firsts f2 where f2.team = a2.team_id) as uid
            from record_team_assignments a2 where a2.record_id = p_record) f
   where a.record_id = p_record
     and a.team_id = f.team_id
     and a.taken_by is distinct from f.uid
     and (a.taken_by is null
          or not exists (select 1 from people p where p.uid = a.taken_by and p.team = a.team_id));

  insert into record_team_assignments (record_id, team_id, taken_by, taken_at)
  select p_record, t.team, t.uid, now()
    from (
      select distinct on (user_team(x.id::uuid)) user_team(x.id::uuid) as team, x.id::uuid as uid
        from jsonb_array_elements_text(coalesce(v_raw, '[]'::jsonb)) with ordinality as x(id, ord)
       where user_team(x.id::uuid) is not null
       order by user_team(x.id::uuid), x.ord
    ) t
  on conflict (record_id, team_id) do nothing;
end;
$$;

create or replace function sync_record_team_members()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_raw jsonb := coalesce(new.values -> 'team_members_assigned', '[]'::jsonb);
  v_ids uuid[];
begin
  if jsonb_typeof(v_raw) <> 'array' then
    raise exception
      using errcode = '22023',
            message = format(
              'team_members_assigned must be a JSON array of user ids, got %s',
              jsonb_typeof(v_raw)
            ),
            hint = 'A value written as a JSON-encoded string instead of an array does this.';
  end if;

  select coalesce(array_agg((x)::uuid), '{}')
    into v_ids
    from jsonb_array_elements_text(v_raw) as x;

  delete from record_team_members
   where record_id = new.id and user_id <> all (v_ids);

  insert into record_team_members (record_id, user_id)
  select new.id, u from unnest(v_ids) as u
  on conflict (user_id, record_id) do nothing;

  if tg_op = 'INSERT' or old.values -> 'team_members_assigned' is distinct from new.values -> 'team_members_assigned' then
    perform team_assignments_reconcile(new.id);
  end if;

  return new;
end;
$$;

/* A direct write to the field (the field's own API, a bulk edit) is held to the
   same settings as the assign picker. The assignment functions below, and
   anyone who may run the Users page's offboarding, pass. */
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
    if exists (select 1 from record_team_assignments a
                where a.record_id = new.id and a.team_id = v_team and a.taken_by is not null
                  and not exists (select 1 from jsonb_array_elements_text(v_old) o where o = a.taken_by::text and not (v_new ? o))) then
      raise exception '% is already taken on this record. Unassign it first.', team_name(v_team) using errcode = '23505';
    end if;
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

create trigger records_guard_team_field
  before insert or update of values on records
  for each row execute function records_guard_team_field();

/* Moving someone to another user type moves their assignments with them. */
create or replace function user_templates_reconcile_assignments()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := coalesce(new.user_id, old.user_id);
  v_rec  uuid;
begin
  for v_rec in select record_id from record_team_members where user_id = v_user loop
    perform team_assignments_reconcile(v_rec);
  end loop;
  return null;
end;
$$;

create trigger user_templates_reconcile_assignments
  after insert or update of template_id on user_templates
  for each row execute function user_templates_reconcile_assignments();

-- ── the assignment functions ─────────────────────────────────────────────────

/* The one writer of an assignment's history. Spec: every action is recorded in
   the record's Updates tab. Never a notification. */
create or replace function team_log(p_record uuid, p_team uuid, p_names_person boolean, p_summary text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into updates (record_id, author_id, body, team_id, names_person)
  values (p_record, auth.uid(), p_summary, p_team, p_names_person);
  insert into record_activity (record_id, actor_id, kind, summary, team_id, names_person)
  values (p_record, auth.uid(), 'assignment', p_summary, p_team, p_names_person);
end;
$$;

create or replace function team_write_field(p_record uuid, p_ids jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform set_config('tapdash.team_write', 'on', true);
  update records
     set values = jsonb_set(values, '{team_members_assigned}', p_ids, true), updated_at = now()
   where id = p_record and deleted_at is null;
  perform set_config('tapdash.team_write', 'off', true);
end;
$$;

create or replace function team_person_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(btrim(full_name), ''), email::text) from profiles where id = p_user;
$$;

/* One assignment change at a time per record: the row lock is what makes
   "once someone takes it, nobody else can" true under two simultaneous clicks. */
create or replace function team_lock_record(p_record uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb;
begin
  select coalesce(values -> 'team_members_assigned', '[]'::jsonb) into v_ids
    from records where id = p_record and deleted_at is null for update;
  if v_ids is null then raise exception 'not found'; end if;
  return v_ids;
end;
$$;

create or replace function team_is_real(p_team uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from permission_templates where id = p_team and user_type is not null) then
    raise exception 'That team does not exist.' using errcode = '23503';
  end if;
end;
$$;

create or replace function assign_team(p_record uuid, p_team uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not record_writable(p_record) then raise exception 'not found'; end if;
  perform team_is_real(p_team);
  if not user_can_assign_team(auth.uid(), p_team) then
    raise exception 'You cannot assign %.', team_name(p_team) using errcode = '42501';
  end if;
  perform team_lock_record(p_record);
  insert into record_team_assignments (record_id, team_id, assigned_by)
  values (p_record, p_team, auth.uid())
  on conflict (record_id, team_id) do nothing;
  if not found then
    raise exception '% is already assigned to this record.', team_name(p_team) using errcode = '23505';
  end if;
  perform team_log(p_record, p_team, false, 'Assigned the ' || team_name(p_team) || ' team.');
end;
$$;

create or replace function assign_team_member(p_record uuid, p_team uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids   jsonb;
  v_taker uuid;
begin
  if not record_writable(p_record) then raise exception 'not found'; end if;
  perform team_is_real(p_team);
  if not (user_can_assign_team(auth.uid(), p_team) and team_perm(auth.uid(), p_team, 'assign_member')) then
    raise exception 'You cannot assign a specific member of %.', team_name(p_team) using errcode = '42501';
  end if;
  if user_team(p_user) is distinct from p_team
     or not exists (select 1 from profiles where id = p_user and status = 'active' and deleted_at is null) then
    raise exception 'That person is not an active member of %.', team_name(p_team) using errcode = '23503';
  end if;

  v_ids := team_lock_record(p_record);
  select taken_by into v_taker from record_team_assignments where record_id = p_record and team_id = p_team;
  if v_taker is not null then
    raise exception '% is already taken on this record. Unassign it first.', team_name(p_team) using errcode = '23505';
  end if;

  insert into record_team_assignments (record_id, team_id, taken_by, taken_at, assigned_by)
  values (p_record, p_team, p_user, now(), auth.uid())
  on conflict (record_id, team_id) do update set taken_by = excluded.taken_by, taken_at = excluded.taken_at;

  if not (v_ids ? p_user::text) then perform team_write_field(p_record, v_ids || to_jsonb(p_user::text)); end if;
  perform team_log(p_record, p_team, true, 'Assigned ' || team_person_name(p_user) || ' from the ' || team_name(p_team) || ' team.');
end;
$$;

/* Assign to me. A 'list' viewer may do this: it is the way in. */
create or replace function take_team_assignment(p_record uuid, p_team uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me  uuid := auth.uid();
  v_ids jsonb;
begin
  if not record_listable(p_record) then raise exception 'not found'; end if;
  if user_team(v_me) is distinct from p_team or user_perm(v_me, 'action.team_take') <> 'yes' then
    raise exception 'You cannot take this assignment.' using errcode = '42501';
  end if;

  v_ids := team_lock_record(p_record);
  update record_team_assignments
     set taken_by = v_me, taken_at = now()
   where record_id = p_record and team_id = p_team and taken_by is null;
  if not found then
    raise exception 'Someone on this team has already taken it, or it is no longer assigned.' using errcode = '23505';
  end if;

  if not (v_ids ? v_me::text) then perform team_write_field(p_record, v_ids || to_jsonb(v_me::text)); end if;
  perform team_log(p_record, p_team, true, team_person_name(v_me) || ' took the ' || team_name(p_team) || ' assignment.');
end;
$$;

/* Rule 6: removing the person puts the team back to Open. */
create or replace function unassign_team_member(p_record uuid, p_team uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb;
begin
  if not record_writable(p_record) then raise exception 'not found'; end if;
  perform team_is_real(p_team);
  if not team_perm(auth.uid(), p_team, 'unassign') then
    raise exception 'You cannot unassign members of %.', team_name(p_team) using errcode = '42501';
  end if;

  v_ids := team_lock_record(p_record);
  if not (v_ids ? p_user::text) or user_team(p_user) is distinct from p_team then
    raise exception 'That person is not assigned to this record.' using errcode = '23503';
  end if;
  perform team_write_field(p_record, v_ids - p_user::text);
  perform team_log(p_record, p_team, true, 'Unassigned ' || team_person_name(p_user) || ' from the ' || team_name(p_team) || ' team.');
end;
$$;

/* Rule 6: removing the team takes it off the record entirely, open or taken. */
create or replace function unassign_team(p_record uuid, p_team uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids  jsonb;
  v_next jsonb;
begin
  if not record_writable(p_record) then raise exception 'not found'; end if;
  perform team_is_real(p_team);
  if not team_perm(auth.uid(), p_team, 'unassign') then
    raise exception 'You cannot unassign %.', team_name(p_team) using errcode = '42501';
  end if;

  v_ids := team_lock_record(p_record);
  delete from record_team_assignments where record_id = p_record and team_id = p_team;
  if not found then raise exception '% is not assigned to this record.', team_name(p_team) using errcode = '23503'; end if;

  select coalesce(jsonb_agg(x.id order by x.ord), '[]'::jsonb) into v_next
    from jsonb_array_elements_text(v_ids) with ordinality as x(id, ord)
   where user_team(x.id::uuid) is distinct from p_team;
  if v_next <> v_ids then perform team_write_field(p_record, v_next); end if;
  perform team_log(p_record, p_team, false, 'Unassigned the ' || team_name(p_team) || ' team.');
end;
$$;

-- ── what this viewer may see ─────────────────────────────────────────────────

/* One row per record the viewer can list. A team they may not see is absent,
   and so is any hint that it was there. With the team but not its users, the
   entry has no people and `open` is null: no indication of whether anyone has
   taken it. Someone who may see this team's open records is told it is open,
   because that is what they were shown the record for. */
create or replace function team_assignment_view(p_ids uuid[])
returns table (record_id uuid, locked boolean, writable boolean, teams jsonb)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as id, user_team(auth.uid()) as team, user_perm(auth.uid(), 'action.team_take') = 'yes' as can_take),
  recs as (
    select r.id, coalesce(r.values -> 'team_members_assigned', '[]'::jsonb) as ids, record_writable(r.id) as writable, record_visible(r.id) as visible
      from records r
     where r.id = any(p_ids) and record_listable(r.id)
  ),
  shown as (
    select a.record_id, a.team_id, a.taken_by, pt.position, coalesce(pt.team_label, pt.label) as label,
           user_sees_team_users((select id from me), a.team_id) as sees_users,
           team_perm((select id from me), a.team_id, 'see_open') as sees_open,
           team_perm((select id from me), a.team_id, 'unassign') as can_unassign,
           team_perm((select id from me), a.team_id, 'assign_member') and user_can_assign_team((select id from me), a.team_id) as can_name
      from record_team_assignments a
      join recs on recs.id = a.record_id
      join permission_templates pt on pt.id = a.team_id
     where user_sees_team((select id from me), a.team_id)
  )
  select r.id, not r.visible, r.writable,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'teamId', x.team_id,
                    'label', x.label,
                    'open', case
                              when x.sees_users or x.taken_by = (select id from me) then x.taken_by is null
                              when x.sees_open and x.taken_by is null then true
                              else null
                            end,
                    'people', coalesce((
                                select jsonb_agg(p.id order by (p.id = x.taken_by::text) desc, p.ord)
                                  from jsonb_array_elements_text(r.ids) with ordinality as p(id, ord)
                                 where user_team(p.id::uuid) = x.team_id
                                   and (x.sees_users or p.id = (select id from me)::text)
                              ), '[]'::jsonb),
                    'canTake', x.taken_by is null and (select team from me) = x.team_id and (select can_take from me),
                    'canUnassign', r.writable and x.can_unassign,
                    'canNameMember', r.writable and x.taken_by is null and x.can_name
                  ) order by x.position)
             from shown x
            where x.record_id = r.id
         ), '[]'::jsonb)
    from recs r;
$$;

/* The assign picker. Rule 2: a team this viewer cannot assign is absent, and so
   are its users. Members appear only with "Assign a specific member". */
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

-- ── the write functions: an 'open' viewer reads, it does not work ────────────

-- These check `record_visible` and not a field or tab grant, so the grant caps
-- above do not reach them. Each is rewritten to ask `record_writable`, from its
-- live definition, so nothing else about it changes. reveal_password is a read.
-- teamAssignment.integration.test.ts fails if a later migration undoes one.
do $$
declare
  v_name text;
  v_fn   record;
  v_def  text;
begin
  foreach v_name in array array[
    'add_case_reply', 'add_case_reply_with_mentions', 'add_update_with_mentions', 'clear_pipeline', 'create_case',
    'delete_file', 'delete_note', 'delete_record', 'delete_statement_file', 'delete_update', 'edit_note', 'edit_update',
    'edit_update_with_mentions', 'ensure_case_file_row', 'grant_item_access', 'mention_field', 'record_file_upload',
    'revoke_item_access', 'set_case_solution', 'set_pipeline_step', 'set_record_memberships', 'set_record_value',
    'set_record_values', 'statement_file_upload', 'store_login_password', 'toggle_case_state'
  ] loop
    for v_fn in select oid from pg_proc where proname = v_name and pronamespace = 'public'::regnamespace loop
      v_def := pg_get_functiondef(v_fn.oid);
      -- \m: not `user_record_visible(`, which takes a user and stays as it is.
      if v_def !~ '\mrecord_visible\(' then raise exception '% no longer asks record_visible', v_name; end if;
      execute regexp_replace(v_def, '\mrecord_visible\(', 'record_writable(', 'g');
    end loop;
  end loop;
end $$;

-- ── grants ───────────────────────────────────────────────────────────────────

revoke all on function user_team(uuid) from public, anon, authenticated;
revoke all on function team_name(uuid) from public, anon, authenticated;
revoke all on function team_perm(uuid, uuid, text) from public, anon, authenticated;
revoke all on function user_can_assign_team(uuid, uuid) from public, anon, authenticated;
revoke all on function user_sees_team(uuid, uuid) from public, anon, authenticated;
revoke all on function user_sees_team_users(uuid, uuid) from public, anon, authenticated;
revoke all on function user_open_level(uuid, uuid) from public, anon, authenticated;
revoke all on function user_can_see_record_by_rules(uuid, uuid) from public, anon, authenticated;
revoke all on function team_assignments_reconcile(uuid) from public, anon, authenticated;
revoke all on function team_log(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function team_write_field(uuid, jsonb) from public, anon, authenticated;
revoke all on function team_person_name(uuid) from public, anon, authenticated;
revoke all on function team_lock_record(uuid) from public, anon, authenticated;
revoke all on function team_is_real(uuid) from public, anon, authenticated;
revoke all on function user_templates_reconcile_assignments() from public, anon, authenticated;
revoke all on function records_guard_team_field() from public, anon, authenticated;

-- Named in the RLS policies and the view, so a signed-in viewer needs them.
revoke all on function record_listable(uuid) from public, anon;
grant execute on function record_listable(uuid) to authenticated;
revoke all on function record_writable(uuid) from public, anon;
grant execute on function record_writable(uuid) to authenticated;
revoke all on function viewer_hidden_assignees() from public, anon;
grant execute on function viewer_hidden_assignees() to authenticated;
revoke all on function strip_hidden_assignees(jsonb, text[]) from public, anon;
grant execute on function strip_hidden_assignees(jsonb, text[]) to authenticated;
revoke all on function team_log_visible(uuid, uuid, boolean) from public, anon;
grant execute on function team_log_visible(uuid, uuid, boolean) to authenticated;

revoke all on function assign_team(uuid, uuid) from public, anon;
grant execute on function assign_team(uuid, uuid) to authenticated;
revoke all on function assign_team_member(uuid, uuid, uuid) from public, anon;
grant execute on function assign_team_member(uuid, uuid, uuid) to authenticated;
revoke all on function take_team_assignment(uuid, uuid) from public, anon;
grant execute on function take_team_assignment(uuid, uuid) to authenticated;
revoke all on function unassign_team_member(uuid, uuid, uuid) from public, anon;
grant execute on function unassign_team_member(uuid, uuid, uuid) to authenticated;
revoke all on function unassign_team(uuid, uuid) from public, anon;
grant execute on function unassign_team(uuid, uuid) to authenticated;
revoke all on function team_assignment_view(uuid[]) from public, anon;
grant execute on function team_assignment_view(uuid[]) to authenticated;
revoke all on function team_assign_options() from public, anon;
grant execute on function team_assign_options() to authenticated;

-- ── the records already out there ────────────────────────────────────────────

do $$
declare
  v_rec uuid;
begin
  for v_rec in select distinct record_id from record_team_members loop
    perform team_assignments_reconcile(v_rec);
  end loop;
end $$;
