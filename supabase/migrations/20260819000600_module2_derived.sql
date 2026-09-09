-- =============================================================================
-- Module 2 — Part 6 of 10: derived tables — the performance layer
--
-- Two things are read on EVERY single query, so neither can be computed from
-- JSONB at read time.
-- =============================================================================

-- Row visibility. "Only the Team member field grants visibility" — Record
-- creator grants nothing, Relationship manager is informational only; the
-- client was explicit about both. Maintained by trigger from
-- values->'team_members_assigned' because RLS runs can_see_record() on every
-- row of every query, and an index-only scan on a two-column table beats a
-- JSONB containment test on a wide row every time.
create table record_team_members (
  record_id uuid not null references records on delete cascade,
  user_id   uuid not null references profiles on delete cascade,
  primary key (user_id, record_id)      -- user first: the lookup direction
);

create or replace function sync_record_team_members()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg((x)::uuid), '{}')
    into v_ids
    from jsonb_array_elements_text(
      coalesce(new.values->'team_members_assigned', '[]'::jsonb)
    ) as x;

  delete from record_team_members
   where record_id = new.id and user_id <> all (v_ids);

  insert into record_team_members (record_id, user_id)
  select new.id, u from unnest(v_ids) as u
  on conflict (user_id, record_id) do nothing;

  return new;
end;
$$;

create trigger records_sync_team_members
  after insert or update of values on records
  for each row execute function sync_record_team_members();

-- The Tickets module's hardcoded "Open case managers" column. Auto-populated,
-- read-only, refreshed concurrently whenever a case opens, closes, or its
-- manager list changes — never read live off `cases`/`case_managers`, exactly
-- as specified.
create materialized view record_open_case_managers as
select c.record_id, array_agg(distinct cm.user_id) as user_ids
from cases c
join case_managers cm on cm.case_id = c.id
where c.state = 'open' and c.deleted_at is null
group by c.record_id;

create unique index on record_open_case_managers (record_id);

create or replace function refresh_open_case_managers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  refresh materialized view concurrently record_open_case_managers;
  return null;
end;
$$;

create trigger cases_refresh_open_managers
  after insert or update of state, deleted_at or delete on cases
  for each statement execute function refresh_open_case_managers();

create trigger case_managers_refresh_open_managers
  after insert or delete on case_managers
  for each statement execute function refresh_open_case_managers();
