-- =============================================================================
-- Field-Tab Review and Changes (client sheet, 3 Nov 2026).
--
-- Backed up first, read-only: scripts/export-restructure-backup.mjs wrote every
-- removed value, and the configuration this changes, to
-- backups/restructure-2026-11-03/ for Izzy.
--
-- TABS (sheet "Tabs-Subtabs")
--   Contact        becomes the Contacts sub-tab of Overview. A tab with sub-tabs
--                  shows only its sub-tabs, so Overview's own fields move into
--                  an Overview sub-tab beside it. Grants, tab notes and saved
--                  field orders follow the fields.
--   Pricing        renamed Merchant setup.
--   Marketing      removed, with its four fields and their data.
--   Agreements     removed as a tab: the Send agreement panel moves to Files,
--                  and Agreement becomes a preset Files row.
--   Merchant Equipment List
--                  a sub-tab of Merchant setup, fields and data kept. (The
--                  sub-tab list also says "Merchant Equipment: Remove"; the
--                  non-destructive reading is used until Izzy says otherwise.)
--   Order          Overview, Updates, Applications, Merchant setup,
--                  Communication, Cases, Files, Logins, Statements. Residuals
--                  keeps Merchant setup first, as it was set up for its work.
--
-- SUB-TABS
--   Processor-TD Merchant Pricing  → Merchant Pricing: sections Acquirer, ACH,
--                                    Merchant Gateway, Merchant Terminal,
--                                    Adjustments; the sheet's renames; new ACQ
--                                    Provider, ACH Provider, Merchant Gateway
--                                    Per Update; Monthly website monitoring fee
--                                    moved in from Other Vendor.
--   Processor-Vendor Pricing to TD → Other Costs: sections Gateway, Terminal,
--                                    Other; Gateway/Terminal Billed By added;
--                                    the eleven vendor costs removed; Other is
--                                    a list of rows (Rewards and Other moved in).
--   One Time Charges               → removed, with its fields and data.
--   Other Vendor Merchant Payments → Merchant Direct Relationships: a list of
--                                    rows, one per provider; the old fields'
--                                    values moved in as rows, then removed.
--   Private                        → Protected.
--
-- FIELDS
--   Merchant industry is a plain field again, not filled from the MCC code.
--   Applications › General: Customer type, Customer location and Sales method
--   under a Customer Type section. ACH: ACH refunds and ACH termination above
--   Payment codes. Ownership: Date of birth above Address.
--
-- A list of rows is the `grid` type ("Unlimited rows … similar to the Logins
-- tab"); this adds column types it needs: percentage, number, long_text,
-- checkbox, and dropdown with its options.
-- =============================================================================

do $$
declare
  t_overview   uuid := (select id from tabs where key = 'overview');
  t_contact    uuid := (select id from tabs where key = 'contact');
  t_pricing    uuid := (select id from tabs where key = 'pricing');
  t_marketing  uuid := (select id from tabs where key = 'marketing');
  t_equipment  uuid := (select id from tabs where key = 'equipment');
  t_agreements uuid := (select id from tabs where key = 'agreements');
  t_files      uuid := (select id from tabs where key = 'files');
  t_app        uuid := (select id from tabs where key = 'application');
  s_over       uuid;
  s_contacts   uuid;
  s_equip      uuid;
  s_td         uuid := (select s.id from subtabs s where s.tab_id = t_pricing and s.key = 'td_merchant');
  s_vtd        uuid := (select s.id from subtabs s where s.tab_id = t_pricing and s.key = 'vendor_to_td');
  s_otc        uuid := (select s.id from subtabs s where s.tab_id = t_pricing and s.key = 'one_time_charges');
  s_ovmp       uuid := (select s.id from subtabs s where s.tab_id = t_pricing and s.key = 'other_vendor');
  removed      text[] := array[
    'campaign', 'pitch', 'ad_campaign', 'date_lead_generated',
    'otc_mav_gateway_setup', 'otc_mav_equipment', 'one_time_charges',
    'ovmp_processor_provider', 'ovmp_monthly_pci_fee', 'ovmp_irs_annual_fee',
    'ovmp_gateway_provider', 'ovmp_gateway_monthly_fee', 'ovmp_gateway_auth_fee', 'ovmp_gateway_per_update',
    'ovmp_terminal_provider', 'ovmp_terminal_monthly_fee', 'ovmp_terminal_transaction_fee',
    'ovmp_internet_service_provider', 'ovmp_internet_monthly_cost',
    'ovmp_pos_provider', 'ovmp_pos_monthly_fee', 'ovmp_pos_auth_fee',
    'vtd_rewards_provider', 'vtd_rewards_volume_cost', 'vtd_other_provider', 'vtd_other_monthly_fee',
    'vtd_merchynt_monthly', 'vtd_tuzo_monthly', 'vtd_tuzo_volume', 'vtd_pos_plus_monthly', 'vtd_pos_volume',
    'vtd_support_agent', 'vtd_tapdash_direct'];
  r            record;
  v_rows       jsonb;
begin
  if t_contact is null or t_overview is null or t_pricing is null then
    raise exception 'Field-Tab Review: the tabs it expects are not all here.';
  end if;

  -- ── a sub-tab taking over a tab's grants, notes and saved orders ──────────
  -- (1) grants on the old tab become grants on the new sub-tab; where the old
  --     tab allowed more than the parent tab, the parent is raised and its
  --     other sub-tab keeps the parent's old level, so nobody gains or loses.
  create temporary table _moves (old_tab uuid, new_tab uuid, new_sub uuid, sibling_sub uuid) on commit drop;

  -- ── Overview: two sub-tabs ─────────────────────────────────────────────────
  insert into subtabs (tab_id, key, label, position) values (t_overview, 'overview', 'Overview', 0) returning id into s_over;
  insert into subtabs (tab_id, key, label, position) values (t_overview, 'contacts', 'Contacts', 10) returning id into s_contacts;
  update fields set subtab_id = s_over where tab_id = t_overview and subtab_id is null;
  update fields set tab_id = t_overview, subtab_id = s_contacts where tab_id = t_contact;
  insert into _moves values (t_contact, t_overview, s_contacts, s_over);

  -- ── Merchant Equipment List: a sub-tab of Merchant setup ──────────────────
  if t_equipment is not null then
    insert into subtabs (tab_id, key, label, position) values (t_pricing, 'equipment', 'Merchant Equipment List', 30) returning id into s_equip;
    update fields set tab_id = t_pricing, subtab_id = s_equip where tab_id = t_equipment;
    insert into _moves values (t_equipment, t_pricing, s_equip, null);
  end if;

  for r in select * from _moves loop
    -- Raise the parent tab where the moved tab allowed more, keeping the parent's
    -- own sub-tabs at their old level.
    if r.sibling_sub is not null then
      insert into template_grants (template_id, scope_kind, scope_id, grant_level, module_id)
      select p.template_id, 'subtab', r.sibling_sub, p.grant_level, p.module_id
        from template_grants p join template_grants c
          on c.template_id = p.template_id and c.scope_kind = 'tab' and c.scope_id = r.old_tab and c.module_id is not distinct from p.module_id
       where p.scope_kind = 'tab' and p.scope_id = r.new_tab and c.grant_level > p.grant_level;
    end if;
    update template_grants p set grant_level = c.grant_level
      from template_grants c
     where p.scope_kind = 'tab' and p.scope_id = r.new_tab and c.scope_kind = 'tab' and c.scope_id = r.old_tab
       and c.template_id = p.template_id and c.module_id is not distinct from p.module_id and c.grant_level > p.grant_level;
    update user_grants p set grant_level = c.grant_level
      from user_grants c
     where p.scope_kind = 'tab' and p.scope_id = r.new_tab and c.scope_kind = 'tab' and c.scope_id = r.old_tab
       and c.user_id = p.user_id and c.module_id is not distinct from p.module_id and c.grant_level > p.grant_level;
    update invite_grants p set grant_level = c.grant_level
      from invite_grants c
     where p.scope_kind = 'tab' and p.scope_id = r.new_tab and c.scope_kind = 'tab' and c.scope_id = r.old_tab
       and c.invite_id = p.invite_id and c.module_id is not distinct from p.module_id and c.grant_level > p.grant_level;
    -- The moved tab's grants, as grants on its sub-tab.
    update template_grants set scope_kind = 'subtab', scope_id = r.new_sub where scope_kind = 'tab' and scope_id = r.old_tab;
    update user_grants     set scope_kind = 'subtab', scope_id = r.new_sub where scope_kind = 'tab' and scope_id = r.old_tab;
    update invite_grants   set scope_kind = 'subtab', scope_id = r.new_sub where scope_kind = 'tab' and scope_id = r.old_tab;
    -- Tab notes, and saved field orders.
    update notes set scope_id = r.new_tab || '/' || r.new_sub where scope_kind = 'tab' and scope_id = r.old_tab::text;
    update user_field_order set tab_id = r.new_tab, subtab_id = r.new_sub where tab_id = r.old_tab;
    -- Locks and hides, and automations that name the tab.
    update record_restrictions set item = 'subtab:' || r.new_sub
     where item = 'tab:' || (select key from tabs where id = r.old_tab);
    update automation_versions
       set steps = replace(steps::text, '"tab:' || (select key from tabs where id = r.old_tab) || '"', '"subtab:' || r.new_sub || '"')::jsonb
     where steps::text like '%"tab:' || (select key from tabs where id = r.old_tab) || '"%';
    -- Every module that showed the old tab shows its new home and the sub-tab.
    insert into module_tab_order (module_id, tab_id, position)
    select mto.module_id, r.new_tab, mto.position from module_tab_order mto
     where mto.tab_id = r.old_tab
       and not exists (select 1 from module_tab_order x where x.module_id = mto.module_id and x.tab_id = r.new_tab);
    insert into module_subtab_order (module_id, subtab_id, position)
    select mto.module_id, r.new_sub, (select position from subtabs where id = r.new_sub)
      from module_tab_order mto where mto.tab_id = r.old_tab
    on conflict do nothing;
  end loop;
  -- Overview's own sub-tab, everywhere Overview shows; its tab-level notes and
  -- saved orders now belong to it.
  insert into module_subtab_order (module_id, subtab_id, position)
  select mto.module_id, s_over, 0 from module_tab_order mto where mto.tab_id = t_overview
  on conflict do nothing;
  update notes set scope_id = t_overview || '/' || s_over where scope_kind = 'tab' and scope_id = t_overview::text;
  update user_field_order set subtab_id = s_over where tab_id = t_overview and subtab_id is null;
  -- Equipment joins the Merchant setup sub-tabs wherever they are listed.
  if s_equip is not null then
    insert into module_subtab_order (module_id, subtab_id, position)
    select distinct mso.module_id, s_equip, 30
      from module_subtab_order mso join subtabs s on s.id = mso.subtab_id
     where s.tab_id = t_pricing
    on conflict do nothing;
  end if;

  delete from tabs where id = t_contact;
  if t_equipment is not null then delete from tabs where id = t_equipment; end if;

  -- ── removed fields: values, grants, notes, mentions, then the fields ──────
  -- The lists of rows are filled first, from the fields about to go.
  -- (below, once their fields exist)

  -- ── Agreements: the panel moves to Files ───────────────────────────────────
  if t_agreements is not null then
    update tabs set shows_agreements = true where id = t_files;
    delete from template_grants where scope_kind = 'tab' and scope_id = t_agreements;
    delete from user_grants     where scope_kind = 'tab' and scope_id = t_agreements;
    delete from invite_grants   where scope_kind = 'tab' and scope_id = t_agreements;
    delete from notes where scope_kind = 'tab' and split_part(scope_id, '/', 1) = t_agreements::text;
    delete from tabs where id = t_agreements;
  end if;

  -- ── labels ──────────────────────────────────────────────────────────────────
  update tabs set label = 'Merchant setup' where id = t_pricing;
  update subtabs set label = 'Merchant Pricing',
         description = 'What the merchant pays: acquirer and ACH pricing, the merchant gateway and terminal, and adjustments.'
   where id = s_td;
  update subtabs set label = 'Other Costs',
         description = 'What Tenor pays to run the merchant''s account: gateway, terminal and other providers. The merchant doesn''t pay these.'
   where id = s_vtd;
  update subtabs set label = 'Merchant Direct Relationships', position = 20,
         description = 'Providers the merchant pays directly. Add one row per provider.'
   where id = s_ovmp;
  update subtabs set position = 0 where id = s_td;
  update subtabs set position = 10 where id = s_vtd;
  update module_subtab_order set position = 0  where subtab_id = s_td;
  update module_subtab_order set position = 10 where subtab_id = s_vtd;
  update module_subtab_order set position = 20 where subtab_id = s_ovmp;
  update subtabs set label = 'Protected' where tab_id = t_app and key = 'private';

  -- ── Merchant Pricing: sections, renames, new fields ────────────────────────
  insert into fields (key, label, type, tab_id, subtab_id, position, section)
  values ('acq_provider', 'ACQ Provider', 'text', t_pricing, s_td, 100, 'Acquirer'),
         ('ach_provider', 'ACH Provider', 'text', t_pricing, s_td, 200, 'ACH'),
         ('td_gateway_per_update_mav', 'Merchant Gateway Per Update', 'currency', t_pricing, s_td, 360, 'Merchant Gateway')
  on conflict (key) do nothing;

  update fields f set tab_id = t_pricing, subtab_id = s_td, section = v.section, label = coalesce(v.label, f.label), position = v.pos
    from (values
      ('pricing_risk_level',                  'Acquirer', null::text, 105),
      ('td_amex_auth_fee',                    'Acquirer', null, 110),
      ('td_vmd_auth_fee',                     'Acquirer', null, 115),
      ('td_pin_debit_auth_fee',               'Acquirer', null, 120),
      ('td_amex_volume',                      'Acquirer', null, 125),
      ('td_vmd_volume',                       'Acquirer', null, 130),
      ('td_pin_debit_volume',                 'Acquirer', null, 135),
      ('td_chargeback_fee',                   'Acquirer', null, 140),
      ('td_vmd_transaction_fee',              'Acquirer', null, 145),
      ('td_avs_fee',                          'Acquirer', null, 150),
      ('td_batch_fee',                        'Acquirer', null, 155),
      ('td_monthly_fee',                      'Acquirer', null, 160),
      ('td_ebt_volume',                       'Acquirer', null, 165),
      ('td_amex_template_volume_fee',         'Acquirer', 'Amex Optblue fee', 170),
      ('td_monthly_fee_tapdash',              'Acquirer', 'Monthly Dashboard Fee', 175),
      ('td_lease_payments_tapdash',           'Acquirer', 'Lease payments', 180),
      ('ovmp_monthly_website_monitoring_fee', 'Acquirer', 'Monthly website monitoring fee', 185),
      ('td_pci_fee',                          'Acquirer', null, 190),
      ('td_ebt_auth_fee',                     'Acquirer', null, 195),
      ('td_ach_transaction_fee',              'ACH', null, 205),
      ('td_ach_return',                       'ACH', null, 210),
      ('td_ach_monthly_gateway_fee',          'ACH', null, 215),
      ('td_ach_debit_unauthorized_fee',       'ACH', null, 220),
      ('td_ach_exception_fee',                'ACH', null, 225),
      ('td_ach_bin',                          'ACH', null, 230),
      ('td_gateway_provider_mav',             'Merchant Gateway', 'Merchant Gateway Provider', 300),
      ('td_gateway_monthly_mav',              'Merchant Gateway', 'Merchant Gateway Monthly', 310),
      ('td_gateway_setup_mav',                'Merchant Gateway', 'Merchant Gateway One-time', 320),
      ('td_gateway_per_item_mav',             'Merchant Gateway', 'Merchant Gateway Per Item', 330),
      ('td_gateway_auth_fee_mav',             'Merchant Gateway', 'Merchant Gateway Auth Fee', 340),
      ('td_terminal_provider_mav',            'Merchant Terminal', 'Merchant Terminal Provider', 400),
      ('td_terminal_monthly_mav',             'Merchant Terminal', 'Merchant Terminal Monthly', 410),
      ('td_terminal_setup_mav',               'Merchant Terminal', 'Merchant Terminal One Time', 420),
      ('td_terminal_per_item_mav',            'Merchant Terminal', 'Merchant Terminal Per Item', 430),
      ('td_terminal_auth_fee_mav',            'Merchant Terminal', 'Merchant Terminal Auth Fee', 440),
      ('td_amex_volume_buy_rate_adj',         'Adjustments', null, 500),
      ('td_vmd_volume_buy_rate_adj',          'Adjustments', null, 510),
      ('td_pin_debit_volume_buy_rate_adj',    'Adjustments', null, 520)
    ) as v(key, section, label, pos)
   where f.key = v.key;

  -- ── Other Costs: sections, Billed By, the Other rows ───────────────────────
  insert into fields (key, label, type, tab_id, subtab_id, position, section)
  values ('vtd_gateway_billed_by', 'Gateway Billed By', 'text', t_pricing, s_vtd, 15, 'Gateway'),
         ('vtd_terminal_billed_by', 'Terminal Billed By', 'text', t_pricing, s_vtd, 115, 'Terminal')
  on conflict (key) do nothing;
  insert into fields (key, label, type, tab_id, subtab_id, position, section, wide, hint, grid_columns)
  values ('other_costs', 'Other costs', 'grid', t_pricing, s_vtd, 200, 'Other', true,
          'One row per provider: add as many as you need.',
          '[{"label":"Provider","type":"text"},{"label":"Per item cost","type":"currency"},{"label":"Volume cost","type":"percentage"},
            {"label":"Monthly cost","type":"currency"},{"label":"One-time","type":"currency"},{"label":"Notes","type":"long_text"}]'::jsonb)
  on conflict (key) do nothing;
  update fields f set section = v.section, label = coalesce(v.label, f.label), position = v.pos
    from (values
      ('vtd_gateway_provider',        'Gateway',  null::text, 10),
      ('vtd_gateway_monthly_fee',     'Gateway',  null, 20),
      ('vtd_gateway_auth_fee',        'Gateway',  null, 30),
      ('vtd_gateway_per_update',      'Gateway',  null, 40),
      ('vtd_gateway_td_setup_fee',    'Gateway',  'Gateway One time fee', 50),
      ('vtd_terminal_provider',       'Terminal', null, 110),
      ('vtd_terminal_monthly_fee',    'Terminal', null, 120),
      ('vtd_terminal_transaction_fee','Terminal', null, 130),
      ('vtd_terminal_td_setup_fee',   'Terminal', 'Terminal One-Time Fee', 140)
    ) as v(key, section, label, pos)
   where f.key = v.key;

  -- ── Merchant Direct Relationships: the rows ────────────────────────────────
  insert into fields (key, label, type, tab_id, subtab_id, position, wide, hint, grid_columns)
  values ('merchant_direct_relationships', 'Merchant direct relationships', 'grid', t_pricing, s_ovmp, 10, true,
          'One row per provider the merchant pays directly. Tick "In proposal" for rows the proposal''s Detailed POS page should list.',
          '[{"label":"Provider","type":"text"},{"label":"Provider type","type":"dropdown","options":["Gateway","Terminal","POS"]},
            {"label":"Item","type":"text"},{"label":"Monthly fee","type":"currency"},{"label":"Per item fee","type":"currency"},
            {"label":"One time fee","type":"currency"},{"label":"Volume fee","type":"percentage"},{"label":"Amount","type":"number"},
            {"label":"Notes","type":"long_text"},{"label":"In proposal","type":"checkbox"}]'::jsonb)
  on conflict (key) do nothing;

  -- The old fields' values, moved in as rows before the fields go.
  for r in select id, values v from records where values ?| array[
    'ovmp_processor_provider', 'ovmp_monthly_pci_fee', 'ovmp_irs_annual_fee', 'ovmp_gateway_provider', 'ovmp_gateway_monthly_fee',
    'ovmp_gateway_auth_fee', 'ovmp_gateway_per_update', 'ovmp_terminal_provider', 'ovmp_terminal_monthly_fee', 'ovmp_terminal_transaction_fee',
    'ovmp_internet_service_provider', 'ovmp_internet_monthly_cost', 'ovmp_pos_provider', 'ovmp_pos_monthly_fee', 'ovmp_pos_auth_fee']
  loop
    v_rows := '[]'::jsonb;
    if coalesce(r.v ->> 'ovmp_gateway_provider', '') || coalesce(r.v ->> 'ovmp_gateway_monthly_fee', '') || coalesce(r.v ->> 'ovmp_gateway_auth_fee', '') || coalesce(r.v ->> 'ovmp_gateway_per_update', '') <> '' then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'Provider', r.v ->> 'ovmp_gateway_provider', 'Provider type', 'Gateway', 'Monthly fee', r.v ->> 'ovmp_gateway_monthly_fee',
        'Per item fee', r.v ->> 'ovmp_gateway_auth_fee',
        'Notes', case when coalesce(r.v ->> 'ovmp_gateway_per_update', '') <> '' then 'Per update: ' || (r.v ->> 'ovmp_gateway_per_update') end)));
    end if;
    if coalesce(r.v ->> 'ovmp_terminal_provider', '') || coalesce(r.v ->> 'ovmp_terminal_monthly_fee', '') || coalesce(r.v ->> 'ovmp_terminal_transaction_fee', '') <> '' then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'Provider', r.v ->> 'ovmp_terminal_provider', 'Provider type', 'Terminal', 'Monthly fee', r.v ->> 'ovmp_terminal_monthly_fee',
        'Per item fee', r.v ->> 'ovmp_terminal_transaction_fee')));
    end if;
    if coalesce(r.v ->> 'ovmp_pos_provider', '') || coalesce(r.v ->> 'ovmp_pos_monthly_fee', '') || coalesce(r.v ->> 'ovmp_pos_auth_fee', '') <> '' then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'Provider', r.v ->> 'ovmp_pos_provider', 'Provider type', 'POS', 'Monthly fee', r.v ->> 'ovmp_pos_monthly_fee',
        'Per item fee', r.v ->> 'ovmp_pos_auth_fee')));
    end if;
    if coalesce(r.v ->> 'ovmp_processor_provider', '') || coalesce(r.v ->> 'ovmp_monthly_pci_fee', '') || coalesce(r.v ->> 'ovmp_irs_annual_fee', '') <> '' then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'Provider', r.v ->> 'ovmp_processor_provider', 'Item', 'PCI fee', 'Monthly fee', r.v ->> 'ovmp_monthly_pci_fee',
        'Notes', concat_ws('; ',
          'Processor',
          case when coalesce(r.v ->> 'ovmp_irs_annual_fee', '') <> '' then 'IRS annual fee: ' || (r.v ->> 'ovmp_irs_annual_fee') end))));
    end if;
    if coalesce(r.v ->> 'ovmp_internet_service_provider', '') || coalesce(r.v ->> 'ovmp_internet_monthly_cost', '') <> '' then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'Provider', r.v ->> 'ovmp_internet_service_provider', 'Item', 'Internet service', 'Monthly fee', r.v ->> 'ovmp_internet_monthly_cost')));
    end if;
    if jsonb_array_length(v_rows) > 0 and not (r.v ? 'merchant_direct_relationships') then
      update records set values = jsonb_set(values, '{merchant_direct_relationships}', v_rows) where id = r.id;
    end if;
  end loop;

  for r in select id, values v from records where values ?| array['vtd_rewards_provider', 'vtd_rewards_volume_cost', 'vtd_other_provider', 'vtd_other_monthly_fee']
  loop
    v_rows := '[]'::jsonb;
    if coalesce(r.v ->> 'vtd_rewards_provider', '') || coalesce(r.v ->> 'vtd_rewards_volume_cost', '') <> '' then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'Provider', r.v ->> 'vtd_rewards_provider', 'Volume cost', r.v ->> 'vtd_rewards_volume_cost', 'Notes', 'Rewards')));
    end if;
    if coalesce(r.v ->> 'vtd_other_provider', '') || coalesce(r.v ->> 'vtd_other_monthly_fee', '') <> '' then
      v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'Provider', r.v ->> 'vtd_other_provider', 'Monthly cost', r.v ->> 'vtd_other_monthly_fee')));
    end if;
    if jsonb_array_length(v_rows) > 0 and not (r.v ? 'other_costs') then
      update records set values = jsonb_set(values, '{other_costs}', v_rows) where id = r.id;
    end if;
  end loop;

  -- ── the removed fields go, with their data (backed up) ────────────────────
  delete from notifications where field_key::text = any (removed);
  delete from notes where scope_kind = 'field' and scope_id = any (removed);
  delete from template_grants g using fields f where g.scope_kind = 'field' and g.scope_id = f.id and f.key = any (removed);
  delete from user_grants g     using fields f where g.scope_kind = 'field' and g.scope_id = f.id and f.key = any (removed);
  delete from invite_grants g   using fields f where g.scope_kind = 'field' and g.scope_id = f.id and f.key = any (removed);
  update records set values = values - removed where values ?| removed;
  -- module_columns, module_header_fields, field_choices, user_column_order and
  -- user_field_order cascade.
  delete from fields where key = any (removed);

  -- One Time Charges goes, with its tab notes and its grants.
  if s_otc is not null then
    delete from notes where scope_kind = 'tab' and scope_id = t_pricing || '/' || s_otc;
    delete from template_grants where scope_kind = 'subtab' and scope_id = s_otc;
    delete from user_grants     where scope_kind = 'subtab' and scope_id = s_otc;
    delete from invite_grants   where scope_kind = 'subtab' and scope_id = s_otc;
    delete from subtabs where id = s_otc;
  end if;
  -- The sheet removes the old sub-tab's notes along with its fields.
  delete from notes where scope_kind = 'tab' and scope_id = t_pricing || '/' || s_ovmp;

  -- Marketing goes: its fields are in `removed`; the tab, its notes and grants.
  if t_marketing is not null then
    delete from notes where scope_kind = 'tab' and split_part(scope_id, '/', 1) = t_marketing::text;
    delete from template_grants where scope_kind = 'tab' and scope_id = t_marketing;
    delete from user_grants     where scope_kind = 'tab' and scope_id = t_marketing;
    delete from invite_grants   where scope_kind = 'tab' and scope_id = t_marketing;
    delete from tabs where id = t_marketing;
  end if;

  -- ── Applications ────────────────────────────────────────────────────────────
  update fields set section = 'Customer Type' where key in ('customer_type', 'customer_profile', 'sales_method');
  update fields f set position = v.pos
    from (values ('monthly_ach_volume', 10), ('ach_avg_transaction', 20), ('ach_max_transaction', 30), ('ach_monthly_returns', 40),
                 ('ach_monthly_transactions', 50), ('ach_credits_required', 60), ('ach_refunds', 70), ('ach_termination', 80),
                 ('payment_codes', 90)) as v(key, pos)
   where f.key = v.key;
  -- Date of birth above Address.
  update fields
     set repeat_schema = (
       select jsonb_agg(m order by case m ->> 'key' when 'dob' then (select ord from jsonb_array_elements(repeat_schema) with ordinality a(x, ord) where x ->> 'key' = 'address') - 0.5
                                                    else o end)
         from jsonb_array_elements(repeat_schema) with ordinality e(m, o))
   where key = 'owner_ownership'
     and exists (select 1 from jsonb_array_elements(repeat_schema) x where x ->> 'key' = 'dob')
     and exists (select 1 from jsonb_array_elements(repeat_schema) x where x ->> 'key' = 'address');

  -- Merchant industry: typed, not looked up.
  update fields set type = 'text', auto_source = null, auto_source_field = null, read_only = false,
         hint = nullif(hint, 'Filled in from the MCC code.')
   where key = 'merchant_industry';

  -- ── tab order ───────────────────────────────────────────────────────────────
  update tabs t set position = v.pos
    from (values ('overview', 0), ('updates', 10), ('application', 20), ('pricing', 30), ('communication', 40),
                 ('cases', 50), ('files', 60), ('logins', 70), ('statements', 80), ('residual_figures', 90)) as v(key, pos)
   where t.key = v.key;
  update module_tab_order mto set position = v.pos
    from tabs t, modules m,
         (values ('overview', 0), ('updates', 10), ('application', 20), ('pricing', 30), ('communication', 40),
                 ('cases', 50), ('files', 60), ('logins', 70), ('statements', 80), ('residual_figures', 90)) as v(key, pos)
   where t.id = mto.tab_id and t.key = v.key and m.id = mto.module_id and m.slug <> 'residuals';
end $$;

-- ── Agreement: a preset Files row ─────────────────────────────────────────────
do $$
declare
  v_def text;
  v_fn  text;
begin
  foreach v_fn in array array['public.automation_mark_file_required(automation_runs,jsonb)', 'public.automation_resolve_items(uuid,jsonb)'] loop
    begin
      v_def := pg_get_functiondef(v_fn::regprocedure);
    exception when undefined_function then
      continue;
    end;
    if position('''Voided check''], array[0, 10, 20, 30, 40]' in v_def) > 0 then
      execute replace(v_def, '''Voided check''], array[0, 10, 20, 30, 40]', '''Voided check'', ''Agreement''], array[0, 10, 20, 30, 40, 50]');
    elsif position('''Voided check''];' in v_def) > 0 then
      execute replace(replace(v_def, '''Voided check''];', '''Voided check'', ''Agreement''];'),
                      'array[0, 10, 20, 30, 40]', 'array[0, 10, 20, 30, 40, 50]');
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
