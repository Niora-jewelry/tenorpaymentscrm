-- =============================================================================
-- Pricing: a "TD Charged by Maverick" section, and the TD setup fees
-- =============================================================================
-- Client request, 23 Oct 2026 (Izzy):
--
--   Pricing → Processor-TD Merchant Pricing: "another section underneath the
--   current one but on top of Tab notes, named TD Charged by Maverick", with
--   Gateway provider, Terminal provider, Terminal Monthly, Gateway Monthly,
--   Gateway setup (one time), Terminal setup (one-time), Gateway per item,
--   Terminal per item.
--
--   Pricing → Processor-Vendor Pricing to TD: add Gateway-TD setup fee and
--   Terminal-TD setup fee.
--
-- A section is configuration, not code (CLAUDE.md §1): `fields.section` is a
-- label; the drawer draws every field that carries the same label in its own
-- card under the sub-tab's main grid, in position order. Nothing about
-- permissions, values or history changes — a sectioned field is a field.
--
-- The four "… - Mav" fields that already existed on this sub-tab ARE the
-- Maverick provider/monthly fields the client listed, so they move into the
-- section and lose the suffix (keys unchanged — the residuals sync reads
-- `td_gateway_provider_mav` and friends by key). The two "… Auth Fee - Mav"
-- fields are Maverick charges as well and move with them.
-- =============================================================================

alter table public.fields
  add column if not exists section text
    check (section is null or (length(btrim(section)) between 1 and 80));

comment on column public.fields.section is
  'Optional. Fields sharing a section label are drawn in their own card under the sub-tab''s main grid.';

-- ── TD Charged by Maverick (Processor-TD Merchant Pricing) ───────────────────
update public.fields set section = 'TD Charged by Maverick', label = v.label, position = v.position
  from (values
    ('td_gateway_provider_mav',  'Gateway provider',  950),
    ('td_terminal_provider_mav', 'Terminal provider', 951),
    ('td_terminal_monthly_mav',  'Terminal Monthly',  952),
    ('td_gateway_monthly_mav',   'Gateway Monthly',   953),
    ('td_gateway_auth_fee_mav',  'Gateway auth fee',  958),
    ('td_terminal_auth_fee_mav', 'Terminal auth fee', 959)
  ) as v(key, label, position)
 where fields.key = v.key;

insert into public.fields (key, label, type, tab_id, subtab_id, position, width, section)
select v.key, v.label, v.type::field_type, t.id, s.id, v.position, v.width, v.section
  from (values
    ('td_gateway_setup_mav',     'Gateway setup (one time)',  'currency', 'td_merchant',  954, 190, 'TD Charged by Maverick'),
    ('td_terminal_setup_mav',    'Terminal setup (one-time)', 'currency', 'td_merchant',  955, 190, 'TD Charged by Maverick'),
    ('td_gateway_per_item_mav',  'Gateway per item',          'currency', 'td_merchant',  956, 170, 'TD Charged by Maverick'),
    ('td_terminal_per_item_mav', 'Terminal per item',         'currency', 'td_merchant',  957, 170, 'TD Charged by Maverick'),
    -- ── Processor-Vendor Pricing to TD ──────────────────────────────────────
    ('vtd_gateway_td_setup_fee',  'Gateway-TD setup fee',  'currency', 'vendor_to_td', 1061, 180, null),
    ('vtd_terminal_td_setup_fee', 'Terminal-TD setup fee', 'currency', 'vendor_to_td', 1091, 180, null),
    -- Second list from the same request: more vendors TapDash pays for.
    ('vtd_merchynt_monthly',      'Merchynt monthly',         'currency',   'vendor_to_td', 1140, 170, null),
    ('vtd_tuzo_monthly',          'Tuzo Monthly',             'currency',   'vendor_to_td', 1150, 160, null),
    ('vtd_tuzo_volume',           'Tuzo volume (percentage)', 'percentage', 'vendor_to_td', 1160, 190, null),
    ('vtd_pos_plus_monthly',      'POS+ monthly',             'currency',   'vendor_to_td', 1170, 160, null),
    ('vtd_pos_volume',            'POS volume',               'percentage', 'vendor_to_td', 1180, 160, null),
    ('vtd_support_agent',         'Support agent',            'currency',   'vendor_to_td', 1190, 160, null),
    ('vtd_tapdash_direct',        'TapDash direct',           'currency',   'vendor_to_td', 1200, 160, null)
  ) as v(key, label, type, subtab_key, position, width, section)
  join tabs t on t.key = 'pricing'
  join subtabs s on s.key = v.subtab_key and s.tab_id = t.id
 where not exists (select 1 from fields f where f.key = v.key);
