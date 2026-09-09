-- =============================================================================
-- Module 2 — Part 31: revoke anon's default table grants across every Module
-- 2 table — the same defense-in-depth gap migration 11 already found and
-- closed, but only for 4 tables.
--
-- FOUND WHILE BUILDING: testing whether `anon` could reach a real note row
-- (it can't — RLS's `force row level security` + policies scoped `to
-- authenticated` deny it regardless of the table grant) surfaced that `anon`
-- still holds full INSERT/UPDATE/DELETE on essentially every Module 2 table.
-- Migration 11's own diagnosis explains why: Supabase's project-level
-- `ALTER DEFAULT PRIVILEGES` grants anon/authenticated full CRUD on every
-- newly CREATEd public table automatically; the auth module strips this in
-- the SAME migration that creates its tables, but Module 2's migrations
-- (2-10, 13-30) never did — migration 11 only re-applied the revoke to the
-- 4 tables it was specifically checking (record_activity,
-- credential_reveals, record_team_members, messages), not the rest of the
-- schema.
--
-- Verified NOT an active hole (same reasoning migration 11 already
-- documented): every one of these tables has RLS forced with policies
-- scoped `to authenticated` — a role with zero applicable policies is denied
-- outright, independent of the GRANT. Confirmed directly: a real note row
-- was unreachable by `anon` (0 rows on select, 0 rows changed on update)
-- before this migration existed. This closes the SECOND layer anyway, for
-- the same reason migration 11 did: a future accidental permissive policy
-- for anon is still caught by the missing grant, not left as the only
-- remaining line of defense. Matches migration 11's own scope choice of
-- revoking INSERT/UPDATE/DELETE, not SELECT — the read surface is the
-- intentionally-authenticated-only side of the same RLS policies, not a new
-- risk class.
--
-- Also includes `record_activity`'s two existing monthly partitions
-- (_2026_08, _2026_09) — migration 11 revoked the parent table, but a
-- partition created via `CREATE TABLE ... PARTITION OF` gets its own
-- default-privilege grant independent of the parent's, so the same gap
-- existed one level down.
-- =============================================================================

revoke insert, update, delete on
  case_managers, case_replies, cases, field_choices, fields, file_rows, files,
  module_columns, module_header_fields, module_subtab_order, module_tab_order, modules,
  notes, permission_templates, pipeline_steps, pipelines,
  record_activity_2026_08, record_activity_2026_09, record_custom_entries,
  record_modules, record_pipelines, record_visibility_grants, records,
  statement_files, statement_periods, subtabs, tabs, template_grants,
  update_mentions, updates, user_column_order, user_field_order, user_filters,
  user_grants, user_templates
from anon;

-- logins/notifications already had most of this revoked (migrations 9/11/12)
-- but not every column — this closes the last of each.
revoke delete on logins from anon;
revoke update on notifications from anon;
