-- =============================================================================
-- Module 2 — Part 2 of 10: configuration
--
-- Under the Global Amendment (17 Aug), tabs, subtabs and fields are GLOBAL —
-- one definition for the entire CRM. A module contributes ordering and
-- selection only: (a)(b) which fields are dashboard columns and in what
-- order, (c)(d) tab/subtab order, (e) header-strip membership, (f) per-module
-- choice overrides.
-- =============================================================================

create table modules (
  id          uuid primary key default gen_random_uuid(),
  slug        citext unique not null,
  label       text not null,
  kind        module_kind not null,
  position    int  not null,
  admin_only  boolean not null default false,
  frozen      boolean not null default false,   -- Residuals, for now — "do not work on it yet"
  created_at  timestamptz not null default now()
);

-- ── Tabs: ONE definition, used by every module ──────────────────────────────
create table tabs (
  id             uuid primary key default gen_random_uuid(),
  key            citext unique not null,
  label          text not null,
  kind           tab_kind not null,
  is_system      boolean not null default false,
  accepts_fields boolean not null default true,
  position       int not null                   -- the GLOBAL default order
);

create table subtabs (
  id          uuid primary key default gen_random_uuid(),
  tab_id      uuid not null references tabs on delete cascade,
  key         citext not null,
  label       text not null,
  description text,                              -- 19 Aug: Pricing's client-authored blurb
  position    int not null,
  coming_soon boolean not null default false,
  unique (tab_id, key)
);

-- ── Per-module ordering — properties (c) and (d) ────────────────────────────
create table module_tab_order (
  module_id uuid not null references modules on delete cascade,
  tab_id    uuid not null references tabs    on delete cascade,
  position  int  not null,
  primary key (module_id, tab_id)
);

create table module_subtab_order (
  module_id uuid not null references modules on delete cascade,
  subtab_id uuid not null references subtabs on delete cascade,
  position  int  not null,
  primary key (module_id, subtab_id)
);

-- -----------------------------------------------------------------------------
-- Fields
--
-- repeat_schema/repeat_max, not repeat_key — SCHEMA-DECISIONS §1: a repeatable
-- set (owners, contacts, affiliates) is ONE row of type 'repeat_group'
-- carrying its member-field definitions inline as JSONB, e.g.:
--   [{"key":"first","label":"First name","type":"text"},
--    {"key":"ssn","label":"SSN","type":"identifier","sensitive":true}, …]
-- rather than N near-duplicate `fields` rows sharing a repeat_key — the
-- prototype's flat-key model (owner_1_first…owner_3_first) is a documented,
-- deliberate simplification for a backend-less demo, not the real shape.
-- -----------------------------------------------------------------------------
create table fields (
  id             uuid primary key default gen_random_uuid(),
  key            citext unique not null,
  label          text not null,
  type           field_type not null,
  -- THE Amendment in one line: exactly one home, globally.
  tab_id         uuid not null references tabs,
  subtab_id      uuid references subtabs,
  position       int  not null,                  -- global order within the tab
  hint           text,

  notes_enabled  boolean not null default false,
  sync_enabled   boolean not null default false,  -- Email/Phone only
  is_system      boolean not null default false,
  read_only      boolean not null default false,  -- Record creator
  required       boolean not null default false,
  sensitive      boolean not null default false,  -- encrypt at rest
  wide           boolean not null default false,  -- takes a full drawer row
  placeholder    boolean not null default false,  -- not yet specified by the client
  width          int,                              -- fixed dashboard column width, px
  digits         int[],                            -- MID: '{8,9}'
  repeat_max     int,                              -- type = 'repeat_group' only
  repeat_schema  jsonb,                             -- type = 'repeat_group' only
  grid_columns   jsonb,                            -- type = 'grid' only: [{label, type}]

  created_at     timestamptz not null default now(),
  archived_at    timestamptz,                      -- retired, values retained

  constraint repeat_group_shape check (
    (type = 'repeat_group' and repeat_max is not null and repeat_schema is not null)
    or (type <> 'repeat_group' and repeat_max is null and repeat_schema is null)
  ),
  constraint grid_shape check (
    (type = 'grid' and grid_columns is not null)
    or (type <> 'grid' and grid_columns is null)
  )
);

-- Two rules worth calling out, enforced by TRIGGER rather than CHECK — a plain
-- CHECK constraint cannot contain a subquery against another table (Postgres
-- rejects it at CREATE TABLE time: "cannot use subquery in check constraint").
-- A BEFORE INSERT OR UPDATE trigger has no such restriction and runs at the
-- same point in the write path a CHECK would.
create or replace function fields_placement_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_accepts_fields boolean;
begin
  -- A field cannot point at a subtab belonging to a different tab.
  if new.subtab_id is not null
     and not exists (select 1 from subtabs s where s.id = new.subtab_id and s.tab_id = new.tab_id)
  then
    raise exception 'Field %: subtab does not belong to the given tab', new.key
      using errcode = '23514';
  end if;

  -- "Updates, Communication and Cases can never contain fields" — enforced in
  -- the database, not only a form validator, so the rule holds even against a
  -- direct SQL insert.
  select accepts_fields into v_accepts_fields from tabs where id = new.tab_id;
  if not v_accepts_fields then
    raise exception 'Field %: tab % does not accept fields', new.key, new.tab_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger fields_placement_guard
  before insert or update of tab_id, subtab_id on fields
  for each row execute function fields_placement_guard();

create index fields_tab      on fields (tab_id);
create index fields_subtab   on fields (subtab_id) where subtab_id is not null;
create index fields_archived on fields (archived_at) where archived_at is not null;

-- -----------------------------------------------------------------------------
-- The two properties that vary per module, plus the two the spreadsheet added
-- -----------------------------------------------------------------------------

-- (a)(b) which fields are dashboard columns, and in what order
create table module_columns (
  module_id uuid not null references modules on delete cascade,
  field_id  uuid not null references fields  on delete cascade,
  position  int  not null,
  primary key (module_id, field_id)
);

-- (e) header-strip membership: "Yes", "Yes - contacts/residuals only", …
create table module_header_fields (
  module_id uuid not null references modules on delete cascade,
  field_id  uuid not null references fields  on delete cascade,
  position  int  not null,
  primary key (module_id, field_id)
);

-- (f) choices, optionally overridden per module — SCHEMA-DECISIONS §3: stored
-- and looked up by a stable KEY, never by the display label. `values` in
-- `records` holds `key`; the admin screen resolves key → current `value` (the
-- display label) at read time, so renaming a choice is one UPDATE here,
-- touching zero record rows.
create table field_choices (
  id        uuid primary key default gen_random_uuid(),
  field_id  uuid not null references fields on delete cascade,
  module_id uuid references modules on delete cascade,  -- NULL = all modules
  key       citext not null,
  value     text not null,
  swatch    swatch,
  position  int not null,
  unique nulls not distinct (field_id, module_id, key)
);

create index field_choices_field on field_choices (field_id, module_id);

-- -----------------------------------------------------------------------------
-- Pipelines
-- -----------------------------------------------------------------------------
create table pipelines (
  id        uuid primary key default gen_random_uuid(),
  module_id uuid not null references modules on delete cascade,  -- exactly one
  label     text not null,
  position  int not null,
  -- the auto-created synced Status field, options = the steps
  status_field_id uuid references fields
);

create table pipeline_steps (
  id          uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references pipelines on delete cascade,
  label       text not null,
  swatch      swatch not null,
  position    int not null
);

create index pipeline_steps_pipeline on pipeline_steps (pipeline_id, position);
