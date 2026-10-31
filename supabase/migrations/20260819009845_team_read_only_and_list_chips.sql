-- =============================================================================
-- Two things the browser pass found on Team Assignment.
--
-- A list-only row needs its module memberships too: the sidebar count and the
-- list's module chips read them, so a viewer's list said one record and the
-- sidebar said none.
--
-- The app resolves grants itself on some paths, and the service-role features
-- (sending an application or an agreement) gate on that answer, so it needs
-- "read only until taken" as well as the database's own checks. Batched, and
-- only a record with an open assignment can be in the answer.
-- =============================================================================

drop policy if exists record_modules_select on record_modules;
create policy record_modules_select on record_modules for select using (record_listable(record_id));

create or replace function records_read_only(p_ids uuid[])
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct a.record_id), '{}')
    from record_team_assignments a
   where a.record_id = any(p_ids)
     and a.taken_by is null
     and not user_can_see_record_by_rules(auth.uid(), a.record_id);
$$;

revoke all on function records_read_only(uuid[]) from public, anon;
grant execute on function records_read_only(uuid[]) to authenticated;
