-- =============================================================================
-- Part 63: give the drawer's header fields a real, stable order.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────
-- Every row seeded into `module_header_fields` carries `position = 0`. Both
-- readers sort by it — `loadConfig` orders the query, `headerFieldsForModule`
-- sorts again — and neither does anything useful under a total tie, so the
-- order of the strip is whatever Postgres happens to return.
--
-- It looked deliberate only because that matched insert order. Any UPDATE,
-- VACUUM FULL or parallel scan reshuffles the entire header of every record in
-- the CRM, with no code change and nothing to point at. `module_columns` in the
-- same seed carries distinct positions, and the admin writer assigns real ones
-- (`set_module_header_fields` uses `(ord - 1) * 10`); only the seed was flat.
--
-- ── WHY IT MATTERS MORE NOW ──────────────────────────────────────────────
-- The strip used to be a wrapping run of text where order barely registered. It
-- is now an aligned grid, which makes the sequence the first thing a reader
-- perceives — so an arbitrary one is newly conspicuous.
--
-- ── THE ORDER, AND WHY THIS ONE ──────────────────────────────────────────
-- Identity first, then who owns it, then where it stands, then the money, then
-- the dates, then the reference codes. That is the order the questions are
-- actually asked in: what is this, whose is it, how far along, how big, when
-- last touched, and what is its number.
--
-- Positions step by 10, matching every other ordering table here, so an admin
-- can drop a field between two without a renumber.
--
-- ⚠️ Applied ONLY where the whole module is still flat. An admin who has
-- already arranged their own header order has expressed an editorial
-- preference, and a migration must not overwrite it.
-- =============================================================================

with desired as (
  select * from (values
    ('legal_business_name',  10),
    ('current_status',       20),
    ('pricing_risk_level',   30),
    ('team_members_assigned',40),
    ('relationship_manager', 50),
    ('monthly_acq_volume',   60),
    ('pricing_model',        70),
    ('last_merchant_response', 80),
    ('last_outreach',        90),
    ('date_lead_generated', 100),
    ('mid',                 110),
    ('mcc_code',            120),
    ('affiliate_business_name', 130),
    ('ad_campaign',         140)
  ) as t(field_key, position)
),
flat as (
  -- Modules whose header order is entirely unset. `count(distinct position) = 1`
  -- with that one value being 0 is the precise test for "never arranged".
  select module_id
    from module_header_fields
   group by module_id
  having count(distinct position) = 1 and min(position) = 0
)
update module_header_fields mh
   set position = coalesce(d.position, 900 + mh.position)
  from fields f
  left join desired d on d.field_key = f.key::text
 where f.id = mh.field_id
   and mh.module_id in (select module_id from flat);

-- Anything the list above does not name keeps a deterministic place at the end
-- rather than tying again: ordered by the field's own global position, which is
-- the order the Presets screen already shows them in.
with ranked as (
  select mh.module_id, mh.field_id,
         900 + (row_number() over (partition by mh.module_id order by f.position, f.key)) * 10 as pos
    from module_header_fields mh
    join fields f on f.id = mh.field_id
   where mh.position >= 900
)
update module_header_fields mh
   set position = r.pos
  from ranked r
 where r.module_id = mh.module_id and r.field_id = mh.field_id;
