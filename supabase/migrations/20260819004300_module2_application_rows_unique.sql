-- =============================================================================
-- Module 2 — Part 43: the 5 locked Application file rows are unique per record.
--
-- ── THE RACE ─────────────────────────────────────────────────────────────
-- `ensureApplicationRows` (`lib/records/files.ts`) is a read-then-write with
-- nothing between the two halves: it SELECTs which of the five system rows a
-- record already has, then INSERTs the missing ones. Two requests that open the
-- same brand-new record at the same time — two tabs, a double click, a reload
-- landing next to the original — both see zero rows and both insert all five.
-- The record ends up with ten locked Application rows, and the Files tab
-- faithfully renders every one of them.
--
-- Nothing has ever prevented this: `file_rows` carries only
-- `file_rows_record (record_id) where deleted_at is null` (migration 4), which
-- is a lookup index, not a constraint.
--
-- The race predates this pass. What changed is that the two halves now sit
-- inside a `Promise.all` alongside a dozen other drawer fetches, so they are no
-- longer the very first thing the drawer does — worth closing properly rather
-- than leaving to timing.
--
-- ── CLAUDE.md: "rules that must never break belong in the database" ───────
-- The application-side fix is `on conflict do nothing` on the insert, and that
-- alone is not enough: without a unique index there is no conflict for Postgres
-- to detect. This index is what makes the guard real, and it holds against a
-- direct SQL insert too.
--
-- ── WHY IT IS SCOPED TO kind = 'application' ─────────────────────────────
-- Only the five Application rows are a fixed system structure with fixed names
-- ("defined as a system structure, not something a user adds or removes" —
-- `files.ts`). A user MAY legitimately add two "other" rows with the same name;
-- that is their filing, not a defect, and constraining it would break a
-- workflow to fix a bug it does not have.
--
-- ── WHY IT EXCLUDES SOFT-DELETED ROWS ────────────────────────────────────
-- `deleted_at is null` matches the existing index's own predicate. A deleted
-- row must not block re-creating the row it replaced, and `ensureApplicationRows`
-- already reads with the same filter, so index and query agree exactly.
--
-- ── BACKFILL ─────────────────────────────────────────────────────────────
-- Any duplicates already created by this race have to go before a unique index
-- can be built. The DELETE below keeps the OLDEST row of each duplicate group
-- (`ctid` as the tie-break — these rows are otherwise identical, and the oldest
-- is the one any `files` uploaded so far will be attached to) and soft-deletes
-- the rest rather than hard-deleting them, so nothing cascades into `files`.
--
-- Soft-deleting is why this cannot use `create index concurrently`: the whole
-- migration must be one transaction with the cleanup, or a row inserted between
-- the two steps would fail the build.
-- =============================================================================

-- Step 1: retire any duplicates this race has already produced. Keeps the
-- first of each (record_id, name) group among live application rows.
update file_rows f
   set deleted_at = now()
 where f.kind = 'application'
   and f.deleted_at is null
   and exists (
     select 1
       from file_rows keep
      where keep.record_id = f.record_id
        and keep.kind = 'application'
        and keep.name = f.name
        and keep.deleted_at is null
        and keep.ctid < f.ctid
   );

-- Step 2: make it impossible to do again.
create unique index file_rows_application_unique
    on file_rows (record_id, name)
 where kind = 'application' and deleted_at is null;
