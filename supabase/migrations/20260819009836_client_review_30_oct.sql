-- =============================================================================
-- Client review of 30 Oct 2026 (Izzy, Shirel): six field and tab changes.
--
-- 1. Bankruptcy gets the agreement's choices — Business bankruptcy / Personal
--    bankruptcy / Never filed — plus a plain "Yes". A record that says "Yes"
--    cannot go on an agreement until someone picks which kind. Values restored
--    from the 28 Oct conversion (9833): the kind it kept as a note goes back
--    into the field, "No" becomes "Never filed", and the note is removed.
--    Backup: backups/izzy-2026-10-30/bankruptcy-before-restore.json.
-- 2. Inventory becomes "select all that apply", with the application's six
--    options. Backup: backups/izzy-2026-10-30/inventory-before-multi-select.json.
--    It also gets an address of its own (for "Off-site — provide address"),
--    the new per-field address, enabled like notes are.
-- 3. The Financial sub-tab goes. Its card-volume fields move to ACQ and the
--    ACH volume to ACH ("remove the tab Financial and move the questions").
-- 4. "Do you issue refunds via ACH?" gets a CRM field on the ACH sub-tab;
--    the application asked it with nowhere to land.
-- 5. ACH BIN becomes a percentage: the ACH agreement prints it as the rate.
--    No record holds a value today (checked), so nothing converts.
-- =============================================================================

-- ── 1. Bankruptcy ─────────────────────────────────────────────────────────────
do $$
declare
  v_field uuid := (select id from fields where key = 'bankruptcy');
  r       record;
  v_new   text;
begin
  if v_field is null then raise exception 'bankruptcy field not found'; end if;

  -- set_field_choices upserts; the 28 Oct "No" goes explicitly.
  delete from field_choices where field_id = v_field and key = 'no';
  perform set_field_choices(v_field, null, '[
    {"key":"business","value":"Business bankruptcy"},
    {"key":"personal","value":"Personal bankruptcy"},
    {"key":"never","value":"Never filed"},
    {"key":"yes","value":"Yes"}]'::jsonb);

  for r in
    select rec.id, rec.values ->> 'bankruptcy' as cur,
           (select n.body from notes n
             where n.record_id = rec.id and n.scope_kind = 'field' and n.scope_id = 'bankruptcy'
               and n.body like 'Before Bankruptcy became Yes / No%' and n.deleted_at is null
             order by n.created_at desc limit 1) as note
      from records rec
     where rec.values ? 'bankruptcy' and jsonb_typeof(rec.values -> 'bankruptcy') = 'string'
  loop
    v_new := case
      when r.cur = 'no' then 'never'
      when r.cur = 'yes' and r.note like '%said: Business.%' then 'business'
      when r.cur = 'yes' and r.note like '%said: Personal.%' then 'personal'
      when r.cur = 'yes' and r.note like '%said: Business and Personal.%' then 'business'
      else r.cur
    end;
    if v_new is distinct from r.cur then
      update records set values = jsonb_set(values, '{bankruptcy}', to_jsonb(v_new)) where id = r.id;
      insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source)
      values (r.id, null, 'field', 'bankruptcy', 'Bankruptcy choices restored to match the agreement',
              r.cur, v_new, 'Bankruptcy choices restored (client decision, 30 Oct 2026)');
    end if;
  end loop;

  -- The 28 Oct note is now redundant: the kind is back in the field.
  delete from notes
   where scope_kind = 'field' and scope_id = 'bankruptcy'
     and body like 'Before Bankruptcy became Yes / No%';

  update fields
     set hint = 'Has the business or any of its principals ever filed bankruptcy? Pick the kind; a plain "Yes" cannot go on an agreement. Details go in the notes.'
   where id = v_field;
end $$;

-- ── 2. Inventory: select all that apply, plus its own address ──────────────────
alter table fields add column if not exists address_enabled boolean not null default false;
comment on column fields.address_enabled is
  'The field carries an address of its own (field_addresses), shown beside its notes — e.g. Inventory "Off-site: provide address".';

do $$
declare
  v_field uuid := (select id from fields where key = 'inventory');
  r       record;
  v_new   jsonb;
begin
  if v_field is null then raise exception 'inventory field not found'; end if;

  for r in
    select id, values ->> 'inventory' as cur from records
     where values ? 'inventory' and jsonb_typeof(values -> 'inventory') = 'string'
  loop
    v_new := case r.cur
      when 'service_only' then '["none"]'::jsonb
      when 'on_site'      then '["on_site"]'::jsonb
      when 'off_site'     then '["off_site"]'::jsonb
      when '3rd_party'    then '["third_party_storage"]'::jsonb
      when 'other'        then '["other"]'::jsonb
      else null
    end;
    if v_new is null then
      update records set values = values - 'inventory' where id = r.id;
    else
      update records set values = jsonb_set(values, '{inventory}', v_new) where id = r.id;
    end if;
    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source)
    values (r.id, null, 'field', 'inventory', 'Inventory became "select all that apply" to match the application',
            r.cur, v_new #>> '{}', 'Inventory became multi-select (client decision, 30 Oct 2026)');
  end loop;

  delete from field_choices where field_id = v_field;
  update fields
     set type = 'multi_select',
         address_enabled = true,
         hint = 'Where is your inventory stored? Select all that apply. Off-site: add the warehouse address with the pin.'
   where id = v_field;
  perform set_field_choices(v_field, null, '[
    {"key":"none","value":"We don''t have any"},
    {"key":"on_site","value":"On-site"},
    {"key":"off_site","value":"Off-site (Warehouse)"},
    {"key":"fulfillment_center","value":"Fulfillment Center"},
    {"key":"third_party_storage","value":"Third Party Storage"},
    {"key":"other","value":"Other"}]'::jsonb);
end $$;

-- The per-field address itself. One per record and field, like a note but a
-- single value. Visibility follows the field: the same grant that shows the
-- field shows its address.
create table if not exists field_addresses (
  record_id   uuid not null references records(id) on delete cascade,
  field_key   citext not null,
  address     jsonb not null,
  updated_by  uuid references profiles(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (record_id, field_key)
);
alter table field_addresses enable row level security;
alter table field_addresses force row level security;
revoke all on field_addresses from anon, authenticated;
grant select on field_addresses to authenticated;
drop policy if exists field_addresses_read on field_addresses;
create policy field_addresses_read on field_addresses for select to authenticated
  using (record_visible(record_id) and record_field_grant(record_id, field_key::text) <> 'hidden');

-- Written through one function so the history row and the value move together
-- (CLAUDE.md §5). Edit on the field is the permission.
create or replace function set_field_address(p_record uuid, p_field_key text, p_address jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb;
  v_text text;
  v_old_text text;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not exists (select 1 from fields f where f.key = p_field_key and f.address_enabled and f.archived_at is null) then
    raise exception 'this field has no address' using errcode = '22023';
  end if;
  if record_field_grant(p_record, p_field_key) <> 'edit' then
    raise exception 'no edit access to this field' using errcode = '42501';
  end if;
  if p_address is not null and jsonb_typeof(p_address) <> 'object' then
    raise exception 'address must be an object' using errcode = '22023';
  end if;

  select address into v_old from field_addresses where record_id = p_record and field_key = p_field_key;

  if p_address is null or p_address = '{}'::jsonb then
    delete from field_addresses where record_id = p_record and field_key = p_field_key;
  else
    insert into field_addresses (record_id, field_key, address, updated_by, updated_at)
    values (p_record, p_field_key, p_address, auth.uid(), now())
    on conflict (record_id, field_key) do update
      set address = excluded.address, updated_by = excluded.updated_by, updated_at = now();
  end if;

  v_text := case when p_address is null or p_address = '{}'::jsonb then null
                 else concat_ws(', ', nullif(p_address->>'street',''), nullif(p_address->>'street2',''),
                                nullif(p_address->>'city',''), nullif(p_address->>'state',''), nullif(p_address->>'zip','')) end;
  v_old_text := case when v_old is null then null
                 else concat_ws(', ', nullif(v_old->>'street',''), nullif(v_old->>'street2',''),
                                nullif(v_old->>'city',''), nullif(v_old->>'state',''), nullif(v_old->>'zip','')) end;
  if v_text is distinct from v_old_text then
    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
    values (p_record, auth.uid(), 'field', p_field_key,
            (select label from fields where key = p_field_key) || ' address changed', v_old_text, v_text);
  end if;
end $$;
revoke execute on function set_field_address(uuid, text, jsonb) from public, anon;
grant execute on function set_field_address(uuid, text, jsonb) to authenticated;

-- ── 3. Financial sub-tab goes; its fields move ─────────────────────────────────
do $$
declare
  v_tab uuid := (select id from tabs where key = 'application');
  v_fin uuid := (select id from subtabs where tab_id = v_tab and key = 'financial');
  v_acq uuid := (select id from subtabs where tab_id = v_tab and key = 'acq');
  v_ach uuid := (select id from subtabs where tab_id = v_tab and key = 'ach');
begin
  if v_fin is null then return; end if;  -- already gone
  if v_acq is null or v_ach is null then raise exception 'Applications › ACQ / ACH sub-tabs not found'; end if;

  -- ACQ: Monthly ACQ volume · Average transaction amount · Maximum transaction
  -- amount · Amex monthly volume, ahead of what ACQ already holds.
  update fields f set subtab_id = v_acq, position = v.pos
    from (values ('monthly_acq_volume', 10), ('avg_transaction', 20), ('max_transaction', 30), ('amex_monthly_volume', 40)) as v(key, pos)
   where f.key = v.key and f.subtab_id = v_fin;
  update fields set position = position + 100 where subtab_id = v_acq and key not in ('monthly_acq_volume','avg_transaction','max_transaction','amex_monthly_volume');

  -- ACH: Monthly ACH volume first.
  update fields set subtab_id = v_ach, position = 0 where key = 'monthly_ach_volume' and subtab_id = v_fin;

  -- Anything else still on Financial (an admin-added field) goes to ACQ at the end.
  update fields set subtab_id = v_acq, position = position + 1000 where subtab_id = v_fin;

  -- Tab notes left on Financial follow the card fields to ACQ.
  update notes set scope_id = v_tab::text || '/' || v_acq::text
   where scope_kind = 'tab' and scope_id = v_tab::text || '/' || v_fin::text;

  delete from template_grants where scope_kind = 'subtab' and scope_id::text = v_fin::text;
  delete from user_grants     where scope_kind = 'subtab' and scope_id::text = v_fin::text;
  delete from invite_grants   where scope_kind = 'subtab' and scope_id::text = v_fin::text;

  -- module_subtab_order and user_field_order cascade.
  delete from subtabs where id = v_fin;

  -- Renumber the survivors: General · ACQ · ACH · Private · Ownership · Prior Processor.
  update subtabs s set position = v.pos
    from (values ('general', 0), ('acq', 10), ('ach', 20), ('private', 30), ('ownership', 40), ('prior', 50)) as v(key, pos)
   where s.tab_id = v_tab and s.key = v.key;
end $$;

-- ── 4. "Do you issue refunds via ACH?" ────────────────────────────────────────
do $$
declare
  v_tab uuid := (select id from tabs where key = 'application');
  v_ach uuid := (select id from subtabs where tab_id = v_tab and key = 'ach');
begin
  if not exists (select 1 from fields where key = 'ach_refunds') then
    perform create_field_with_setup(
      jsonb_build_object(
        'key', 'ach_refunds', 'label', 'ACH refunds', 'type', 'dropdown',
        'tab_id', v_tab, 'subtab_id', v_ach,
        'hint', 'Do you issue refunds via ACH?'),
      '[{"key":"yes","value":"Yes"},{"key":"no","value":"No"}]'::jsonb,
      (select id from fields where key = 'payment_codes'),
      false, null);
  end if;
end $$;

-- ── 5. ACH BIN is a rate ───────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from records where values ? 'td_ach_bin') then
    raise exception 'td_ach_bin holds values; convert them before changing the type';
  end if;
  update fields set type = 'percentage', hint = 'Rate on debit transactions, as printed on the ACH agreement.'
   where key = 'td_ach_bin' and type = 'text';
end $$;
