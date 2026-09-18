-- =============================================================================
-- Part 77: grants gain a MODULE dimension. Schema only — no behaviour change.
--
-- ── THE CLAUSE THIS IMPLEMENTS ───────────────────────────────────────────
-- Admin-Module-Plan §2.2, in the client's own words:
--
--   "Granularity is PER MODULE — Records List, Leads, Deals, Contacts,
--    Tickets, Residuals, and every future module, each assigned separately —
--    at three levels:
--      Module access …
--      Tab / subtab access — which drawer tabs and subtabs the user sees
--        WITHIN THAT MODULE.
--      Field-level access — any individual field can be Hidden, View, or Edit
--        PER USER, PER MODULE."
--
-- Grants were `(subject, scope_kind, scope_id, level)` with no module column,
-- so a tab or field grant applied everywhere at once. That is not a cosmetic
-- shortfall: EVERY tab in this build is attached to all six modules —
--
--   logins, statements, pricing, application, contact, equipment, marketing,
--   communication, cases, files, overview, other, updates
--     → each appears in 6 modules
--
-- — so hiding Pricing for a Sales Rep hid it in Leads AND Deals AND Contacts
-- AND Tickets AND Residuals, and there was no way to say otherwise.
--
-- ── NULL MEANS "ALL MODULES" ─────────────────────────────────────────────
-- The new column is NULLABLE, and null is not "unset" — it is a real value
-- meaning "everywhere", which is exactly what every existing row means today.
-- So this migration changes nothing on its own: all 8 existing grants become
-- global grants and resolve exactly as they did.
--
-- A row WITH a module is an override for that module alone.
--
-- ── WHY `module` SCOPE MUST NOT CARRY ONE ────────────────────────────────
-- A `module`-scope grant already names a module in `scope_id`. Letting it also
-- carry `module_id` would allow "the Leads grant, within Deals", which has no
-- meaning and would resolve differently depending on which column a reader
-- happened to trust. The CHECK forbids it rather than leaving it to convention.
--
-- ── NULLS NOT DISTINCT IS LOAD-BEARING ───────────────────────────────────
-- Postgres treats NULLs as distinct in a unique index by default, so without
-- this a user could hold five global grants for the same scope and resolution
-- would pick one arbitrarily. `nulls not distinct` makes "the global row" a
-- single row, which is what upsert depends on.
-- =============================================================================

alter table user_grants
  add column if not exists module_id uuid references modules(id) on delete cascade;

alter table template_grants
  add column if not exists module_id uuid references modules(id) on delete cascade;

comment on column user_grants.module_id is
  'Module this grant applies to. NULL = all modules. Must be NULL for scope_kind = module.';
comment on column template_grants.module_id is
  'Module this grant applies to. NULL = all modules. Must be NULL for scope_kind = module.';


-- ── A module-scope grant may not be module-qualified ─────────────────────
alter table user_grants
  drop constraint if exists user_grants_module_scope_shape;
alter table user_grants
  add constraint user_grants_module_scope_shape
  check (scope_kind <> 'module' or module_id is null);

alter table template_grants
  drop constraint if exists template_grants_module_scope_shape;
alter table template_grants
  add constraint template_grants_module_scope_shape
  check (scope_kind <> 'module' or module_id is null);


-- ── The key has to include the new dimension ─────────────────────────────
-- Done as a UNIQUE INDEX rather than by replacing the primary key: the PK is
-- referenced by nothing, and swapping a live PK on a table two other functions
-- read is a larger operation than this needs to be. The unique index is what
-- upsert targets, and it is the thing that actually enforces one row per
-- (subject, scope, module).
create unique index if not exists user_grants_scope_module_key
  on user_grants (user_id, scope_kind, scope_id, module_id) nulls not distinct;

create unique index if not exists template_grants_scope_module_key
  on template_grants (template_id, scope_kind, scope_id, module_id) nulls not distinct;

-- Resolution reads "this module, then global" for one subject at a time, so
-- these are the lookups that matter.
create index if not exists user_grants_lookup
  on user_grants (user_id, scope_kind, scope_id);
create index if not exists template_grants_lookup
  on template_grants (template_id, scope_kind, scope_id);
