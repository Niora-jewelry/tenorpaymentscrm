-- =============================================================================
-- UI/UX Redesign spec §5 — Contacts tab and Pricing tab.
--
-- Backed up first: scripts/export-izzy-backup.mjs wrote every value removed
-- here to backups/izzy-2026-10-27/ for Izzy (spec: "Before deleting, export
-- the data being removed and send the file to Izzy as a one-time backup").
--
-- ── CONTACTS ─────────────────────────────────────────────────────────────────
-- 1. The Affiliates section gets a new first member, "Affiliate business name"
--    (Text).
-- 2. Each record's top-line Affiliate business name / main email / main phone
--    is COPIED into the Affiliates section:
--      * no affiliate yet            → affiliate 1 is created from them;
--      * affiliate 1 has room        → its empty business name, email and
--                                      phone are filled, nothing overwritten;
--      * affiliate 1 holds a DIFFERENT email or phone (a person at the
--        affiliate, while "main" is the business's own line) → affiliate 1
--        gets the business name, and a new affiliate is added with the
--        business name, main email and main phone, so neither the old nor the
--        copied value is lost (up to the section's own limit of 5; a record
--        already at 5 stops the migration rather than drop anything).
-- 3. The three top-line fields are then removed with their data (their values,
--    list columns, saved orders, and the one @mention that pointed at one).
-- 4. Merchant address moves to the top of the tab. It is already an Address
--    field, which the drawer now lays out as one full row.
--
-- ── PRICING ──────────────────────────────────────────────────────────────────
-- 5. Processor–TD merchant pricing gets an "Adjustments" section at its end,
--    and the three buy-rate adjustment fields MOVE into it (not copied).
-- =============================================================================

-- 1 ── new first member of the Affiliates section ──────────────────────────────
update fields
   set repeat_schema = jsonb_build_array(jsonb_build_object(
         'key', 'business_name', 'label', 'Affiliate business name', 'type', 'text',
         'sync', false, 'sensitive', false, 'width', 220))
       || repeat_schema
 where key = 'affiliate'
   and not exists (select 1 from jsonb_array_elements(repeat_schema) m where m->>'key' = 'business_name');

-- 2 ── copy the top-line values into the section ───────────────────────────────
do $$
declare
  r        record;
  abn      text;
  ame      text;
  amp      text;
  aff      jsonb;
  first    jsonb;
  clash    boolean;
  added    int := 0;
  merged   int := 0;
  created  int := 0;
  capped   int := 0;
  digits_of constant text := '[^0-9]';
begin
  for r in
    select id, values from records
     where coalesce(btrim(values->>'affiliate_business_name'), '') <> ''
        or coalesce(btrim(values->>'affiliate_main_email'), '') <> ''
        or coalesce(btrim(values->>'affiliate_main_phone'), '') <> ''
  loop
    abn := nullif(btrim(r.values->>'affiliate_business_name'), '');
    ame := nullif(btrim(r.values->>'affiliate_main_email'), '');
    amp := nullif(btrim(r.values->>'affiliate_main_phone'), '');
    aff := case when jsonb_typeof(r.values->'affiliate') = 'array' then r.values->'affiliate' else '[]'::jsonb end;

    if jsonb_array_length(aff) = 0 then
      aff := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('business_name', abn, 'email', ame, 'phone', amp)));
      created := created + 1;
    else
      first := aff->0;
      clash := (ame is not null and coalesce(first->>'email', '') <> '' and lower(first->>'email') <> lower(ame))
            or (amp is not null and coalesce(first->>'phone', '') <> ''
                and regexp_replace(first->>'phone', digits_of, '', 'g') <> regexp_replace(amp, digits_of, '', 'g'));
      if not clash then
        first := first || jsonb_strip_nulls(jsonb_build_object(
          'business_name', coalesce(nullif(first->>'business_name', ''), abn),
          'email',         coalesce(nullif(first->>'email', ''), ame),
          'phone',         coalesce(nullif(first->>'phone', ''), amp)));
        aff := jsonb_set(aff, '{0}', first);
        merged := merged + 1;
      elsif jsonb_array_length(aff) < 5 then
        -- Affiliate 1 is a person at that business: it gets the business name,
        -- and the business's own main line becomes the next affiliate.
        if abn is not null and coalesce(first->>'business_name', '') = '' then
          aff := jsonb_set(aff, '{0}', first || jsonb_build_object('business_name', abn));
        end if;
        aff := aff || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('business_name', abn, 'email', ame, 'phone', amp)));
        added := added + 1;
      else
        capped := capped + 1;
      end if;
    end if;

    update records
       set values = (values - 'affiliate_business_name' - 'affiliate_main_email' - 'affiliate_main_phone')
                    || jsonb_build_object('affiliate', aff)
     where id = r.id;

    insert into record_activity (record_id, actor_id, kind, field_key, summary)
    values (r.id, null, 'field', 'affiliate',
            'Affiliate business name, main email and main phone moved into the Affiliates section');
  end loop;

  if capped > 0 then
    raise exception 'Affiliates section full on % record(s) — values would be lost; nothing changed', capped;
  end if;
  raise notice 'affiliates: % created, % merged into affiliate 1, % added as a new affiliate', created, merged, added;
end
$$;

-- 3 ── remove the three top-line fields ────────────────────────────────────────
-- Any value left on a record that matched none of the conditions above (an
-- empty string) goes too, so no orphaned key survives the field.
update records
   set values = values - 'affiliate_business_name' - 'affiliate_main_email' - 'affiliate_main_phone'
 where values ?| array['affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone'];

delete from notifications
 where field_key::text in ('affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone');
delete from notes
 where scope_kind = 'field'
   and scope_id in ('affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone');
delete from template_grants g using fields f
 where g.scope_kind = 'field' and g.scope_id::text = f.id::text
   and f.key in ('affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone');
delete from user_grants g using fields f
 where g.scope_kind = 'field' and g.scope_id::text = f.id::text
   and f.key in ('affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone');
delete from invite_grants g using fields f
 where g.scope_kind = 'field' and g.scope_id::text = f.id::text
   and f.key in ('affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone');
-- module_columns, user_column_order and user_field_order cascade.
delete from fields
 where key in ('affiliate_business_name', 'affiliate_main_email', 'affiliate_main_phone');

-- 4 ── Merchant address first ──────────────────────────────────────────────────
update fields
   set position = (select coalesce(min(position), 100) - 10 from fields f2
                    where f2.tab_id = fields.tab_id and f2.subtab_id is not distinct from fields.subtab_id)
 where key = 'merchant_address';

-- 5 ── Pricing: the Adjustments section, at the end ────────────────────────────
with tail as (
  select max(f.position) as top
    from fields f
   where f.subtab_id = (select subtab_id from fields where key = 'td_amex_volume_buy_rate_adj')
     and f.key not in ('td_amex_volume_buy_rate_adj', 'td_vmd_volume_buy_rate_adj', 'td_pin_debit_volume_buy_rate_adj')
)
update fields f
   set section  = 'Adjustments',
       position = tail.top + v.step
  from tail,
       (values ('td_amex_volume_buy_rate_adj', 10),
               ('td_vmd_volume_buy_rate_adj', 20),
               ('td_pin_debit_volume_buy_rate_adj', 30)) as v(key, step)
 where f.key = v.key;
