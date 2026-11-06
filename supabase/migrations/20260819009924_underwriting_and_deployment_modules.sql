-- Two display modules, Underwriting and Deployment (client, 6 Nov 2026: "two
-- more module types which work like Leads, Deals and Contacts. Underwriting
-- comes after Deals, Deployment comes after Underwriting ... It is the same
-- exact as leads and contacts and deals. It's just another place for a record
-- to display").
--
-- A module is rows, not code (CLAUDE.md rule 1), so this is configuration only.
-- Each new module starts as a copy of Deals, the module it follows:
--
--   * the same tabs and sub-tabs in the same order. Fields belong to tabs, and
--     tabs are shared, so every field is the same field with the same value;
--   * its own Current Status field (`<slug>_current_status`, migration 9922)
--     with a copy of Deals' choices, so a status set in one never shows in
--     another;
--   * its own pipeline, made by `create_pipeline`, which also makes the
--     pipeline's synced Status field exactly as Presets would;
--   * Deals' list columns and header fields, with Deals' own status and
--     pipeline-status fields swapped for the new module's;
--   * Deals' module access for every user type, user and invite that has one,
--     so whoever can open Deals can open these, at the same scope.
--
-- An admin changes any of it in Presets and Permissions afterwards. Nothing
-- here touches a record: a record shows in these modules when someone adds it.

do $$
declare
  deals    modules;
  src      fields;
  v_slug   text;
  v_label  text;
  v_pos    int;
  v_pl     text;
  v_steps  jsonb;
  v_mod    uuid;
  v_status uuid;
  v_pipe   uuid;
  v_pstat  uuid;
  v_dpstat uuid;
  spec     record;
begin
  select * into strict deals from modules where slug = 'deals';
  select * into strict src from fields where key = 'deals_current_status';
  select status_field_id into strict v_dpstat
    from pipelines where module_id = deals.id order by position limit 1;

  for spec in
    select * from (values
      ('underwriting', 'Underwriting', 22, 'Underwriting Pipeline',
       '[{"label":"Submitted","swatch":"slate"},{"label":"In review","swatch":"blue"},
         {"label":"Approved","swatch":"teal"},{"label":"Declined","swatch":"red"}]'::jsonb),
      ('deployment', 'Deployment', 24, 'Deployment Pipeline',
       '[{"label":"Ordered","swatch":"slate"},{"label":"Shipped","swatch":"indigo"},
         {"label":"Installed","swatch":"purple"},{"label":"Live","swatch":"lime"}]'::jsonb)
    ) as s(slug, label, pos, pipeline, steps)
  loop
    v_slug := spec.slug; v_label := spec.label; v_pos := spec.pos; v_pl := spec.pipeline; v_steps := spec.steps;

    if exists (select 1 from modules where slug = v_slug) then
      raise exception 'A module called % already exists.', v_slug;
    end if;

    insert into modules (slug, label, kind, position, admin_only, frozen, shows_open_cases, full_access_only)
    values (v_slug, v_label, 'display', v_pos, deals.admin_only, false, false, deals.full_access_only)
    returning id into v_mod;

    -- Tabs and sub-tabs, in Deals' order.
    insert into module_tab_order (module_id, tab_id, position)
    select v_mod, tab_id, position from module_tab_order where module_id = deals.id;
    insert into module_subtab_order (module_id, subtab_id, position)
    select v_mod, subtab_id, position from module_subtab_order where module_id = deals.id;

    -- Its own Current Status, beside Deals' on the same tab.
    insert into fields (
      key, label, type, tab_id, subtab_id, position, hint, notes_enabled, sync_enabled, is_system,
      read_only, required, sensitive, wide, placeholder, width, grid_columns, section, module_id
    ) values (
      v_slug || '_current_status', src.label, src.type, src.tab_id, src.subtab_id, src.position, src.hint,
      src.notes_enabled, src.sync_enabled, src.is_system, src.read_only, src.required, src.sensitive,
      src.wide, src.placeholder, src.width, src.grid_columns, src.section, v_mod
    ) returning id into v_status;

    insert into field_choices (field_id, module_id, key, value, swatch, position)
    select v_status, v_mod, c.key, c.value, c.swatch, c.position
      from field_choices c where c.field_id = src.id;

    -- Its own pipeline and that pipeline's synced Status field.
    v_pipe := create_pipeline(v_mod, v_pl, v_steps);
    select status_field_id into strict v_pstat from pipelines where id = v_pipe;

    -- Deals' columns and header, with Deals' own fields swapped for these.
    insert into module_columns (module_id, field_id, position, default_visible)
    select v_mod,
           case c.field_id when src.id then v_status when v_dpstat then v_pstat else c.field_id end,
           c.position, c.default_visible
      from module_columns c where c.module_id = deals.id;
    insert into module_header_fields (module_id, field_id, position)
    select v_mod,
           case h.field_id when src.id then v_status when v_dpstat then v_pstat else h.field_id end,
           h.position
      from module_header_fields h where h.module_id = deals.id;

    -- Whoever can open Deals can open this, at the same scope.
    insert into permission_settings (owner_kind, owner_id, key, value)
    select owner_kind, owner_id, 'module:' || v_mod::text, value
      from permission_settings where key = 'module:' || deals.id::text;
    insert into template_grants (template_id, scope_kind, scope_id, grant_level, module_id)
    select template_id, scope_kind, scope_id, grant_level, v_mod from template_grants where module_id = deals.id;
    insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
    select user_id, scope_kind, scope_id, grant_level, v_mod from user_grants where module_id = deals.id;
    insert into invite_grants (invite_id, scope_kind, scope_id, grant_level, module_id)
    select invite_id, scope_kind, scope_id, grant_level, v_mod from invite_grants where module_id = deals.id;
  end loop;
end;
$$;
