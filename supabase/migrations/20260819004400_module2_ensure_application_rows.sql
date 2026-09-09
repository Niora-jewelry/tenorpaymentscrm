-- =============================================================================
-- Module 2 — Part 44: create the 5 locked Application file rows in ONE
-- statement that cannot race and cannot half-apply.
--
-- ── THE BUG THIS FIXES (introduced by migration 43) ──────────────────────
-- Migration 43 added a PARTIAL unique index:
--
--     create unique index file_rows_application_unique
--         on file_rows (record_id, name)
--      where kind = 'application' and deleted_at is null;
--
-- and `files.ts` was changed to `.upsert(..., { onConflict: 'record_id,name',
-- ignoreDuplicates: true })` to lean on it. That combination cannot work.
-- Postgres infers an ON CONFLICT target from the columns AND, for a partial
-- index, the statement must repeat the index's own WHERE predicate. PostgREST's
-- `on_conflict` parameter can only send column names, so the predicate is never
-- sent and Postgres refuses:
--
--     42P10 — there is no unique or exclusion constraint matching the
--             ON CONFLICT specification
--
-- That threw on the FIRST drawer open of any record without its Application
-- rows — i.e. every newly created record — which is exactly how it was found:
-- create a record, open it, error page. The failure was total, not
-- intermittent, because it has nothing to do with the race it was meant to
-- guard; the statement is simply invalid.
--
-- ── WHY A FUNCTION RATHER THAN A DIFFERENT UPSERT ────────────────────────
-- Three problems collapse into one statement here:
--
--   1. ON CONFLICT can express the partial index's predicate in SQL, which
--      PostgREST cannot express over HTTP. That alone requires SQL.
--   2. `ensureApplicationRows` was a SELECT then an INSERT — two round trips,
--      on every drawer open, forever, to discover that nothing needed doing.
--      This is one, and on the common path it inserts nothing.
--   3. A multi-row INSERT is all-or-nothing. If a concurrent request had
--      already created two of the five, a statement-level "ignore duplicates"
--      would have swallowed the error and left the other three MISSING —
--      a half-built Files tab, silently. `ON CONFLICT ... DO NOTHING` is
--      evaluated PER ROW, so the three that do not conflict are still
--      inserted. This is the property that actually makes the race safe.
--
-- ── SECURITY INVOKER, DELIBERATELY ───────────────────────────────────────
-- NOT `security definer`. This runs as the calling user, so the existing
-- `file_rows_all` policy (`using/with check record_visible(record_id)`,
-- migration 9) still decides whether these rows may be written — identical to
-- the request-scoped client the TypeScript used. A definer function would have
-- had to re-implement that check, and re-implementing a visibility rule is how
-- the two copies drift. `search_path` is pinned regardless: it costs nothing
-- and removes the question.
--
-- ── NAMES COME FROM THE CALLER, ON PURPOSE ───────────────────────────────
-- `APPLICATION_ROWS` in `lib/records/files.ts` stays the single definition of
-- what the five rows are and what order they sit in. Hard-coding them here too
-- would create a second list that nothing keeps in step with the first.
-- =============================================================================

create or replace function ensure_application_file_rows(
  p_record_id uuid,
  p_names     text[],
  p_positions int[]
)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  insert into file_rows (record_id, kind, name, locked, position)
  select p_record_id, 'application'::file_row_kind, n.name, true, n.position
    from unnest(p_names, p_positions) as n(name, position)
      on conflict (record_id, name)
         where kind = 'application' and deleted_at is null
      do nothing;
$$;

revoke execute on function ensure_application_file_rows(uuid, text[], int[]) from public;
grant execute on function ensure_application_file_rows(uuid, text[], int[]) to authenticated;

comment on function ensure_application_file_rows(uuid, text[], int[]) is
  'Creates any of a record''s locked Application file rows that do not exist '
  'yet, in one race-safe statement. Security INVOKER: the file_rows RLS policy '
  'is what authorises the write, exactly as it did for the client-side insert.';
