-- Merchant Setup › Merchant Pricing: the One-Time section (client, 4 Nov 2026: "In
-- subtab Merchant pricing you're missing section One-time").
--
-- The Field-Tab Review sheet lists the sub-tab's sections as "Acquirer, ACH,
-- Merchant Gateway, Merchant Terminal, One-Time, Adjustments". The two one-time
-- fees that once sat with Gateway and Terminal were removed at the client's
-- request (migration 9899), so the section is a list of rows, the same shape as
-- Other Costs › Other: one row per one-time charge, as many as needed (decided
-- 4 Nov 2026).
--
-- Configuration only: no record data moves.

do $$
declare
  t_pricing uuid := (select id from tabs where key = 'pricing');
  s_td      uuid := (select s.id from subtabs s where s.tab_id = t_pricing and s.key = 'td_merchant');
begin
  if s_td is null then
    raise exception 'Merchant Pricing sub-tab not found.';
  end if;

  insert into fields (key, label, type, tab_id, subtab_id, position, section, wide, hint, grid_columns)
  values ('td_one_time_charges', 'One-time charges', 'grid', t_pricing, s_td, 450, 'One-Time', true,
          'One row per one-time charge: add as many as you need.',
          '[{"label":"Provider","type":"text"},{"label":"Item","type":"text"},{"label":"Amount","type":"currency"},
            {"label":"Paid by","type":"dropdown","options":["Merchant","Tenor"]},{"label":"Date","type":"date"},
            {"label":"Notes","type":"long_text"}]'::jsonb)
  on conflict (key) do nothing;
end $$;
