-- =============================================================================
-- Module 2 — Part 47: the activity log stops accepting rows on 2026-10-01.
--
-- ── THE FAULT ────────────────────────────────────────────────────────────
-- `record_activity` is `partition by range (at)` and migration 5 created
-- exactly two partitions:
--
--     record_activity_2026_08   FROM '2026-08-01' TO '2026-09-01'
--     record_activity_2026_09   FROM '2026-09-01' TO '2026-10-01'
--
-- with the comment "A scheduled job (outside this migration) creates each
-- further month a week ahead." **There is no such job.** `pg_cron` is not
-- installed on this project and no `cron` schema exists. Proven by probing the
-- live database inside a rolled-back transaction:
--
--     2026-09-30  ->  INSERT OK
--     2026-10-01  ->  ERROR 23514: no partition of relation
--                     "record_activity" found for row
--
-- ── WHY THIS IS A TOTAL OUTAGE, NOT A LOGGING GAP ────────────────────────
-- CLAUDE.md rule 5 requires a value change and its history to be one
-- transaction, and the build honours it: `set_record_value`,
-- `set_record_values`, `bulk_set_values`, `set_record_memberships`,
-- `delete_record`, `restore_record`, `reveal_password`, `toggle_case_state`,
-- `create_case`, `add_case_reply` and the file/statement writers all insert
-- their `record_activity` row inside the same transaction as the data change.
--
-- So from 2026-10-01 the failed log insert rolls the DATA back with it. No
-- field could be saved, no record archived, no case closed, no password
-- revealed. The whole application stops writing, and the first symptom would
-- be a generic error on an ordinary edit.
--
-- ── THE FIX: PRE-CREATE, PLUS A BACKSTOP THAT CANNOT RUN OUT ─────────────
-- Two layers, because the first one is what a scheduled job would have done
-- and the second is what makes the absence of that job survivable:
--
--   1. Monthly partitions through **December 2032**, generated in a loop. That
--      is the same horizon `statement_periods` already uses, so the two agree
--      on how far ahead this system is provisioned.
--
--   2. A **DEFAULT partition**. Any row outside every declared range lands
--      there instead of raising. After 2032 the log keeps working; it simply
--      stops being partitioned by month until someone extends it.
--
-- The default is a safety net, not the plan — a row in it is a signal that the
-- monthly ranges need extending. It stays EMPTY as long as layer 1 holds, and
-- that matters: attaching a new partition whose range overlaps rows already
-- sitting in the default requires a scan and fails if any such row exists.
--
-- ── APPEND-ONLY IS INHERITED, NOT RE-DECLARED ────────────────────────────
-- `record_activity_append_only` is a row-level trigger on the partitioned
-- PARENT. Postgres clones row-level triggers onto every partition, including
-- ones created after the trigger, so the new partitions are append-only
-- without another `create trigger`. The migration asserts this at the end
-- rather than assuming it — an append-only guarantee that silently did not
-- apply to 2027 would be worse than no guarantee at all.
-- =============================================================================

do $$
declare
  d date := date '2026-10-01';   -- the first uncovered month
  stop date := date '2033-01-01';
  part text;
begin
  while d < stop loop
    part := format('record_activity_%s', to_char(d, 'YYYY_MM'));
    if to_regclass('public.' || part) is null then
      execute format(
        'create table %I partition of record_activity for values from (%L) to (%L)',
        part, d, d + interval '1 month');
    end if;
    d := (d + interval '1 month')::date;
  end loop;
end $$;

-- The backstop. Nothing should ever land here; if something does, the monthly
-- ranges above need extending.
create table if not exists record_activity_default
  partition of record_activity default;

comment on table record_activity_default is
  'Backstop for rows outside every declared month. Should always be empty — '
  'a row here means the monthly partitions need extending past 2032-12.';

-- -----------------------------------------------------------------------------
-- Assert the two properties this migration exists to guarantee, rather than
-- trusting that they followed. A migration that silently half-applied here
-- would leave the outage in place for a date nobody is watching.
-- -----------------------------------------------------------------------------
do $$
declare
  n_missing int;
  n_untriggered int;
begin
  -- 1. Every month from 2026-10 to 2032-12 has a partition.
  select count(*) into n_missing
    from generate_series(date '2026-10-01', date '2032-12-01', interval '1 month') g(m)
   where to_regclass('public.record_activity_' || to_char(g.m, 'YYYY_MM')) is null;
  if n_missing > 0 then
    raise exception 'partition creation incomplete: % month(s) still missing', n_missing;
  end if;

  -- 2. Every partition carries the append-only trigger.
  select count(*) into n_untriggered
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
   where p.relname = 'record_activity'
     and not exists (
       select 1 from pg_trigger t
        where t.tgrelid = c.oid
          and not t.tgisinternal
          and t.tgname like 'record_activity_append_only%'
     );
  if n_untriggered > 0 then
    raise exception 'append-only trigger missing on % partition(s)', n_untriggered;
  end if;
end $$;
