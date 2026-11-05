-- =============================================================================
-- Part 9916: Other Costs, Merchant Direct Relationships and Merchant Equipment List go.
--
-- Client, 5 Nov 2026: "Remove other costs, merchant direct relationships and merchant
-- equipment lists - proposal will pull from here instead", "here" being Merchant
-- Equipment Setup (9910, 9911). The proposal's Detailed POS and the agreement's equipment
-- line read that tab in the same change.
--
-- APPLY AFTER THE DEPLOY THAT CARRIES THAT CHANGE, and after
-- scripts/export-equipment-sections-backup.mjs, which keeps each field's old sub-tab.
-- Then reload the configuration (Presets, Reload configuration).
--
-- Fields are archived exactly as Presets' Archive does it, and every value stays on its
-- record: rows were not copied into the new tab, because most of their providers are not
-- on its list and the client has not asked for that.
--
-- A sub-tab cannot be archived, and a field must not point at a deleted one, so the
-- archived fields move to Merchant Equipment Setup first. A field restored in Presets
-- therefore appears there, visibly, rather than nowhere.
--
-- "Include Detailed POS page" stays live and moves with the rows it talks about. It keeps
-- any grant of its own; otherwise it now follows Merchant Equipment Setup's setting.
-- =============================================================================

do $$
declare
  s_new uuid;
  old_subtabs uuid[];
  t_owner uuid;
  in_use text;
begin
  select id, tab_id into s_new, t_owner from subtabs where shows_equipment_setup;
  if s_new is null then
    raise exception 'Merchant Equipment Setup is not there, so nothing can be removed in its favour.';
  end if;

  select array_agg(id) into old_subtabs
    from subtabs
   where tab_id = t_owner and key in ('vendor_to_td', 'other_vendor', 'equipment');
  if old_subtabs is null then
    return; -- already gone
  end if;

  -- An automation hiding or locking one of these would be left pointing at nothing.
  select a.name into in_use
    from automations a
    join automation_versions v on v.id = a.current_version_id
   where exists (select 1 from unnest(old_subtabs) s where v.steps::text like '%' || s::text || '%')
      or exists (select 1 from fields f where f.subtab_id = any (old_subtabs)
                   and (v.steps::text like '%' || f.id::text || '%' or v.steps::text like '%"' || f.key || '"%'))
   order by a.name
   limit 1;
  if in_use is not null then
    raise exception 'The automation "%" uses one of these sections. Change it first.', in_use;
  end if;

  update fields
     set subtab_id = s_new,
         hint = 'Ticked, the proposal lists the rows above that are ticked "Proposal".'
   where key = 'pos_detail_in_proposal';

  update fields set archived_at = now() where subtab_id = any (old_subtabs) and archived_at is null;
  update fields set subtab_id = s_new where subtab_id = any (old_subtabs);

  delete from notes where scope_kind = 'tab' and scope_id in (select t_owner || '/' || s from unnest(old_subtabs) s);
  delete from template_grants where scope_kind = 'subtab' and scope_id = any (old_subtabs);
  delete from user_grants     where scope_kind = 'subtab' and scope_id = any (old_subtabs);
  delete from invite_grants   where scope_kind = 'subtab' and scope_id = any (old_subtabs);
  delete from subtabs where id = any (old_subtabs);
end $$;
