-- =============================================================================
-- Applications are governed by the tab flagged shows_applications (9830),
-- not by a tab key written into the policies.
-- =============================================================================

create or replace function applications_tab_key()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select key::text from tabs where shows_applications order by position limit 1;
$$;
revoke execute on function applications_tab_key() from public, anon;
grant execute on function applications_tab_key() to authenticated;

drop policy if exists applications_select on applications;
create policy applications_select on applications for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, applications_tab_key()));

drop policy if exists application_changes_select on application_changes;
create policy application_changes_select on application_changes for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, applications_tab_key())
         and record_field_grant(record_id, field_key) <> 'hidden');

drop policy if exists application_files_select on application_files;
create policy application_files_select on application_files for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, applications_tab_key()));
