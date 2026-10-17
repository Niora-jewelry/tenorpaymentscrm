-- =============================================================================
-- Five Pricing fields asked for by the client, 17 Oct 2026:
--
--   Drawer · Pricing · Processor-TD Merchant Pricing
--     Amex volume buy rate adjustment
--     VMD volume buy rate adjustment
--     Pin debit volume buy rate adjustment
--
--   Drawer · Pricing · One Time Charges
--     Mav gateway setup
--     Mav Equipment
--
-- ── TYPES AND PLACEMENT ──────────────────────────────────────────────────
-- The three adjustments sit directly after the three volume rates they
-- adjust (Amex / VMD / Pin Debit Volume at 850-870), and are percentages
-- like those rates. The two Mav charges are amounts, so currency, placed
-- above the One Time Charges grid (1140) — single values first, the
-- unlimited-row grid last, as on every other subtab.
--
-- ── WHAT THEY ARE NOT WIRED TO ───────────────────────────────────────────
-- Fields are configuration (CLAUDE.md §1): inserting the rows is the whole
-- of "adding a field" — the drawer, the Presets screen, permissions and
-- history all read `fields`. Nothing else is touched:
--   * Not dashboard columns or header-strip fields — not asked for; an admin
--     adds them in Presets if wanted.
--   * Not read by the residuals engine. `residual_sync_rates_from_record`
--     reads a fixed list of 16 td_* keys and these are not among them; how a
--     buy-rate adjustment should enter the calculation is a formula decision
--     that has not been made (handoff/residuals/README.md §6).
--
-- Idempotent: each row is inserted only if its key is not already taken.
-- =============================================================================

insert into fields (key, label, type, tab_id, subtab_id, position, width)
select v.key, v.label, v.type::field_type, t.id, s.id, v.position, v.width
  from (values
    ('td_amex_volume_buy_rate_adj',      'Amex Volume Buy Rate Adjustment',      'percentage', 'td_merchant',      871, 230),
    ('td_vmd_volume_buy_rate_adj',       'VMD Volume Buy Rate Adjustment',       'percentage', 'td_merchant',      872, 220),
    ('td_pin_debit_volume_buy_rate_adj', 'Pin Debit Volume Buy Rate Adjustment', 'percentage', 'td_merchant',      873, 250),
    ('otc_mav_gateway_setup',            'Mav Gateway Setup',                    'currency',   'one_time_charges', 1130, 160),
    ('otc_mav_equipment',                'Mav Equipment',                        'currency',   'one_time_charges', 1135, 150)
  ) as v(key, label, type, subtab_key, position, width)
  join tabs t on t.key = 'pricing'
  join subtabs s on s.key = v.subtab_key and s.tab_id = t.id
 where not exists (select 1 from fields f where f.key = v.key);
