-- =============================================================================
-- Fix: sync_record_team_members() needs SECURITY DEFINER
--
-- FOUND BY: an end-to-end flow check simulating a real "+ New record" click
-- as the `authenticated` role — a plain `INSERT INTO records` failed with
-- "permission denied for table record_team_members".
--
-- record_team_members intentionally carries no INSERT/UPDATE/DELETE grant
-- for authenticated (migration 9's own comment: "No write grant: maintained
-- exclusively by the sync_record_team_members() trigger on records"). That
-- comment assumed trigger invocation runs with elevated privileges the way
-- SECURITY DEFINER functions do — it does not. A trigger function with no
-- SECURITY DEFINER clause executes as the role that fired the triggering
-- statement (here, `authenticated`, inserting into `records`), so its own
-- body's writes are checked against THAT role's grants, not the table
-- owner's. Without SECURITY DEFINER, this trigger could never have
-- succeeded for any real signed-in user — every record creation was broken
-- from the moment migration 6 shipped, caught only now by an actual
-- simulated create-record flow rather than the RPC-only smoke tests, which
-- never happened to insert a fresh record and let its own trigger fire.
-- =============================================================================

create or replace function sync_record_team_members()
returns trigger
language plpgsql
security definer
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
