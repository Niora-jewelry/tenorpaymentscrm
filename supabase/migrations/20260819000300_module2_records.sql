-- =============================================================================
-- Module 2 — Part 3 of 10: records
--
-- Storage decision (SCHEMA.md "The one significant storage decision"): field
-- values live as one JSONB document per record, not a column per field and
-- not classic EAV. History lives in the activity log (migration 5), which is
-- why `values` overwrites in place and there is no per-value versioning table.
-- =============================================================================

create table records (
  id          uuid primary key default gen_random_uuid(),
  deal_name   text not null,
  values      jsonb not null default '{}',

  -- Record creator: "which team member/marketing campaign created the
  -- record". Polymorphic from day one — see the comment below.
  creator_kind        creator_kind not null default 'user',
  creator_user_id     uuid references profiles,
  creator_campaign_id uuid,          -- no FK yet; campaigns are a future build

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,           -- soft delete → Recycle Bin

  constraint creator_matches_kind check (
    (creator_kind = 'user'     and creator_user_id is not null and creator_campaign_id is null)
    or
    (creator_kind = 'campaign' and creator_campaign_id is not null and creator_user_id is null)
  )
);
comment on column records.creator_campaign_id is
  'No foreign key yet — campaigns are a future build. Adding a nullable column '
  'and an enum value later is a metadata change; converting a NOT NULL '
  'user_id into this polymorphic pair later would be a data migration across '
  'every record. Paying for the discriminator now avoids that.';

-- Deal Name: "case-insensitive, trimmed, unique across all non-deleted records"
create unique index records_deal_name_unique
  on records (lower(btrim(deal_name)))
  where deleted_at is null;

create index records_live       on records (deal_name) where deleted_at is null;
create index records_values_gin on records using gin (values jsonb_path_ops);

-- -----------------------------------------------------------------------------
-- Memberships — the hub-and-projection model
--
-- No row for the Records List: a record is in the Records List by existing.
-- Zero `record_modules` rows means the record is ARCHIVED — the vocabulary
-- the spec insists on, expressed as an absence rather than a flag, so the two
-- can never disagree with each other.
-- -----------------------------------------------------------------------------
create table record_modules (
  record_id uuid not null references records on delete cascade,
  module_id uuid not null references modules on delete cascade,
  added_at  timestamptz not null default now(),
  added_by  uuid references profiles,
  primary key (record_id, module_id)
);

create index record_modules_lookup on record_modules (module_id, record_id);

create table record_pipelines (
  record_id   uuid not null references records   on delete cascade,
  module_id   uuid not null references modules   on delete cascade,
  pipeline_id uuid not null references pipelines on delete cascade,
  step_id     uuid not null references pipeline_steps,
  updated_at  timestamptz not null default now(),
  primary key (record_id, module_id)   -- independent assignment per module
);

-- -----------------------------------------------------------------------------
-- The "Other" tab — per-record entries, deliberately NOT fields.
--
-- Under the global drawer a field exists in one tab and therefore on every
-- record in the company — a rep adding "warehouse gate code" would put it on
-- all of them. These belong to one record, have no definition, and are
-- therefore not filterable, not column-selectable and not individually
-- permissioned. Access comes from the Other tab's own grant.
-- -----------------------------------------------------------------------------
create table record_custom_entries (
  id         uuid primary key default gen_random_uuid(),
  record_id  uuid not null references records on delete cascade,
  label      text not null,
  value      text,
  position   int not null default 0,
  created_by uuid not null references profiles,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index record_custom_entries_record
  on record_custom_entries (record_id) where deleted_at is null;

-- -----------------------------------------------------------------------------
-- delete_record — "delete only on archived records", enforced here rather
-- than trusted to the UI. Soft delete does not cascade (SCHEMA-DECISIONS §6):
-- only records.deleted_at is ever set, so restore is one UPDATE and every
-- child table becomes visible again exactly as it was, because it was never
-- touched.
-- -----------------------------------------------------------------------------
create or replace function delete_record(rec uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from record_modules where record_id = rec) then
    raise exception 'Archive this record before deleting it — it is still displayed in a module'
      using errcode = '23514';
  end if;
  update records set deleted_at = now() where id = rec;
end;
$$;

-- Restore returns a record ARCHIVED (Recycle Bin spec) — memberships are not
-- reinstated, so it lands back in the Records List with zero display
-- memberships, exactly like any other archived record.
create or replace function restore_record(rec uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update records set deleted_at = null where id = rec;
$$;
