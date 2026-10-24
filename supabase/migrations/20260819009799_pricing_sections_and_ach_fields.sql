-- =============================================================================
-- Pricing → Processor-TD Merchant Pricing: two named sections, five ACH fields
-- =============================================================================
-- Client request, 24 Oct 2026:
--   Section 1 name — "Acquirer/ACH merchant pricing" (the sub-tab's main grid)
--   Section 2 name — "TD-Mav other buy rate" (was "TD Charged by Maverick")
--   Add to section 1: ACH transaction fee, ACH return, ACH monthly gateway
--   fee, ACH Debit unauthorized fee, ACH BIN.
--
-- Sections are configuration (`fields.section`, migration 9796): the main
-- grid gets its name by giving its fields the label. Keys are unchanged, so
-- every stored value, the residuals sync and saved filters are untouched.
-- =============================================================================

-- Section 2: the new name.
update public.fields f
   set section = 'TD-Mav other buy rate'
  from public.subtabs s
 where s.id = f.subtab_id
   and s.key = 'td_merchant'
   and f.section = 'TD Charged by Maverick';

-- Section 1: everything else on the sub-tab.
update public.fields f
   set section = 'Acquirer/ACH merchant pricing'
  from public.subtabs s
 where s.id = f.subtab_id
   and s.key = 'td_merchant'
   and f.section is null;

-- The ACH fields, at the end of section 1.
insert into public.fields (key, label, type, tab_id, subtab_id, position, width, section)
select v.key, v.label, v.type::field_type, t.id, s.id, v.position, v.width, 'Acquirer/ACH merchant pricing'
  from (values
    ('td_ach_transaction_fee',        'ACH transaction fee',          'currency', 1021, 180),
    ('td_ach_return',                 'ACH return',                   'currency', 1022, 150),
    ('td_ach_monthly_gateway_fee',    'ACH monthly gateway fee',      'currency', 1023, 200),
    ('td_ach_debit_unauthorized_fee', 'ACH Debit unauthorized fee',   'currency', 1024, 220),
    ('td_ach_bin',                    'ACH BIN',                      'text',     1025, 150)
  ) as v(key, label, type, position, width)
  join public.tabs t on t.key = 'pricing'
  join public.subtabs s on s.key = 'td_merchant' and s.tab_id = t.id
 where not exists (select 1 from public.fields f where f.key = v.key);
