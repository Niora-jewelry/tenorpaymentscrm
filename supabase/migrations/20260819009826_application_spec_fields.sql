-- =============================================================================
-- Prepopulated Application spec — "CRM and application changes".
--
--   Return Policy          the existing "Refund policy" field IS it (decided
--                          2026-10-28): renamed, same key, same data, already
--                          in Applications › General. No second field.
--   Service Model          new, Applications › General, multi-select, the five
--                          options the application asks.
--   Monthly ACH            new, Applications › ACH, number
--   Transactions           ("# of Monthly ACH Transactions").
--
-- Labels follow the tab's sentence case; both stay editable in Presets.
-- =============================================================================

update fields set label = 'Return policy',
                  hint  = coalesce(hint, 'What is your return policy (enter N/A if none)?')
 where key = 'refund_policy';

do $$
declare
  v_tab     uuid := (select id from tabs where key = 'application');
  v_general uuid := (select s.id from subtabs s where s.tab_id = v_tab and s.label = 'General');
  v_ach     uuid := (select s.id from subtabs s where s.tab_id = v_tab and s.label = 'ACH');
begin
  if v_general is null or v_ach is null then
    raise exception 'Applications › General / ACH sub-tabs not found';
  end if;

  if not exists (select 1 from fields where key = 'service_model') then
    perform create_field_with_setup(
      jsonb_build_object(
        'key', 'service_model', 'label', 'Service model', 'type', 'multi_select',
        'tab_id', v_tab, 'subtab_id', v_general,
        'hint', 'Which of the following accurately describes the service model (select all that apply)?'),
      '[{"key":"one_time","value":"One time service"},
        {"key":"recurring","value":"Recurring services"},
        {"key":"extended","value":"Extended services"},
        {"key":"subscriptions","value":"Subscriptions"},
        {"key":"memberships","value":"Memberships"}]'::jsonb,
      (select id from fields where key = 'refund_policy'),
      false, null);
  end if;

  if not exists (select 1 from fields where key = 'ach_monthly_transactions') then
    perform create_field_with_setup(
      jsonb_build_object(
        'key', 'ach_monthly_transactions', 'label', 'Monthly ACH transactions', 'type', 'number',
        'tab_id', v_tab, 'subtab_id', v_ach,
        'hint', '# of monthly ACH transactions'),
      null,
      (select id from fields where key = 'ach_monthly_returns'),
      false, null);
  end if;
end $$;
