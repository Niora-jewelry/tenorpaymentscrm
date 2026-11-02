-- =============================================================================
-- `automation_file_fires` had (automation_id, record_id, row_name) as its primary
-- key, with a foreign key to each side. The API reads a table like that as a link
-- between automations and records, so "automations with their record" became
-- ambiguous and the Automations pages stopped loading (PGRST201), on every site
-- sharing this database. A key of its own makes it a plain table again; the three
-- columns stay unique.
-- =============================================================================

alter table automation_file_fires drop constraint if exists automation_file_fires_pkey;
alter table automation_file_fires add column if not exists id uuid not null default gen_random_uuid();
alter table automation_file_fires add primary key (id);
alter table automation_file_fires drop constraint if exists automation_file_fires_once;
alter table automation_file_fires add constraint automation_file_fires_once unique (automation_id, record_id, row_name);

-- `automation_fire_file` names the three columns for its upsert, which the unique
-- constraint now answers.
notify pgrst, 'reload schema';
