-- =============================================================================
-- UI/UX Redesign spec §2 — the drawer header.
--
-- 1. Vital Info. The header strip becomes a titled "Vital Info" section with a
--    fixed proposed set, in this order, in every module:
--
--       Current Status · Risk Level · Team member(s) assigned · Relationship manager
--       Pricing Model  · MID        · MCC code                · (left empty)
--
--    It stays configurable per module in Admin → Presets (the header editor),
--    so this only sets the starting point. Legal business name (which restated
--    the drawer title), Affiliate business name and the lead dates leave the
--    header; they are still on their tabs.
--
-- 2. "Account Health" → "Pipeline". The spec: "Pipeline and Account Health are
--    the same thing, so this is a label change only." Renaming the pipeline
--    row is the whole change — the stepper heading, the list-view pipeline
--    filter and Admin → Presets all read `pipelines.label`, and the
--    `pipelines_sync_status_label` trigger re-labels the pipeline's synced
--    status field ("Pipeline Status") and rewrites its hint. Activity entries
--    already read "Pipeline step changed"; no stored text names Account Health.
-- =============================================================================

-- 1 ── Vital Info ──────────────────────────────────────────────────────────────
delete from module_header_fields;

insert into module_header_fields (module_id, field_id, position)
select m.id, f.id, v.pos
  from modules m
 cross join (values
   ('current_status',        10),
   ('pricing_risk_level',    20),
   ('team_members_assigned', 30),
   ('relationship_manager',  40),
   ('pricing_model',         50),
   ('mid',                   60),
   ('mcc_code',              70)
 ) as v(key, pos)
  join fields f on f.key = v.key and f.archived_at is null;

-- 2 ── Account Health → Pipeline ────────────────────────────────────────────────
update pipelines set label = 'Pipeline' where label = 'Account Health';
