-- =============================================================================
-- Module 2 — Part 33: migration 32 dropped the composite PK on
-- user_field_order but that alone does not undo the per-column NOT NULL
-- Postgres stamps onto every PK participant — `DROP CONSTRAINT` removes the
-- constraint, not the `attnotnull` flag it set. Confirmed directly:
-- `information_schema.columns` still showed `subtab_id` as `is_nullable =
-- 'NO'` after migration 32, and a null insert still failed with the same
-- 23502 error. This is the missing explicit step.
-- =============================================================================

alter table user_field_order alter column subtab_id drop not null;
