-- =============================================================================
-- Module 2 — Part 9 of 10: RLS — every remaining policy, in one migration
--
-- Every table created by migrations 2–7 was built WITHOUT row level security
-- or grants — deliberately. A table with no GRANT to anon/authenticated is
-- already unreachable from the client regardless of RLS status (a plain
-- Postgres privilege check runs before RLS is ever consulted), exactly the
-- posture 20260810000100_auth_foundation.sql already uses for invites,
-- otp_challenges and rate_limit_counters. This migration is where the two —
-- RLS policy and the matching GRANT — land together, so "default-deny turns
-- into default-deny-with-explicit-exceptions" happens as one atomic step
-- instead of table-by-table, exactly as SCHEMA.md's migration order specifies.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- record_visible — SCHEMA-DECISIONS §6/§15's two-part child-content check,
-- factored out once instead of repeated inline on every content table:
-- the record must both still be live AND visible to the caller. Soft delete
-- does not cascade, so a child row's own existence says nothing about whether
-- its parent record is still live — this is what makes "the record went to
-- the Recycle Bin" instantly hide every note, file, case and message without
-- touching any of those tables.
-- -----------------------------------------------------------------------------
create or replace function record_visible(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from records r where r.id = rec and r.deleted_at is null)
     and can_see_record(rec);
$$;

-- =============================================================================
-- Configuration — readable by every signed-in user (the UI needs the whole
-- config to render), writable by admins only. Same shape as the auth
-- module's roles/permissions/role_permissions trio.
-- =============================================================================
alter table modules              enable row level security; alter table modules              force row level security;
alter table tabs                 enable row level security; alter table tabs                 force row level security;
alter table subtabs              enable row level security; alter table subtabs              force row level security;
alter table module_tab_order     enable row level security; alter table module_tab_order     force row level security;
alter table module_subtab_order  enable row level security; alter table module_subtab_order  force row level security;
alter table fields               enable row level security; alter table fields               force row level security;
alter table module_columns       enable row level security; alter table module_columns       force row level security;
alter table module_header_fields enable row level security; alter table module_header_fields force row level security;
alter table field_choices        enable row level security; alter table field_choices        force row level security;
alter table pipelines            enable row level security; alter table pipelines            force row level security;
alter table pipeline_steps       enable row level security; alter table pipeline_steps       force row level security;

create policy modules_select              on modules              for select to authenticated using (true);
create policy tabs_select                 on tabs                 for select to authenticated using (true);
create policy subtabs_select              on subtabs              for select to authenticated using (true);
create policy module_tab_order_select     on module_tab_order     for select to authenticated using (true);
create policy module_subtab_order_select  on module_subtab_order  for select to authenticated using (true);
create policy fields_select               on fields               for select to authenticated using (true);
create policy module_columns_select       on module_columns       for select to authenticated using (true);
create policy module_header_fields_select on module_header_fields for select to authenticated using (true);
create policy field_choices_select        on field_choices        for select to authenticated using (true);
create policy pipelines_select            on pipelines            for select to authenticated using (true);
create policy pipeline_steps_select       on pipeline_steps       for select to authenticated using (true);

create policy modules_write_admin              on modules              for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy tabs_write_admin                 on tabs                 for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy subtabs_write_admin              on subtabs              for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy module_tab_order_write_admin     on module_tab_order     for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy module_subtab_order_write_admin  on module_subtab_order  for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy fields_write_admin               on fields               for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy module_columns_write_admin       on module_columns       for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy module_header_fields_write_admin on module_header_fields for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy field_choices_write_admin        on field_choices        for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy pipelines_write_admin            on pipelines            for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy pipeline_steps_write_admin       on pipeline_steps       for all to authenticated using (auth_is_admin()) with check (auth_is_admin());

grant select on
  modules, tabs, subtabs, module_tab_order, module_subtab_order, fields,
  module_columns, module_header_fields, field_choices, pipelines, pipeline_steps
to authenticated;
grant insert, update, delete on
  modules, tabs, subtabs, module_tab_order, module_subtab_order, fields,
  module_columns, module_header_fields, field_choices, pipelines, pipeline_steps
to authenticated;

-- =============================================================================
-- Records — SCHEMA.md's records_select, plus column-restricted writes: a
-- client may change deal_name/values, never deleted_at, creator_*, or id —
-- those move only through delete_record()/restore_record() (SECURITY
-- DEFINER) or at creation time.
-- =============================================================================
alter table records enable row level security;
alter table records force  row level security;

create policy records_select on records for select to authenticated
  using (deleted_at is null and can_see_record(id));

create policy records_insert on records for insert to authenticated
  with check (true);

create policy records_update on records for update to authenticated
  using (deleted_at is null and can_see_record(id))
  with check (deleted_at is null and can_see_record(id));

grant select, insert on records to authenticated;
grant update (deal_name, values, updated_at) on records to authenticated;
-- No DELETE grant: delete_record()/restore_record() are SECURITY DEFINER and
-- run as the function owner, independent of the caller's table grants.

-- =============================================================================
-- Record-scoped content — same "visible iff the parent record is visible"
-- shape throughout (SCHEMA-DECISIONS §15), via record_visible() above.
-- =============================================================================
alter table record_modules         enable row level security; alter table record_modules         force row level security;
alter table record_pipelines       enable row level security; alter table record_pipelines       force row level security;
alter table record_custom_entries  enable row level security; alter table record_custom_entries  force row level security;
alter table notes                  enable row level security; alter table notes                  force row level security;
alter table updates                enable row level security; alter table updates                force row level security;
alter table update_mentions        enable row level security; alter table update_mentions        force row level security;
alter table cases                  enable row level security; alter table cases                  force row level security;
alter table case_managers          enable row level security; alter table case_managers          force row level security;
alter table case_replies           enable row level security; alter table case_replies           force row level security;
alter table file_rows              enable row level security; alter table file_rows              force row level security;
alter table files                  enable row level security; alter table files                  force row level security;
alter table statement_files        enable row level security; alter table statement_files        force row level security;
alter table logins                 enable row level security; alter table logins                 force row level security;
alter table credential_reveals     enable row level security; alter table credential_reveals     force row level security;
alter table messages               enable row level security; alter table messages               force row level security;
alter table record_activity        enable row level security; alter table record_activity        force row level security;
alter table record_team_members    enable row level security; alter table record_team_members    force row level security;

create policy record_modules_all on record_modules for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

create policy record_pipelines_all on record_pipelines for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

create policy record_custom_entries_all on record_custom_entries for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

create policy notes_all on notes for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

create policy updates_all on updates for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

create policy update_mentions_all on update_mentions for all to authenticated
  using (exists (select 1 from updates u where u.id = update_id and record_visible(u.record_id)))
  with check (exists (select 1 from updates u where u.id = update_id and record_visible(u.record_id)));

create policy cases_all on cases for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

create policy case_managers_all on case_managers for all to authenticated
  using (exists (select 1 from cases c where c.id = case_id and record_visible(c.record_id)))
  with check (exists (select 1 from cases c where c.id = case_id and record_visible(c.record_id)));

create policy case_replies_all on case_replies for all to authenticated
  using (exists (select 1 from cases c where c.id = case_id and record_visible(c.record_id)))
  with check (exists (select 1 from cases c where c.id = case_id and record_visible(c.record_id)));

create policy file_rows_all on file_rows for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

create policy files_all on files for all to authenticated
  using (exists (select 1 from file_rows fr where fr.id = file_row_id and record_visible(fr.record_id)))
  with check (exists (select 1 from file_rows fr where fr.id = file_row_id and record_visible(fr.record_id)));

create policy statement_files_all on statement_files for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

-- Logins: metadata visible to anyone who can see the record. password_enc and
-- password_key are additionally revoked at the column level below — RLS
-- filters ROWS, it cannot filter columns out of a visible row, so the
-- ciphertext needs its own, stronger cutoff (SCHEMA-DECISIONS §15).
create policy logins_select_metadata on logins for select to authenticated
  using (record_visible(record_id));
create policy logins_write on logins for all to authenticated
  using (record_visible(record_id)) with check (record_visible(record_id));

create policy credential_reveals_select on credential_reveals for select to authenticated
  using (exists (select 1 from logins l where l.id = login_id and record_visible(l.record_id)));
-- No insert/update/delete grant: credential_reveals is written exclusively by
-- reveal_password() below.

create policy messages_select on messages for select to authenticated
  using (record_visible(record_id));
-- No write grant: messages arrive via a provider webhook under the service
-- role, which bypasses RLS entirely — there is no client-side "send" here.

create policy record_activity_select on record_activity for select to authenticated
  using (record_visible(record_id));
-- No write grant: record_activity is written exclusively by log_activity().

create policy record_team_members_select on record_team_members for select to authenticated
  using (user_id = auth.uid() or auth_is_admin());
-- No write grant: maintained exclusively by the sync_record_team_members()
-- trigger on records.

grant select, insert, update, delete on
  record_modules, record_pipelines, record_custom_entries, notes, updates,
  update_mentions, cases, case_managers, case_replies, file_rows, files,
  statement_files, logins
to authenticated;
grant select on credential_reveals, messages, record_activity, record_team_members to authenticated;

revoke select (password_enc, password_key) on logins from authenticated, anon;

-- =============================================================================
-- statement_periods — global lookup, no record_id. Read by everyone, extended
-- by admins ("extending a year is 12 inserts").
-- =============================================================================
alter table statement_periods enable row level security;
alter table statement_periods force  row level security;

create policy statement_periods_select on statement_periods for select to authenticated using (true);
create policy statement_periods_write_admin on statement_periods for all to authenticated
  using (auth_is_admin()) with check (auth_is_admin());

grant select, insert, update, delete on statement_periods to authenticated;

-- =============================================================================
-- Permissions configuration — admin-only end to end this phase. A regular
-- user's effective grant is computed server-side via effective_grant(), never
-- by the client reading these tables directly (SCHEMA.md: "field-level
-- permissions... enforced by the data layer, behind the authorized-context
-- pattern"). Presets/Admin CRUD screens are explicitly out of this phase's
-- scope, but the RLS shape is written now rather than left as a gap, the same
-- way the auth module wrote roles/permissions from its first migration.
-- =============================================================================
alter table permission_templates    enable row level security; alter table permission_templates    force row level security;
alter table template_grants         enable row level security; alter table template_grants         force row level security;
alter table user_templates          enable row level security; alter table user_templates          force row level security;
alter table user_grants             enable row level security; alter table user_grants             force row level security;
alter table record_visibility_grants enable row level security; alter table record_visibility_grants force row level security;

create policy permission_templates_admin     on permission_templates     for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy template_grants_admin          on template_grants          for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy user_templates_admin           on user_templates           for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy user_grants_admin              on user_grants              for all to authenticated using (auth_is_admin()) with check (auth_is_admin());
create policy record_visibility_grants_admin on record_visibility_grants for all to authenticated using (auth_is_admin()) with check (auth_is_admin());

grant select, insert, update, delete on
  permission_templates, template_grants, user_templates, user_grants, record_visibility_grants
to authenticated;

-- effective_grant() and can_see_record() are called from trusted server code
-- (the data layer's authorized-context gate), not directly by the browser —
-- no EXECUTE grant to anon/authenticated, same posture as complete_signup()
-- and friends in the auth module.
revoke all on function effective_grant(uuid, grant_scope, uuid) from anon, authenticated;
revoke all on function can_see_record(uuid) from anon, authenticated;
revoke all on function record_visible(uuid) from anon, authenticated;

-- =============================================================================
-- record_open_case_managers — a materialized view has no RLS. No grant is
-- issued on it directly (unreachable, same "no grant = safe" posture as
-- invites/otp_challenges); reachable only through this function, which
-- re-checks visibility itself.
-- =============================================================================
create or replace function open_case_managers_for(rec uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_ids from record_open_case_managers
   where record_id = rec and record_visible(rec);
$$;

grant execute on function open_case_managers_for(uuid) to authenticated;

-- =============================================================================
-- reveal_password / store_login_password — envelope encryption. The actual
-- key material is never stored in Postgres: it is supplied as an argument by
-- trusted server code that reads it from an environment secret, the same
-- posture OTP_PEPPER already has (KMS-backed key rotation is explicitly
-- deferred, not part of this phase). password_key stores a KEY VERSION LABEL
-- ('v1'), not the key itself, so a future key rotation can tell old
-- ciphertext from new without touching the encrypted bytes until re-saved.
-- =============================================================================
create or replace function store_login_password(
  p_login_id    uuid,
  p_plaintext   text,
  p_key         text,
  p_key_version text default 'v1'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_record uuid;
begin
  select record_id into v_record from logins where id = p_login_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  update logins
     set password_enc = extensions.pgp_sym_encrypt(p_plaintext, p_key),
         password_key = p_key_version
   where id = p_login_id;
end;
$$;

create or replace function reveal_password(p_login_id uuid, p_key text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_enc    bytea;
begin
  select record_id, password_enc into v_record, v_enc from logins where id = p_login_id;
  if v_record is null or not record_visible(v_record) then
    raise exception 'not found';
  end if;

  -- "every reveal is written to the audit log" — before returning the
  -- plaintext, not after, so a decrypt that succeeds is always logged.
  insert into credential_reveals (login_id, user_id) values (p_login_id, auth.uid());

  return extensions.pgp_sym_decrypt(v_enc, p_key);
end;
$$;

-- Service-role only: the key argument makes these unsafe to expose to a role
-- that could pass an arbitrary key and fish for plaintext against ciphertext
-- it can already read the row for.
revoke all on function store_login_password(uuid, text, text, text) from anon, authenticated;
revoke all on function reveal_password(uuid, text) from anon, authenticated;
