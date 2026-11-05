-- Field Highlight Glows (spec, 3 Nov 2026). Which fields each form needs is
-- configuration an admin can change in Presets, not a list in code: the spec's
-- first line asks for required / optional / irrelevant control, and "irrelevant"
-- is 'none' here. Config rows only. No record value moves, nothing is logged.
--
-- The seeded lists were generated from the code, not typed: application from
-- APPLICATION_FIELD_KEYS and applicationPreCheck, agreement from the merchant
-- kind's `required` list and the CRM fields its mapping reads when rendered.
-- The ACH agreement is deliberately left out: the spec says "agreement" means
-- the Maverick merchant agreement.

-- ── 1. What each field is to each form ────────────────────────────────
alter table fields
  add column if not exists application_need text not null default 'none',
  add column if not exists agreement_need text not null default 'none',
  add column if not exists glow_signers_only boolean not null default false,
  add column if not exists agreement_note_need text not null default 'none',
  add column if not exists agreement_note_when jsonb;

do $$ begin
  alter table fields add constraint fields_application_need_check check (application_need in ('required', 'optional', 'none'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table fields add constraint fields_agreement_need_check check (agreement_need in ('required', 'optional', 'none'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table fields add constraint fields_agreement_note_need_check check (agreement_note_need in ('required', 'optional', 'none'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table fields add constraint fields_agreement_note_when_shape check (
    agreement_note_when is null
    or (jsonb_typeof(agreement_note_when) = 'object'
        and (jsonb_typeof(agreement_note_when->'in') = 'array' or jsonb_typeof(agreement_note_when->'not_in') = 'array'))
  );
exception when duplicate_object then null; end $$;

comment on column fields.application_need is 'required / optional / none (irrelevant) for the merchant application. Required blocks Send Application.';
comment on column fields.agreement_need is 'required / optional / none (irrelevant) for the agreement whose kind sets the glow stage. Required blocks Send Agreement.';
comment on column fields.glow_signers_only is 'A repeat group whose rows glow at the agreement stage only for the principals chosen as signers.';
comment on column fields.agreement_note_need is 'What this field''s note is to the agreement, while agreement_note_when holds.';
comment on column fields.agreement_note_when is '{"in":[values]} or {"not_in":[values]}: the note is needed when the field''s value matches. An empty field never matches.';

-- ── 2. The agreement that moves the stage ─────────────────────────────
alter table agreement_kinds add column if not exists sets_glow_stage boolean not null default false;
comment on column agreement_kinds.sets_glow_stage is 'Sending this kind stops the field glows, and fields.agreement_need is its list of required fields.';
update agreement_kinds set sets_glow_stage = (key = 'maverick_merchant');

-- ── 3. The seeded lists ───────────────────────────────────────────────
update fields set application_need = 'optional'
 where application_need = 'none' and key = any(array[
   'legal_business_name', 'dba', 'merchant_address', 'retail_address', 'building_ownership',
   'area_zoned', 'square_footage', 'contact', 'business_founded_date', 'merchant_website',
   'entity_type', 'bankruptcy', 'cc_termination', 'owner_ownership', 'prior_processor',
   'prior_pos', 'monthly_acq_volume', 'monthly_ach_volume', 'avg_transaction',
   'ach_avg_transaction', 'max_transaction', 'ach_max_transaction', 'seasonal', 'sales_method',
   'customer_type', 'customer_profile', 'payment_codes', 'advertising_method', 'refund_policy',
   'inventory', 'charge_to_service', 'order_to_service', 'service_model',
   'ach_monthly_transactions', 'ach_monthly_returns', 'ach_refunds', 'td_ach_return'
  ]);

-- What applicationPreCheck already refuses to send without.
update fields set application_need = 'required'
 where key = any(array['legal_business_name', 'merchant_address', 'owner_ownership']);

-- The SSN is the one application answer that sits in the other owner location.
update fields set application_need = 'optional' where key = 'owner_private' and application_need = 'none';

update fields set agreement_need = 'optional'
 where agreement_need = 'none' and key = any(array[
   'amex_esa', 'dba', 'ebt_fns', 'merchant_direct_relationships', 'merchant_website',
   'owner_ownership', 'owner_private', 'retail_address', 'td_ebt_auth_fee', 'td_ebt_volume',
   'td_gateway_provider_mav', 'td_monthly_fee', 'td_terminal_provider_mav',
   'td_vmd_transaction_fee', 'third_party_shipping', 'vtd_gateway_provider',
   'vtd_terminal_provider'
  ]);

update fields set agreement_need = 'required'
 where key = any(array[
   'legal_business_name', 'mcc_code', 'pricing_model', 'merchant_address', 'business_phone',
   'business_email', 'describe_product_service', 'entity_type', 'business_founded_date',
   'building_type', 'building_ownership', 'area_zoned', 'square_footage', 'bankruptcy',
   'sales_method', 'refund_policy', 'inventory', 'recurring_subscription', 'customer_type',
   'customer_profile', 'charge_to_service', 'order_to_service', 'when_charged',
   'advertising_method', 'seasonal', 'avg_transaction', 'max_transaction',
   'monthly_acq_volume', 'amex_monthly_volume', 'ein', 'routing_number', 'account_number',
   'prior_processor', 'cc_termination', 'td_vmd_volume', 'td_pin_debit_volume',
   'td_amex_volume', 'td_pin_debit_auth_fee', 'td_vmd_auth_fee', 'td_pci_fee', 'td_batch_fee',
   'td_chargeback_fee', 'td_avs_fee'
  ]);

update fields set glow_signers_only = true where key in ('owner_ownership', 'owner_private');

-- Members carry their own needs: each row of a repeat group is several boxes.
-- jsonb_agg with ordinality, so the member order the drawer draws is kept.
update fields f set repeat_schema = (
  select jsonb_agg(
           case
             when m->>'key' in ('first', 'last', 'email') then m || '{"application_need":"required"}'::jsonb
             when m->>'key' in ('title', 'phone', 'percentage') then m || '{"application_need":"optional"}'::jsonb
             else m
           end
           || case when m->>'key' in ('first', 'last', 'email', 'percentage', 'title', 'address', 'phone', 'dob')
                   then '{"agreement_need":"required"}'::jsonb else '{}'::jsonb end
           order by ord)
    from jsonb_array_elements(f.repeat_schema) with ordinality as e(m, ord))
 where f.key = 'owner_ownership';

update fields f set repeat_schema = (
  select jsonb_agg(
           case when m->>'key' = 'ssn' then m || '{"application_need":"optional"}'::jsonb else m end
           || case when m->>'key' in ('ssn', 'dl_number', 'dl_expiry')
                   then '{"agreement_need":"required"}'::jsonb else '{}'::jsonb end
           order by ord)
    from jsonb_array_elements(f.repeat_schema) with ordinality as e(m, ord))
 where f.key = 'owner_private';

-- The application reads the first contact's email and phone.
update fields f set repeat_schema = (
  select jsonb_agg(
           case when m->>'key' in ('email', 'phone') then m || '{"application_need":"optional"}'::jsonb else m end
           order by ord)
    from jsonb_array_elements(f.repeat_schema) with ordinality as e(m, ord))
 where f.key = 'contact';

-- Notes the agreement prints. Bankruptcy's blocks the send (kinds check) for
-- Business or Personal; Yes is on the list because the spec glows it and the
-- check already refuses Yes outright. Seasonal's never blocks (client, 30 Oct
-- 2026: the months are ticked on the form), so it is optional. A months field
-- stores an array, with 'No' for not seasonal.
update fields set agreement_note_need = 'required', agreement_note_when = '{"in":["yes","business","personal"]}'::jsonb
 where key = 'bankruptcy';
update fields set agreement_note_need = 'optional', agreement_note_when = '{"not_in":["No"]}'::jsonb
 where key = 'seasonal';

-- ── 4. New field form: the two settings save with the field ───────────
create or replace function create_field_with_setup(
  p_field          jsonb,
  p_choices        jsonb,
  p_after          uuid,
  p_vital          boolean,
  p_column_modules uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id   uuid;
  v_type field_type := (p_field->>'type')::field_type;
begin
  insert into fields (
    key, label, type, tab_id, subtab_id, position, hint, section,
    required, sensitive, wide, notes_enabled, address_enabled,
    is_system, read_only, sync_enabled, placeholder,
    digits, auto_source, auto_source_field,
    application_need, agreement_need
  ) values (
    p_field->>'key', p_field->>'label', v_type,
    (p_field->>'tab_id')::uuid, nullif(p_field->>'subtab_id', '')::uuid,
    1000000,                                  -- placed properly just below
    nullif(btrim(p_field->>'hint'), ''), nullif(btrim(p_field->>'section'), ''),
    coalesce((p_field->>'required')::boolean, false),
    coalesce((p_field->>'sensitive')::boolean, false),
    false,
    coalesce((p_field->>'notes_enabled')::boolean, false),
    coalesce((p_field->>'address_enabled')::boolean, false),
    false,
    v_type = 'auto',                          -- an auto field is never editable
    false, false,
    case when jsonb_typeof(p_field->'digits') = 'array'
         then array(select (d)::int from jsonb_array_elements_text(p_field->'digits') d) end,
    nullif(p_field->>'auto_source', ''),
    nullif(p_field->>'auto_source_field', ''),
    coalesce(nullif(p_field->>'application_need', ''), 'none'),
    coalesce(nullif(p_field->>'agreement_need', ''), 'none')
  )
  returning id into v_id;

  if jsonb_typeof(p_choices) = 'array' and jsonb_array_length(p_choices) > 0 then
    perform set_field_choices(v_id, null, p_choices);
  end if;

  perform place_field(v_id, p_after);
  perform set_field_surfaces(v_id, coalesce(p_vital, false), p_column_modules);

  -- An auto field on records that already exist: fill it now, not on their
  -- next edit. The fill trigger does the work; this only wakes it.
  if v_type = 'auto' then
    update records set values = values where deleted_at is null;
  end if;

  return v_id;
end;
$fn$;

-- ── 5. The permission: See field highlights ───────────────────────────
create or replace function public.permission_setting_valid(p_key text, p_value text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
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
    when p_key ~ '^reporting\.(tab|acquiring|ach)$'                 then p_value in ('hidden', 'view')
    when p_key ~ '^maverick\.(status|send|update|check|other_cases|sync_case|unmatched_flag|resolve_unmatched|alerts|connection)$'
                                                                    then p_value in ('yes', 'no')
    else false
  end;
$$;

create or replace function public.permission_setting_max(p_key text)
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
    when p_key = 'fields.highlights' then 'yes'
    when p_key like 'reporting.%' then 'view'
    when p_key like 'maverick.%' then 'yes'
    when p_key = 'communication.scope' then 'org'
    when p_key like '%.scope' then 'all'
    when p_key like 'items.%' then 'all'
  end;
$$;

create or replace function public.permission_setting_min(p_key text)
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
    when p_key = 'fields.highlights' then 'no'
    when p_key like 'reporting.%' then 'hidden'
    when p_key like 'maverick.%' then 'no'
    when p_key = 'communication.scope' then 'own'
    when p_key like '%.scope' then 'own'
    when p_key = 'items.cases' then 'hidden'
    when p_key like 'items.%' then 'mine'
  end;
$$;

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
          'action.team_view_open', 'action.team_take', 'action.mark_files_required', 'action.awaiting_client',
          'notifications.scope', 'email.scope', 'phone.scope', 'calendar.scope', 'chat.scope',
          'admin.users', 'admin.permissions', 'admin.presets', 'admin.numbers', 'admin.residuals',
          'admin.integrations', 'admin.automations', 'admin.recycle_bin',
          'communication.scope', 'items.cases', 'items.updates', 'items.notes',
          'applications.pdfs', 'agreements.send', 'fields.highlights',
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
$$;

insert into permission_settings (owner_kind, owner_id, key, value)
select 'template', pt.id, 'fields.highlights', 'yes'
  from permission_templates pt
on conflict (owner_kind, owner_id, key) do nothing;

-- ── 6. The personal switch: it can only hide, never grant ─────────────
create table if not exists user_field_glow_settings (
  user_id    uuid primary key references profiles(id) on delete cascade,
  hidden     boolean not null default false,
  updated_at timestamptz not null default now()
);
comment on table user_field_glow_settings is 'A user hiding glows on their own screen. Without fields.highlights this row changes nothing.';

alter table user_field_glow_settings enable row level security;
alter table user_field_glow_settings force row level security;
revoke all on user_field_glow_settings from anon, authenticated;
grant select, insert, update on user_field_glow_settings to authenticated;

drop policy if exists user_field_glow_settings_select on user_field_glow_settings;
create policy user_field_glow_settings_select on user_field_glow_settings
  for select to authenticated using (user_id = auth.uid());
drop policy if exists user_field_glow_settings_insert on user_field_glow_settings;
create policy user_field_glow_settings_insert on user_field_glow_settings
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists user_field_glow_settings_update on user_field_glow_settings;
create policy user_field_glow_settings_update on user_field_glow_settings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
