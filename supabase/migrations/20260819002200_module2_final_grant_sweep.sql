-- =============================================================================
-- Final grant sweep — pure REVOKE/GRANT, deliberately zero other DDL in this
-- file.
--
-- FOUND WHILE VERIFYING THE PREVIOUS TWO HARDENING MIGRATIONS: re-checking
-- with has_function_privilege() directly after pushing them showed several
-- functions — including three from the auth-module migration, which
-- contained no CREATE OR REPLACE at all — still anon-executable, despite
-- their revoke/grant statements appearing to run without error. A isolated
-- test confirmed a revoke-only migration (delete_record/restore_record)
-- DOES stick and stays stuck on re-check; something about the combined
-- migrations — most likely Supabase's own `pgrst_ddl_watch` event trigger,
-- which fires on every DDL command including CREATE OR REPLACE FUNCTION and
-- reloads PostgREST's schema/permission cache — appears able to re-widen
-- function grants when DDL and GRANT statements are mixed in the same
-- push. This migration is the isolated, DDL-free re-application, and the
-- durable fix regardless of what the grant layer does: every function this
-- project actually calls with meaningful data already checks the caller's
-- authorization INSIDE its own body (record_visible()/auth_is_admin()) —
-- confirmed function-by-function in the same audit that found this. Grants
-- are the second layer, not the only one.
-- =============================================================================

revoke execute on function
  auth_is_admin(),
  session_state(),
  touch_last_seen(),
  log_activity(uuid, activity_kind, text, citext, text, text),
  open_case_managers_for(uuid),
  fields_placement_guard(),
  files_cap_guard(),
  updates_depth_guard(),
  sync_record_team_members(),
  refresh_open_case_managers(),
  refuse_mutation()
from public, anon;

grant execute on function
  auth_is_admin(),
  session_state(),
  touch_last_seen(),
  open_case_managers_for(uuid)
to authenticated;

-- log_activity: no grant to anyone — unused by any current caller (every
-- combined write function inlines its own activity insert), and if it ever
-- gains a caller it should be through a wrapper that validates first, the
-- same posture notify() already has.
--
-- fields_placement_guard / files_cap_guard / updates_depth_guard /
-- sync_record_team_members / refresh_open_case_managers / refuse_mutation:
-- trigger functions. They run in the firing table's context automatically
-- when their trigger fires — no direct RPC grant was ever needed for that to
-- work, and none is given.
