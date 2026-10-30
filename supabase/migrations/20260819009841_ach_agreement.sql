-- =============================================================================
-- The ACH agreement (Maverick ACH Processing Application v1.7) as a second
-- agreement kind, and the CRM fields its sheet asks for:
--
--   · Average ACH transaction amount, Maximum ACH transaction amount
--     (Application › ACH) — the sheet's "New ACH field — add to CRM".
--   · ACH exception/corrections fee (Pricing › Processor-TD Merchant Pricing)
--     for "Exception/Corrections Processing". "FED Unauthorized Return Fee"
--     prints the existing ACH Debit unauthorized fee.
--
-- One agreement may now be out per KIND on a record: a merchant can have the
-- card agreement and the ACH agreement out at the same time.
-- =============================================================================

do $$
declare
  v_app   uuid := (select id from tabs where key = 'application');
  v_ach   uuid := (select id from subtabs where tab_id = v_app and key = 'ach');
  v_price uuid := (select id from tabs where key = 'pricing');
  v_td    uuid := (select id from subtabs where tab_id = v_price and key = 'td_merchant');
begin
  if v_ach is null or v_td is null then raise exception 'Application › ACH or Pricing › TD merchant sub-tab not found'; end if;

  if not exists (select 1 from fields where key = 'ach_avg_transaction') then
    perform create_field_with_setup(
      jsonb_build_object('key', 'ach_avg_transaction', 'label', 'Average ACH transaction amount', 'type', 'currency',
                         'tab_id', v_app, 'subtab_id', v_ach, 'hint', 'Printed on the ACH agreement.'),
      null, (select id from fields where key = 'monthly_ach_volume'), false, null);
  end if;
  if not exists (select 1 from fields where key = 'ach_max_transaction') then
    perform create_field_with_setup(
      jsonb_build_object('key', 'ach_max_transaction', 'label', 'Maximum ACH transaction amount', 'type', 'currency',
                         'tab_id', v_app, 'subtab_id', v_ach, 'hint', 'Printed on the ACH agreement.'),
      null, (select id from fields where key = 'ach_avg_transaction'), false, null);
  end if;
  if not exists (select 1 from fields where key = 'td_ach_exception_fee') then
    perform create_field_with_setup(
      jsonb_build_object('key', 'td_ach_exception_fee', 'label', 'ACH exception/corrections fee', 'type', 'currency',
                         'tab_id', v_price, 'subtab_id', v_td, 'section', 'Acquirer/ACH merchant pricing',
                         'hint', 'Exception/Corrections Processing on the ACH agreement. 0 if blank.'),
      null, (select id from fields where key = 'td_ach_debit_unauthorized_fee'), false, null);
  end if;

  update fields set hint = 'Monthly Maintenance Fee on the ACH agreement. 0 if blank.' where key = 'td_ach_monthly_gateway_fee';
  update fields set hint = 'The ACH processor the merchant uses today, or "No".' where key = 'prior_ach_provider';
end $$;

insert into agreement_kinds (key, label, template_file, position)
values ('maverick_ach', 'Maverick ACH agreement', 'Maverick_ACH_Agreement_v1.7.pdf', 10)
on conflict (key) do nothing;

drop index if exists agreements_one_open;
create unique index if not exists agreements_one_open_per_kind on agreements (record_id, kind)
  where status in ('sending', 'sent', 'viewed', 'partially_signed');
