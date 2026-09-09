-- =============================================================================
-- Module 2 — Part 5 of 10: the activity log
--
-- This table IS the field history (SCHEMA.md) — it is why records.values can
-- overwrite in place, and why there is no per-value versioning table.
--
-- SCHEMA-DECISIONS §12: partitioned by month from day one. Converting an
-- unpartitioned multi-million-row table later is an outage-shaped migration;
-- declaring it partitioned now costs nothing while the table is small, and
-- "12 months hot, then archive" (the retention posture the auth module
-- already committed to) becomes a cheap detach-partition operation later
-- instead of a delete that has to scan and vacuum a live table.
-- =============================================================================

create table record_activity (
  id         bigserial,
  -- No FK, deliberately (see migration 18's comment on this column) — the
  -- entry must survive a Recycle Bin purge of the record it refers to.
  record_id  uuid not null,
  actor_id   uuid,                    -- no FK: survives user deletion, same
                                       -- reasoning as auth_audit_log.actor_id
  kind       activity_kind not null,
  field_key  citext,                  -- for kind = 'field'
  summary    text not null,
  from_value text,
  to_value   text,
  at         timestamptz not null default now(),
  primary key (id, at)                -- partition key must be part of the PK
) partition by range (at);

comment on column record_activity.actor_id is
  'No foreign key, deliberately — same reasoning as auth_audit_log.actor_id: '
  'the entry must survive deletion of the user it refers to.';

create index record_activity_record on record_activity (record_id, at desc);

-- This month's partition, plus next month's created ahead of time so the
-- first-of-the-month write never races partition creation. A scheduled job
-- (outside this migration) creates each further month a week ahead.
create table record_activity_2026_08 partition of record_activity
  for values from ('2026-08-01') to ('2026-09-01');
create table record_activity_2026_09 partition of record_activity
  for values from ('2026-09-01') to ('2026-10-01');

-- Append-only: revoke AND trigger. The revoke stops the ordinary grant path;
-- the trigger catches the table owner, whom a revoke does not. refuse_mutation()
-- is reused verbatim from 20260810000100_auth_foundation.sql — same table
-- shape of problem, same fix, no reason for a second copy of the function.
revoke update, delete on record_activity from authenticated, anon;

create trigger record_activity_append_only
  before update or delete on record_activity
  for each row execute function refuse_mutation();

-- log_activity — the one writer. Every mutation in the data layer that needs
-- to record history calls this rather than inserting directly, so the append-
-- only posture and the partition scheme stay an implementation detail nothing
-- else has to know about.
create or replace function log_activity(
  p_record_id  uuid,
  p_kind       activity_kind,
  p_summary    text,
  p_field_key  citext default null,
  p_from_value text default null,
  p_to_value   text default null
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
  values (p_record_id, auth.uid(), p_kind, p_field_key, p_summary, p_from_value, p_to_value);
$$;
