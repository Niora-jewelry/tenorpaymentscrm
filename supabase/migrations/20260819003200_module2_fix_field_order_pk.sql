-- =============================================================================
-- Module 2 — Part 32: user_field_order's primary key silently forced
-- subtab_id NOT NULL — breaking field-order personalization on every
-- subtab-less tab (4 of 6 custom tabs: Contact, Equipment, Marketing,
-- Overview).
--
-- FOUND WHILE WIRING the drawer's field-order READ path into page.tsx
-- (migration 8 built the table and `lib/records/preferences.ts` had the
-- functions from Stage 2, but nothing actually called `fieldOrderFor()` to
-- apply a saved order until this pass — so this specific insert path had
-- never been exercised end to end). `subtab_id uuid references subtabs`
-- looks nullable in the column definition (correctly modeling "this tab has
-- no subtabs"), but Postgres makes EVERY column in a composite PRIMARY KEY
-- implicitly NOT NULL, regardless of the column's own declaration — so
-- `primary key (user_id, tab_id, subtab_id, field_id)` silently required a
-- real subtab_id, and `setFieldOrder()`'s `subtab_id: null` insert (the
-- correct call for a subtab-less tab) failed outright with a constraint
-- violation. `user_column_order`'s PK never had this problem — module_id is
-- never null there.
--
-- Fix: drop the PK, replace it with a unique index that treats a NULL
-- subtab_id as one specific value via `coalesce` (the standard Postgres
-- pattern for "nullable column, still needs uniqueness enforced including
-- the null case") — using the nil UUID as the sentinel, matching no real
-- subtab id.
-- =============================================================================

alter table user_field_order drop constraint user_field_order_pkey;

create unique index user_field_order_unique on user_field_order (
  user_id, tab_id, coalesce(subtab_id, '00000000-0000-0000-0000-000000000000'::uuid), field_id
);
