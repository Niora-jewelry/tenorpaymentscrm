-- =============================================================================
-- Module 2 (Records List) — Part 1 of 10: enums and helper functions
--
-- Source of truth: docs/SCHEMA.md and docs/SCHEMA-DECISIONS.md, both current to
-- the 19 Aug amendment (Merchant Equipment List, the four-subtab Pricing
-- restructure, per-user personalization).
--
-- This migration only declares TYPES and FUNCTIONS. Every table referenced
-- below by can_see_record() (record_team_members, record_visibility_grants)
-- is created by a LATER migration in this set (6 and 7 respectively) — that is
-- safe because `language sql`/`plpgsql` function bodies are not resolved
-- against the catalog until the function is actually CALLED, and nothing calls
-- can_see_record() before migration 9 (RLS), by which point every table it
-- touches exists. The auth foundation migration already committed the project
-- to this ordering discipline; this migration continues it.
--
-- Reused, not redefined:
--   * citext, pgcrypto  — already created by 20260810000100_auth_foundation.sql
--   * refuse_mutation() — already created there; the append-only pattern is
--     identical here, so the same function is reused verbatim.
--   * auth_is_admin()   — the auth module's admin check. Called directly by
--     name everywhere below rather than re-wrapped as `is_admin()`, since a
--     second name for the same check is a place for the two to drift apart.
-- =============================================================================

create extension if not exists pg_trgm;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------

create type module_kind as enum ('storage', 'display');

-- 'custom' tabs hold admin-defined fields. The other six are system tabs with
-- their own dedicated body (Updates, Cases, Files, Logins, Statements,
-- Communication); 'freeform' is the Other tab — per-record entries, no fields.
create type tab_kind as enum (
  'communication', 'updates', 'cases', 'files', 'logins', 'statements',
  'custom', 'freeform'
);

-- The 15 spec-listed types, the 5 the spreadsheet needed but the spec never
-- listed (percentage, address, percent_split, months, grid), 'identifier'
-- (ours — see SCHEMA-DECISIONS on why MID/MCC/EIN/SSN/account/routing are text,
-- not number), and 'repeat_group' — SCHEMA-DECISIONS §1: a repeatable set
-- (owners, contacts, affiliates) is ONE fields row of this type carrying
-- repeat_schema/repeat_max, not N near-duplicate rows sharing a key.
create type field_type as enum (
  'text', 'long_text', 'number', 'currency', 'date', 'datetime',
  'dropdown', 'status', 'multi_select', 'team_member', 'email', 'phone',
  'url', 'checkbox', 'file',
  'percentage', 'address', 'percent_split', 'months', 'grid',
  'identifier', 'repeat_group'
);

-- The 12 fixed colours (src/proto/ui/tokens.ts SWATCHES) — status pills,
-- pipeline steps, dropdown choices all draw from this one palette.
create type swatch as enum (
  'slate', 'blue', 'indigo', 'teal', 'green', 'lime',
  'amber', 'orange', 'red', 'pink', 'purple', 'brown'
);

create type creator_kind as enum ('user', 'campaign');
create type note_scope as enum ('field', 'tab');
create type activity_kind as enum (
  'field', 'membership', 'pipeline', 'file', 'update', 'case', 'credential', 'record'
);
create type message_channel as enum ('email', 'instantly', 'text');
create type message_direction as enum ('in', 'out');
create type case_state as enum ('open', 'closed');
create type file_row_kind as enum ('application', 'other');

-- Hidden/View/Edit — the granular field-and-tab grant model (Admin Module
-- Plan), layered on top of auth's coarse admin/member split, not replacing it.
create type permission_level as enum ('hidden', 'view', 'edit');
-- What a grant (template or per-user override) is scoped to.
create type grant_scope as enum ('module', 'tab', 'field');

-- -----------------------------------------------------------------------------
-- can_see_record — the ONE predicate every content table's RLS policy calls.
--
-- "Only the Team member field grants visibility" (Modules Plan) plus "an
-- admin can grant User A access to User B's records", one-directional, via
-- record_visibility_grants (migration 7). Marked STABLE so Postgres evaluates
-- it once per row per statement, SECURITY DEFINER with a pinned search_path so
-- it can read membership tables the calling role cannot select directly.
--
-- LANGUAGE PLPGSQL, deliberately, not SQL: this function forward-references
-- record_team_members (migration 6) and record_visibility_grants (migration
-- 7), neither of which exists yet when THIS migration runs. A `language sql`
-- body is parsed and resolved against the catalog at CREATE FUNCTION time —
-- it would fail right here. A `language plpgsql` body is stored as opaque
-- text and only compiled on first CALL, by which point every migration in
-- this set has run — nothing calls can_see_record() before migration 9.
-- -----------------------------------------------------------------------------
create or replace function can_see_record(rec uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return
    auth_is_admin()
    or exists (
      select 1 from record_team_members t
       where t.record_id = rec and t.user_id = auth.uid()
    )
    or exists (
      select 1 from record_visibility_grants g
      join record_team_members t on t.user_id = g.owner_id
     where g.viewer_id = auth.uid() and t.record_id = rec
    );
end;
$$;
