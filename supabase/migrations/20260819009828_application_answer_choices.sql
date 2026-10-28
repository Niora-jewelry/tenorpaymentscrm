-- =============================================================================
-- Choices the revised application can answer that the CRM could not hold.
--
--   Building ownership   Own / Lease / Rent   → add "Leases"
--   Entity type          … / Other            → add "Other"
--   Inventory            … / Other            → add "Other"
--
-- Added at the end of each list, global scope. Nothing existing is renamed,
-- re-keyed or converted.
-- =============================================================================

insert into field_choices (field_id, module_id, key, value, position)
select f.id, null, v.key, v.value,
       coalesce((select max(c.position) from field_choices c where c.field_id = f.id and c.module_id is null), 0) + 10
  from (values
    ('building_ownership', 'leases', 'Leases'),
    ('entity_type',        'other',  'Other'),
    ('inventory',          'other',  'Other')
  ) as v(field_key, key, value)
  join fields f on f.key = v.field_key
 where not exists (select 1 from field_choices c where c.field_id = f.id and c.module_id is null and c.key = v.key);
