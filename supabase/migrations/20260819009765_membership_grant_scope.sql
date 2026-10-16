-- =============================================================================
-- A fifth grant scope: `membership` — may this person add records to, and
-- remove them from, a module?
--
-- Client, 16 Oct 2026 (Addition 2):
--   "There should be a permission setting in the admin panel which allows the
--    admin to set permissions for which users can add/remove records from
--    modules."
--
-- Until now that was simply the module grant at Edit. It is now its own
-- setting, resolved by migration 9766. This file adds the enum label only:
-- Postgres allows `ALTER TYPE … ADD VALUE` inside a transaction but forbids
-- USING the new label in that same transaction — exactly the split migrations
-- 50 and 51 used for `subtab`. Until 9766 lands, `grant_scope_must_exist()`
-- falls through to its `else` and refuses a membership grant, which is the
-- correct, fail-closed order.
-- =============================================================================

alter type grant_scope add value if not exists 'membership';
