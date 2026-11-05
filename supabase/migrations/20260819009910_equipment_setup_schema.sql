-- =============================================================================
-- Part 9910: Merchant Equipment Setup (spec, 3 Nov 2026) — the schema half.
--
-- Rows of "who the provider is, who bills for it, who pays, and what the fees
-- are", on one sub-tab of a record, working like Files: added one at a time,
-- nothing preset, removed softly to the Recycle Bin.
--
-- ── WHY TWO MIGRATIONS ───────────────────────────────────────────────────────
-- A migration here is live before its code is deployed. This one adds nothing the
-- deployed code can see. 9911, applied after the deploy, seeds the sub-tab and its
-- columns, because a build without this feature would draw them as an empty
-- sub-tab and eleven stray fields in the generic grid.
--
-- ── NOTHING OLD IS TOUCHED ───────────────────────────────────────────────────
-- Merchant Equipment List, Other Costs and Merchant Direct Relationships, and all
-- their data, stay exactly as they are. The Maverick agreement still fills itself
-- from Other Costs and Merchant Direct Relationships, and the spec says not to resolve
-- a conflict quietly. Old and new sit
-- side by side until the client answers.
--
-- ── WHY THE COLUMNS ARE `fields` ROWS (9911) ─────────────────────────────────
-- The spec lets an admin override one column for a user type or one user. That is
-- the grant chain's field level, and it needs a field to hang the grant on. The
-- values do not live in records.values: `row_column` keeps these rows out of every
-- list that assumes they do.
--
-- ── NO VALUES IN THE LOG ─────────────────────────────────────────────────────
-- Updates and history say who changed which column on which row, never to what.
-- A column's name is shown only to someone who can see that column (the `field:`
-- item on each detail); everyone else reads "Changed equipment row 3."
-- =============================================================================

alter type activity_kind add value if not exists 'equipment';

alter table subtabs add column if not exists shows_equipment_setup boolean not null default false;
comment on column subtabs.shows_equipment_setup is
  'This sub-tab shows the equipment rows, in the Files layout, in place of the field grid.';

alter table fields add column if not exists row_column boolean not null default false;
comment on column fields.row_column is
  'A column of a row-based sub-tab: here so the grant chain can reach it. Its value is not in records.values, so every list of ordinary fields leaves it out.';

-- ── the shared provider list ─────────────────────────────────────────────────
create table if not exists equipment_providers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  is_preset   boolean not null default false,
  position    int not null default 1000,
  created_by  uuid references profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);
-- "A custom name cannot duplicate a preset or an existing custom name, ignoring
-- upper and lower case": a rule that must never break, so the database holds it.
create unique index if not exists equipment_providers_name_unique on equipment_providers (lower(name));

insert into equipment_providers (name, is_preset, position)
select v.name, true, v.position
  from (values
    ('Accept.blue', 10), ('Authorize.net', 20), ('NMI', 30), ('Maverick', 40), ('Tenor', 50),
    ('Deja Voo', 60), ('IPOS', 70), ('Deja Pro', 80), ('Valor', 90), ('UsaEpay', 100)
  ) as v(name, position)
on conflict (lower(name)) do nothing;

-- ── the rows ─────────────────────────────────────────────────────────────────
create table if not exists equipment_rows (
  id            uuid primary key default gen_random_uuid(),
  record_id     uuid not null references records (id) on delete cascade,
  -- Names this row in the log. Never reused, so "row 3" means one row for ever.
  row_no        int not null,
  provider_id   uuid references equipment_providers (id),
  -- A choice, never a copied name, so it cannot go on naming an old provider.
  billed_by     text check (billed_by in ('tenor', 'provider')),
  billed_to     text check (billed_to in ('merchant', 'iso')),
  item          text check (item is null or char_length(item) <= 200),
  item_amount   int check (item_amount is null or item_amount >= 0),
  -- Blank stays NULL and is never saved as 0 (spec). No defaults on purpose.
  monthly_fee   numeric(12, 2) check (monthly_fee is null or monthly_fee >= 0),
  per_item_fee  numeric(12, 2) check (per_item_fee is null or per_item_fee >= 0),
  one_time_fee  numeric(12, 2) check (one_time_fee is null or one_time_fee >= 0),
  volume_fee    numeric(7, 4) check (volume_fee is null or volume_fee between 0 and 100),
  notes         text check (notes is null or char_length(notes) <= 2000),
  proposal      boolean not null default false,
  created_by    uuid references profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid references profiles (id) on delete set null,
  constraint equipment_rows_number_unique unique (record_id, row_no),
  constraint equipment_rows_billed_by_needs_provider check (billed_by is distinct from 'provider' or provider_id is not null)
);
create index if not exists equipment_rows_record on equipment_rows (record_id, row_no) where deleted_at is null;
create index if not exists equipment_rows_bin on equipment_rows (deleted_at desc) where deleted_at is not null;

-- Default-deny. Everything goes through the gate and these functions.
alter table equipment_providers enable row level security;
alter table equipment_providers force row level security;
alter table equipment_rows enable row level security;
alter table equipment_rows force row level security;
revoke all on equipment_providers from public, anon, authenticated;
revoke all on equipment_rows from public, anon, authenticated;

-- ── writes: the value and its history in one transaction ─────────────────────
create or replace function equipment_row_add(p_record uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_no int;
  v_id uuid;
begin
  -- Two people adding at once must not take one number.
  perform pg_advisory_xact_lock(hashtextextended('equipment_rows:' || p_record::text, 0));
  if (select count(*) from equipment_rows where record_id = p_record and deleted_at is null) >= 200 then
    raise exception 'This record already has 200 equipment rows.' using errcode = 'P0001';
  end if;
  select coalesce(max(row_no), 0) + 1 into v_no from equipment_rows where record_id = p_record;
  insert into equipment_rows (record_id, row_no, created_by) values (p_record, v_no, p_actor) returning id into v_id;
  perform record_log(p_record, p_actor, 'equipment'::activity_kind, format('Added equipment row %s.', v_no));
  return v_id;
end $$;

/*
 * Changes the columns named in p_changes. A key absent is left alone; a key present
 * and null clears it.
 *
 * Changing the provider clears Billed by, whatever it held (spec), so it can never
 * go on pointing at the old provider. A Billed by sent in the same call is applied
 * after that.
 *
 * The provider ranks highest so that it is the line history keeps when one save
 * changes two columns: record_log's activity row takes the top detail.
 */
create or replace function equipment_row_update(p_row uuid, p_actor uuid, p_changes jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r equipment_rows;
  n equipment_rows;
  v_details jsonb := '[]'::jsonb;
  c record;
begin
  select * into r from equipment_rows where id = p_row and deleted_at is null for update;
  if not found then raise exception 'That row no longer exists.' using errcode = 'P0002'; end if;
  n := r;
  if p_changes ? 'provider_id' then n.provider_id := nullif(p_changes ->> 'provider_id', '')::uuid; end if;
  if n.provider_id is distinct from r.provider_id then n.billed_by := null; end if;
  if p_changes ? 'billed_by' then n.billed_by := nullif(p_changes ->> 'billed_by', ''); end if;
  if p_changes ? 'billed_to' then n.billed_to := nullif(p_changes ->> 'billed_to', ''); end if;
  if p_changes ? 'item' then n.item := nullif(p_changes ->> 'item', ''); end if;
  if p_changes ? 'item_amount' then n.item_amount := (p_changes ->> 'item_amount')::int; end if;
  if p_changes ? 'monthly_fee' then n.monthly_fee := (p_changes ->> 'monthly_fee')::numeric; end if;
  if p_changes ? 'per_item_fee' then n.per_item_fee := (p_changes ->> 'per_item_fee')::numeric; end if;
  if p_changes ? 'one_time_fee' then n.one_time_fee := (p_changes ->> 'one_time_fee')::numeric; end if;
  if p_changes ? 'volume_fee' then n.volume_fee := (p_changes ->> 'volume_fee')::numeric; end if;
  if p_changes ? 'notes' then n.notes := nullif(p_changes ->> 'notes', ''); end if;
  if p_changes ? 'proposal' then n.proposal := coalesce((p_changes ->> 'proposal')::boolean, false); end if;

  for c in
    select * from (values
      ('provider_id', 'eq_provider', 11), ('billed_by', 'eq_billed_by', 10), ('billed_to', 'eq_billed_to', 9),
      ('item', 'eq_item', 8), ('item_amount', 'eq_item_amount', 7), ('monthly_fee', 'eq_monthly_fee', 6),
      ('per_item_fee', 'eq_per_item_fee', 5), ('one_time_fee', 'eq_one_time_fee', 4), ('volume_fee', 'eq_volume_fee', 3),
      ('notes', 'eq_notes', 2), ('proposal', 'eq_proposal', 1)
    ) as v(column_key, field_key, rank)
  loop
    -- As jsonb, so 12.5 and 12.50 are one number and a re-save logs nothing.
    if (to_jsonb(r) -> c.column_key) is distinct from (to_jsonb(n) -> c.column_key) then
      v_details := v_details || jsonb_build_object('rank', c.rank, 'items', jsonb_build_array('field:' || c.field_key),
        'body', format('Changed %s on equipment row %s.',
          coalesce((select label from fields where key::text = c.field_key), c.field_key), r.row_no));
    end if;
  end loop;

  if v_details = '[]'::jsonb then return; end if; -- nothing really changed, nothing to log

  update equipment_rows set
    provider_id = n.provider_id, billed_by = n.billed_by, billed_to = n.billed_to, item = n.item,
    item_amount = n.item_amount, monthly_fee = n.monthly_fee, per_item_fee = n.per_item_fee,
    one_time_fee = n.one_time_fee, volume_fee = n.volume_fee, notes = n.notes, proposal = n.proposal,
    updated_at = now()
   where id = p_row;

  perform record_log(r.record_id, p_actor, 'equipment'::activity_kind, format('Changed equipment row %s.', r.row_no), v_details);
end $$;

create or replace function equipment_row_delete(p_row uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r equipment_rows;
begin
  select * into r from equipment_rows where id = p_row and deleted_at is null for update;
  if not found then raise exception 'That row no longer exists.' using errcode = 'P0002'; end if;
  update equipment_rows set deleted_at = now(), deleted_by = p_actor, updated_at = now() where id = p_row;
  perform record_log(r.record_id, p_actor, 'equipment'::activity_kind, format('Removed equipment row %s.', r.row_no));
end $$;

/* Added from a record, so that record's history says who added it and when. The name
   is shown only to someone who can see the provider column. */
create or replace function equipment_provider_add(p_name text, p_record uuid, p_actor uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  insert into equipment_providers (name, created_by) values (p_name, p_actor) returning id into v_id;
  perform record_log(p_record, p_actor, 'equipment'::activity_kind, 'Added a custom provider.',
    jsonb_build_array(jsonb_build_object('rank', 1, 'items', jsonb_build_array('field:eq_provider'),
      'body', format('Added custom provider %s.', p_name))));
  return v_id;
end $$;

revoke all on function equipment_row_add(uuid, uuid) from public, anon, authenticated;
revoke all on function equipment_row_update(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function equipment_row_delete(uuid, uuid) from public, anon, authenticated;
revoke all on function equipment_provider_add(text, uuid, uuid) from public, anon, authenticated;
grant execute on function equipment_row_add(uuid, uuid) to service_role;
grant execute on function equipment_row_update(uuid, uuid, jsonb) to service_role;
grant execute on function equipment_row_delete(uuid, uuid) to service_role;
grant execute on function equipment_provider_add(text, uuid, uuid) to service_role;

/* The Recycle Bin's button, called as the admin, like restore_file_row. */
create or replace function restore_equipment_row(p_row_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r equipment_rows;
begin
  if not auth_admin_page('recycle_bin') then
    raise exception 'Only an admin may restore from the Recycle Bin' using errcode = '42501';
  end if;
  select * into r from equipment_rows where id = p_row_id and deleted_at is not null for update;
  if not found then raise exception 'not found'; end if;
  update equipment_rows set deleted_at = null, deleted_by = null, updated_at = now() where id = p_row_id;
  perform record_log(r.record_id, auth.uid(), 'equipment'::activity_kind, format('Restored equipment row %s.', r.row_no));
end $$;
revoke all on function restore_equipment_row(uuid) from public, anon;
grant execute on function restore_equipment_row(uuid) to authenticated;

-- ── the permission: Add custom providers ─────────────────────────────────────
-- These four definitions are copied whole from the live database, which already
-- carries 9909's `fields.highlights`. So this file must sort and apply after 9909.
CREATE OR REPLACE FUNCTION public.permission_setting_valid(p_key text, p_value text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when p_key ~ '^action\.(create|team|archive|modules|pipeline|pipeline_change|team_view_open|team_take|mark_files_required|awaiting_client)$' then p_value in ('yes', 'no')
    when p_key ~ '^team\.[a-z_]+\.(assign|assign_member|unassign|see_open|see_team|see_users)$' then p_value in ('yes', 'no')
    when p_key ~ '^module:[0-9a-f-]{36}$'                          then p_value in ('hidden', 'mine', 'all')
    when p_key in ('notifications.scope', 'email.scope', 'phone.scope', 'calendar.scope', 'chat.scope') then p_value in ('own', 'all')
    when p_key = 'admin.automations'                                then p_value in ('hidden', 'view', 'full')
    when p_key ~ '^admin\.(users|permissions|presets|numbers|residuals|integrations|recycle_bin)$'
                                                                    then p_value in ('hidden', 'full')
    when p_key = 'communication.scope'                              then p_value in ('own', 'org')
    when p_key = 'items.cases'                                      then p_value in ('hidden', 'mine', 'all')
    when p_key in ('items.updates', 'items.notes')                  then p_value in ('mine', 'all')
    when p_key = 'applications.pdfs'                                then p_value in ('hidden', 'full')
    when p_key = 'agreements.send'                                  then p_value in ('yes', 'no')
    when p_key = 'fields.highlights'                                then p_value in ('yes', 'no')
    when p_key = 'equipment.add_providers'                          then p_value in ('yes', 'no')
    when p_key ~ '^reporting\.(tab|acquiring|ach)$'                 then p_value in ('hidden', 'view')
    when p_key ~ '^maverick\.(status|send|update|check|other_cases|sync_case|unmatched_flag|resolve_unmatched|alerts|connection)$'
                                                                    then p_value in ('yes', 'no')
    else false
  end;
$function$;

CREATE OR REPLACE FUNCTION public.permission_setting_max(p_key text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when p_key like 'action.%' then 'yes'
    when p_key like 'team.%' then 'yes'
    when p_key like 'module:%' then 'all'
    when p_key like 'admin.%' then 'full'
    when p_key = 'applications.pdfs' then 'full'
    when p_key = 'agreements.send' then 'yes'
    when p_key = 'fields.highlights' then 'yes'
    when p_key = 'equipment.add_providers' then 'yes'
    when p_key like 'reporting.%' then 'view'
    when p_key like 'maverick.%' then 'yes'
    when p_key = 'communication.scope' then 'org'
    when p_key like '%.scope' then 'all'
    when p_key like 'items.%' then 'all'
  end;
$function$;

CREATE OR REPLACE FUNCTION public.permission_setting_min(p_key text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select case
    when p_key like 'action.%' then 'no'
    when p_key like 'team.%' then 'no'
    when p_key like 'module:%' then 'hidden'
    when p_key like 'admin.%' then 'hidden'
    when p_key = 'applications.pdfs' then 'hidden'
    when p_key = 'agreements.send' then 'no'
    when p_key = 'fields.highlights' then 'no'
    when p_key = 'equipment.add_providers' then 'no'
    when p_key like 'reporting.%' then 'hidden'
    when p_key like 'maverick.%' then 'no'
    when p_key = 'communication.scope' then 'own'
    when p_key like '%.scope' then 'own'
    when p_key = 'items.cases' then 'hidden'
    when p_key like 'items.%' then 'mine'
  end;
$function$;

CREATE OR REPLACE FUNCTION public.user_permissions(u uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'superAdmin', user_is_admin(u),
    'userType', (select pt.user_type from user_templates ut join permission_templates pt on pt.id = ut.template_id where ut.user_id = u),
    'settings', (
      select jsonb_object_agg(k, user_perm(u, k))
        from unnest(array[
          'action.create', 'action.team', 'action.archive', 'action.modules', 'action.pipeline', 'action.pipeline_change',
          'action.team_view_open', 'action.team_take', 'action.mark_files_required', 'action.awaiting_client',
          'notifications.scope', 'email.scope', 'phone.scope', 'calendar.scope', 'chat.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes',
          'applications.pdfs', 'agreements.send', 'fields.highlights', 'equipment.add_providers',
          'reporting.tab', 'reporting.acquiring', 'reporting.ach',
          'maverick.status', 'maverick.send', 'maverick.update', 'maverick.check', 'maverick.other_cases',
          'maverick.sync_case', 'maverick.unmatched_flag', 'maverick.resolve_unmatched', 'maverick.alerts', 'maverick.connection'
        ] || array(
          select 'team.' || pt.user_type || '.' || s
            from permission_templates pt
           cross join unnest(array['assign', 'assign_member', 'unassign', 'see_open', 'see_team', 'see_users']) s
           where pt.user_type is not null
        )) as k
    ),
    'modules', (select coalesce(jsonb_object_agg(m.id::text, user_module_scope(u, m.id)), '{}'::jsonb) from modules m)
  );
$function$;

insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'equipment.add_providers',
       case when pt.user_type in ('super_admin', 'admin') then 'yes' else 'no' end
  from permission_templates pt
on conflict (owner_kind, owner_id, key) do nothing;
