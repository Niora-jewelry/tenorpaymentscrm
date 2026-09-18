-- =============================================================================
-- Part 76: actually take `records.values` away.
--
-- ── WHY 75 DID NOT WORK ──────────────────────────────────────────────────
-- Migration 75 ended with:
--
--     revoke select ("values") on records from authenticated, anon;
--
-- It applied without error and changed nothing. Retested with the same browser
-- token, `ein` came back in full:
--
--     GET /rest/v1/records?select=deal_name,values
--       -> 200 "ein": "450172628"
--
-- The reason is a Postgres rule that is easy to read past: A COLUMN-LEVEL
-- REVOKE CANNOT SUBTRACT FROM A TABLE-LEVEL GRANT. They are separate
-- privileges. `authenticated` held SELECT on the whole table, which authorises
-- every column in it, and revoking one column's entry left that untouched.
--
-- The only way to restrict a column is to take the table-wide privilege away
-- and hand back an explicit list:
--
--     revoke select on records from authenticated;
--     grant  select (id, deal_name, …) on records to authenticated;
--
-- Same shape of mistake as migration 73's: a statement that looks like it
-- closes something, runs clean, and closes nothing. Both were caught only by
-- re-running the attack afterwards — which is the argument for always doing so.
--
-- ── WHAT `authenticated` KEEPS ───────────────────────────────────────────
-- Every column except `values`. The column list is spelled out rather than
-- derived, so adding a column to `records` later does NOT silently expose it:
-- a new column is unreadable until someone adds it here deliberately.
--
-- ⚠ INSERT and UPDATE are deliberately untouched. Writes to `values` go
-- through `set_record_values()`, a SECURITY DEFINER function, and narrowing a
-- working write path is not what this migration is for.
--
-- ⚠ `anon` loses SELECT on this table entirely. It never had a policy that
-- matched, so it could never read a row anyway — this simply stops it being
-- one policy away from doing so.
-- =============================================================================

revoke select on records from authenticated, anon;

grant select (
  id,
  deal_name,
  creator_kind,
  creator_user_id,
  creator_campaign_id,
  created_at,
  updated_at,
  deleted_at
) on records to authenticated;
