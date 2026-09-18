-- =============================================================================
-- Part 82: migration 81's INSERT column revoke did nothing. This one works.
--
-- ── THE SAME TRAP, FOR THE SECOND TIME IN THIS SCHEMA ────────────────────
-- 81 ended with:
--
--   revoke insert (created_at, updated_at, deleted_at, creator_campaign_id)
--     on table public.records from authenticated;
--
-- It applied without error and changed nothing, because `authenticated` holds
-- a TABLE-level INSERT grant on `records`. A column-level REVOKE cannot
-- subtract from a table-level GRANT — the table grant covers every column,
-- including ones a column revoke has "removed". `information_schema.
-- column_privileges` still listed all nine columns afterwards, which is how
-- this was caught.
--
-- This is migration 75 all over again (same trap, on SELECT, fixed by 76), and
-- 81's own header warns about it for UPDATE while walking into it for INSERT.
-- The UPDATE half of 81 was correct — it revoked the table privilege AND the
-- column privileges, and `authenticated` now has no UPDATE on `records` at all.
--
-- The only shape that narrows a privilege to some columns:
--
--   revoke <priv> on table ... from <role>;      -- drop the table-wide grant
--   grant  <priv> (cols) on table ... to <role>; -- hand back only these
--
-- ── DELETE GOES TOO ──────────────────────────────────────────────────────
-- `authenticated` also held table-level DELETE. No DELETE policy exists, so
-- RLS refused every attempt and the grant was never reachable — but "blocked
-- by the other half of the mechanism" is not the same as "not granted", and a
-- future permissive policy would silently switch it on. Records are removed by
-- `purge_record()`, which is SECURITY DEFINER and unaffected.
-- =============================================================================

revoke insert, delete on table public.records from authenticated;

-- Exactly what `createRecord` sets, and nothing else. `deleted_at` is the one
-- that mattered: settable at INSERT, it is a record born in the Recycle Bin.
grant insert (id, deal_name, creator_kind, creator_user_id, "values")
  on table public.records to authenticated;
