-- =============================================================================
-- Part 9911: Merchant Equipment Setup — the part people can see.
--
-- APPLY AFTER THE DEPLOY THAT CARRIES THIS FEATURE. A build without it would draw
-- an empty sub-tab and these columns as eleven stray fields. Then reload the
-- configuration (Presets, Reload configuration) so the cached config picks it up.
--
-- A sub-tab of Merchant setup, beside the three it is meant to replace, because
-- that is where those three really are. It takes over Merchant Equipment List's
-- setting: every grant on that sub-tab, for user types, users and invites, is
-- copied to this one. The old sub-tab keeps its own. Nothing old is changed.
-- =============================================================================

insert into subtabs (tab_id, key, label, position, shows_equipment_setup)
select old.tab_id, 'equipment_setup', 'Merchant Equipment Setup',
       (select max(s.position) + 10 from subtabs s where s.tab_id = old.tab_id), true
  from subtabs old
 where old.key = 'equipment'
on conflict (tab_id, key) do nothing;

-- The eleven columns, in the spec's order. `row_column` keeps them out of the
-- generic grid, field lists and pickers; these rows exist for the grant chain.
insert into fields (key, label, type, tab_id, subtab_id, position, is_system, row_column)
select v.key, v.label, v.type::field_type, s.tab_id, s.id, v.position, true, true
  from subtabs s
 cross join (values
   ('eq_provider',     'Provider name', 'dropdown',   10),
   ('eq_billed_by',    'Billed by',     'dropdown',   20),
   ('eq_billed_to',    'Billed to',     'dropdown',   30),
   ('eq_item',         'Item',          'text',       40),
   ('eq_item_amount',  'Item amount',   'number',     50),
   ('eq_monthly_fee',  'Monthly fee',   'currency',   60),
   ('eq_per_item_fee', 'Per item fee',  'currency',   70),
   ('eq_one_time_fee', 'One-time fee',  'currency',   80),
   ('eq_volume_fee',   'Volume fee',    'percentage', 90),
   ('eq_notes',        'Notes',         'long_text',  100),
   ('eq_proposal',     'Proposal',      'checkbox',   110)
 ) as v(key, label, type, position)
 where s.shows_equipment_setup
on conflict (key) do nothing;

-- Shown in the same modules as the old one, after everything else in that module.
insert into module_subtab_order (module_id, subtab_id, position)
select o.module_id, s.id,
       (select max(x.position) + 10 from module_subtab_order x join subtabs xs on xs.id = x.subtab_id
         where x.module_id = o.module_id and xs.tab_id = s.tab_id)
  from module_subtab_order o
  join subtabs old on old.id = o.subtab_id and old.key = 'equipment'
 cross join subtabs s
 where s.shows_equipment_setup
on conflict (module_id, subtab_id) do nothing;

-- "Takes over the current Merchant Equipment List tab setting."
insert into template_grants (template_id, scope_kind, scope_id, grant_level, module_id)
select g.template_id, g.scope_kind, s.id, g.grant_level, g.module_id
  from template_grants g
  join subtabs old on old.id = g.scope_id and old.key = 'equipment'
 cross join subtabs s
 where g.scope_kind = 'subtab' and s.shows_equipment_setup
on conflict do nothing;

insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
select g.user_id, g.scope_kind, s.id, g.grant_level, g.module_id
  from user_grants g
  join subtabs old on old.id = g.scope_id and old.key = 'equipment'
 cross join subtabs s
 where g.scope_kind = 'subtab' and s.shows_equipment_setup
on conflict do nothing;

insert into invite_grants (invite_id, scope_kind, scope_id, grant_level, module_id)
select g.invite_id, g.scope_kind, s.id, g.grant_level, g.module_id
  from invite_grants g
  join subtabs old on old.id = g.scope_id and old.key = 'equipment'
 cross join subtabs s
 where g.scope_kind = 'subtab' and s.shows_equipment_setup
on conflict do nothing;
