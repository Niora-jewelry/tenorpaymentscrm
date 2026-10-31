-- =============================================================================
-- Several steps of a run can happen in one transaction, and `now()` is the
-- transaction's start, so they all carried the same time. Run history and the
-- Updates tab sort by that time, so their order was left to chance. Each entry
-- now takes the moment it happened.
-- =============================================================================

alter table automation_run_steps alter column at set default clock_timestamp();
alter table automation_runs alter column started_at set default clock_timestamp();

create or replace function automation_log(
  p_run          automation_runs,
  p_summary      text,
  p_kind         activity_kind default 'automation',
  p_team         uuid default null,
  p_names_person boolean default false,
  p_field        text default null,
  p_from         text default null,
  p_to           text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz := clock_timestamp();
begin
  insert into updates (record_id, author_id, body, automation_id, automation_name, team_id, names_person, created_at)
  values (p_run.record_id, null, p_summary, p_run.automation_id, p_run.automation_name, p_team, p_names_person, v_at);
  insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value, source, team_id, names_person, at)
  values (p_run.record_id, null, p_kind, p_field, p_summary, p_from, p_to, 'Automation: ' || p_run.automation_name, p_team, p_names_person, v_at);
end;
$$;
