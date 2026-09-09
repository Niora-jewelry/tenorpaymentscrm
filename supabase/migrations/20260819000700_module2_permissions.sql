-- =============================================================================
-- Module 2 — Part 7 of 10: permission templates and overrides
--
-- The Admin Module Plan §2.4 schema, built directly: three grant levels
-- (Hidden/View/Edit), scoped to a module, a tab, or a field, resolved as
-- "user override if one exists, otherwise the template value, otherwise Edit"
-- (SCHEMA-DECISIONS §14).
-- =============================================================================

create table permission_templates (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  created_at timestamptz not null default now()
);

-- One row per (template, scope). scope_kind distinguishes module access,
-- tab/subtab access, and field access — three levels, one grant shape.
-- `grant_level`, not `grant` — GRANT is a reserved word in Postgres and
-- cannot be used as a bare column name.
create table template_grants (
  template_id uuid not null references permission_templates on delete cascade,
  scope_kind  grant_scope not null,
  scope_id    uuid not null,             -- module_id / tab_id / field_id
  grant_level permission_level not null,
  primary key (template_id, scope_kind, scope_id)
);

create table user_templates (
  user_id     uuid primary key references profiles on delete cascade,
  template_id uuid references permission_templates
  -- NULL template_id + any row in user_grants = "Custom", per the Admin
  -- Plan's three labels: "Template: X", "Template: X (edited)", "Custom".
);

-- Per-user overrides — same shape as template_grants, always wins when present.
create table user_grants (
  user_id     uuid not null references profiles on delete cascade,
  scope_kind  grant_scope not null,
  scope_id    uuid not null,
  grant_level permission_level not null,
  primary key (user_id, scope_kind, scope_id)
);

-- "user override if one exists, otherwise the template value, otherwise Edit"
-- (unlisted defaults to Edit, matching the prototype's VIEWERS model).
-- Template edits are live-linked for free: this function reads
-- template_grants at call time, so editing a template changes every attached
-- user's effective grant on the next query, with zero propagation step.
create or replace function effective_grant(u uuid, kind grant_scope, scope uuid)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select grant_level from user_grants ug
      where ug.user_id = u and ug.scope_kind = kind and ug.scope_id = scope),
    (select tg.grant_level from user_templates ut
       join template_grants tg on tg.template_id = ut.template_id
      where ut.user_id = u and tg.scope_kind = kind and tg.scope_id = scope),
    'edit'
  );
$$;

-- -----------------------------------------------------------------------------
-- record_visibility_grants — "an admin can grant User A access to User B's
-- records", one-directional. Referenced by can_see_record() (migration 1);
-- lives here because it is a permissions concept, not a records one.
-- -----------------------------------------------------------------------------
create table record_visibility_grants (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references profiles on delete cascade,
  viewer_id  uuid not null references profiles on delete cascade,
  granted_by uuid references profiles on delete set null,
  created_at timestamptz not null default now(),
  unique (owner_id, viewer_id),
  constraint visibility_grant_not_self check (owner_id <> viewer_id)
);

create index record_visibility_grants_viewer on record_visibility_grants (viewer_id);
