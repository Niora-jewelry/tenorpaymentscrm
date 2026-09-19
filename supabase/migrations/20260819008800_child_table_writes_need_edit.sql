-- =============================================================================
-- Part 88: writing a tab's CONTENT needs Edit on that tab, not merely sight of
-- it.
--
-- ── WHAT 85 MISSED ───────────────────────────────────────────────────────
-- Migration 85 guarded every SECURITY DEFINER function that writes a tab's
-- content. It did not guard the tables themselves, and PostgREST exposes them
-- directly — so the RPCs stopped being the only way in:
--
--   POST /rest/v1/cases     {"record_id":"<a VIEW-only record>", ...}  -> 201
--
-- Run as `demo.rep` against a record whose module grant is View, bypassing
-- every RPC:
--
--   INSERT cases          -> 201   UPDATE cases  -> 200   DELETE cases -> 200
--   INSERT updates        -> 201
--   INSERT notes          -> 201
--   INSERT record_modules -> 201   (added a record to the HIDDEN Residuals)
--   DELETE record_modules -> 200   (archived it out of every dashboard by hand)
--
-- The cause is one predicate. Migrations 72/73 wrote these policies as
--
--   using (record_visible(record_id) and tab_visible(record_id, 'cases'))
--
-- and `tab_visible()` is `record_tab_grant(...) <> 'hidden'` — it answers "may
-- I SEE this tab", which is the right question for a SELECT and the wrong one
-- for every other command. The policies are `FOR ALL`, so that one predicate
-- was also governing INSERT, UPDATE and DELETE. VIEW passed all four.
--
-- This is the same defect as `records_update` in migration 81, one level down,
-- and it has the same shape: a check that is correct for reading, reused for
-- writing because one policy covered both.
--
-- ── THE SHAPE OF THE FIX ─────────────────────────────────────────────────
-- Every `*_all` policy is replaced by four: SELECT keeps the visibility rule
-- exactly as it was, and INSERT / UPDATE / DELETE require
-- `record_tab_grant(...) = 'edit'`. Splitting by command is what makes the two
-- questions distinguishable; leaving one policy and tightening it would have
-- made these tabs unreadable to anyone holding View.
--
-- ⚠ `logins_all` IS DROPPED, NOT REPLACED. `logins` already had the right
-- pair — `logins_select_metadata` for reads and `logins_write` requiring Edit —
-- added by an earlier migration, with `logins_all` left in place beside them.
-- Permissive policies are OR-ed, so the correct pair was decorative: the old
-- broad policy granted the write on its own. That is exactly the trap
-- migration 73 documents, still open on this table. Dropping it is the fix.
--
-- ── MEMBERSHIP AND PIPELINES CARRY NO TAB ────────────────────────────────
-- `record_modules` and `record_pipelines` were guarded by `record_visible()`
-- alone, so anyone who could see a record could file it into a module hidden
-- to them, or delete every membership row and archive it out of the CRM —
-- going straight round `set_record_memberships`, which migration 81 spent its
-- length guarding. They are module-scoped, not tab-scoped, so they take the
-- module rule: Edit on the record, and Edit on the module being written.
-- =============================================================================


-- The tab a note's scope names, for a note that does not exist yet (an INSERT
-- check cannot read the row). `note_tab_key(uuid)` from migration 85 answers
-- the same question for a row already stored.
create or replace function public.note_scope_tab_key(p_kind text, p_scope_id text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case p_kind
           when 'tab'   then (select t.key::text from tabs t where t.id::text = p_scope_id)
           when 'field' then (select t.key::text from fields f
                                join tabs t on t.id = f.tab_id
                               where f.id::text = p_scope_id)
         end;
$$;

revoke execute on function public.note_scope_tab_key(text, text) from public, anon;
grant execute on function public.note_scope_tab_key(text, text) to authenticated, service_role;


-- ═══════════════════════════ CASES ═══════════════════════════════════════

drop policy if exists cases_all on public.cases;

create policy cases_select on public.cases for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'cases'));
create policy cases_insert on public.cases for insert to authenticated
  with check (record_visible(record_id) and record_tab_grant(record_id, 'cases') = 'edit');
create policy cases_update on public.cases for update to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'cases') = 'edit')
  with check (record_visible(record_id) and record_tab_grant(record_id, 'cases') = 'edit');
create policy cases_delete on public.cases for delete to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'cases') = 'edit');


drop policy if exists case_replies_all on public.case_replies;

create policy case_replies_select on public.case_replies for select to authenticated
  using (exists (select 1 from cases c where c.id = case_replies.case_id
                   and record_visible(c.record_id) and tab_visible(c.record_id, 'cases')));
create policy case_replies_insert on public.case_replies for insert to authenticated
  with check (exists (select 1 from cases c where c.id = case_replies.case_id
                        and record_visible(c.record_id)
                        and record_tab_grant(c.record_id, 'cases') = 'edit'));
create policy case_replies_update on public.case_replies for update to authenticated
  using (exists (select 1 from cases c where c.id = case_replies.case_id
                   and record_visible(c.record_id)
                   and record_tab_grant(c.record_id, 'cases') = 'edit'))
  with check (exists (select 1 from cases c where c.id = case_replies.case_id
                        and record_visible(c.record_id)
                        and record_tab_grant(c.record_id, 'cases') = 'edit'));
create policy case_replies_delete on public.case_replies for delete to authenticated
  using (exists (select 1 from cases c where c.id = case_replies.case_id
                   and record_visible(c.record_id)
                   and record_tab_grant(c.record_id, 'cases') = 'edit'));


drop policy if exists case_managers_all on public.case_managers;

create policy case_managers_select on public.case_managers for select to authenticated
  using (exists (select 1 from cases c where c.id = case_managers.case_id
                   and record_visible(c.record_id) and tab_visible(c.record_id, 'cases')));
create policy case_managers_insert on public.case_managers for insert to authenticated
  with check (exists (select 1 from cases c where c.id = case_managers.case_id
                        and record_visible(c.record_id)
                        and record_tab_grant(c.record_id, 'cases') = 'edit'));
create policy case_managers_update on public.case_managers for update to authenticated
  using (exists (select 1 from cases c where c.id = case_managers.case_id
                   and record_visible(c.record_id)
                   and record_tab_grant(c.record_id, 'cases') = 'edit'))
  with check (exists (select 1 from cases c where c.id = case_managers.case_id
                        and record_visible(c.record_id)
                        and record_tab_grant(c.record_id, 'cases') = 'edit'));
create policy case_managers_delete on public.case_managers for delete to authenticated
  using (exists (select 1 from cases c where c.id = case_managers.case_id
                   and record_visible(c.record_id)
                   and record_tab_grant(c.record_id, 'cases') = 'edit'));


-- ═══════════════════════════ UPDATES ═════════════════════════════════════

drop policy if exists updates_all on public.updates;

create policy updates_select on public.updates for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'updates'));
create policy updates_insert on public.updates for insert to authenticated
  with check (record_visible(record_id) and record_tab_grant(record_id, 'updates') = 'edit');
create policy updates_update on public.updates for update to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'updates') = 'edit')
  with check (record_visible(record_id) and record_tab_grant(record_id, 'updates') = 'edit');
create policy updates_delete on public.updates for delete to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'updates') = 'edit');


drop policy if exists update_mentions_all on public.update_mentions;

create policy update_mentions_select on public.update_mentions for select to authenticated
  using (exists (select 1 from updates u where u.id = update_mentions.update_id
                   and record_visible(u.record_id) and tab_visible(u.record_id, 'updates')));
create policy update_mentions_insert on public.update_mentions for insert to authenticated
  with check (exists (select 1 from updates u where u.id = update_mentions.update_id
                        and record_visible(u.record_id)
                        and record_tab_grant(u.record_id, 'updates') = 'edit'));
create policy update_mentions_delete on public.update_mentions for delete to authenticated
  using (exists (select 1 from updates u where u.id = update_mentions.update_id
                   and record_visible(u.record_id)
                   and record_tab_grant(u.record_id, 'updates') = 'edit'));


-- ═══════════════════════════ LOGINS ══════════════════════════════════════
-- See the header: the correct pair already exists. This broad policy was
-- OR-ing the write back open.

drop policy if exists logins_all on public.logins;


-- ═══════════════════════════ FILES ═══════════════════════════════════════
-- The tab depends on the row: a `case%` file row belongs to Cases, everything
-- else to Files. Preserved exactly as the old policies computed it.

drop policy if exists file_rows_all on public.file_rows;

create policy file_rows_select on public.file_rows for select to authenticated
  using (record_visible(record_id)
         and tab_visible(record_id, case when kind::text like 'case%' then 'cases' else 'files' end));
create policy file_rows_insert on public.file_rows for insert to authenticated
  with check (record_visible(record_id)
              and record_tab_grant(record_id, case when kind::text like 'case%' then 'cases' else 'files' end) = 'edit');
create policy file_rows_update on public.file_rows for update to authenticated
  using (record_visible(record_id)
         and record_tab_grant(record_id, case when kind::text like 'case%' then 'cases' else 'files' end) = 'edit')
  with check (record_visible(record_id)
              and record_tab_grant(record_id, case when kind::text like 'case%' then 'cases' else 'files' end) = 'edit');
create policy file_rows_delete on public.file_rows for delete to authenticated
  using (record_visible(record_id)
         and record_tab_grant(record_id, case when kind::text like 'case%' then 'cases' else 'files' end) = 'edit');


drop policy if exists files_all on public.files;

create policy files_select on public.files for select to authenticated
  using (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                   and record_visible(fr.record_id)
                   and tab_visible(fr.record_id, case when fr.kind::text like 'case%' then 'cases' else 'files' end)));
create policy files_insert on public.files for insert to authenticated
  with check (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                        and record_visible(fr.record_id)
                        and record_tab_grant(fr.record_id, case when fr.kind::text like 'case%' then 'cases' else 'files' end) = 'edit'));
create policy files_update on public.files for update to authenticated
  using (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                   and record_visible(fr.record_id)
                   and record_tab_grant(fr.record_id, case when fr.kind::text like 'case%' then 'cases' else 'files' end) = 'edit'))
  with check (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                        and record_visible(fr.record_id)
                        and record_tab_grant(fr.record_id, case when fr.kind::text like 'case%' then 'cases' else 'files' end) = 'edit'));
create policy files_delete on public.files for delete to authenticated
  using (exists (select 1 from file_rows fr where fr.id = files.file_row_id
                   and record_visible(fr.record_id)
                   and record_tab_grant(fr.record_id, case when fr.kind::text like 'case%' then 'cases' else 'files' end) = 'edit'));


-- ═══════════════════════════ STATEMENTS ══════════════════════════════════

drop policy if exists statement_files_all on public.statement_files;

create policy statement_files_select on public.statement_files for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'statements'));
create policy statement_files_insert on public.statement_files for insert to authenticated
  with check (record_visible(record_id) and record_tab_grant(record_id, 'statements') = 'edit');
create policy statement_files_update on public.statement_files for update to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'statements') = 'edit')
  with check (record_visible(record_id) and record_tab_grant(record_id, 'statements') = 'edit');
create policy statement_files_delete on public.statement_files for delete to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'statements') = 'edit');


-- ═══════════════════════════ CUSTOM ENTRIES ══════════════════════════════

drop policy if exists record_custom_entries_all on public.record_custom_entries;

create policy record_custom_entries_select on public.record_custom_entries for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'other'));
create policy record_custom_entries_insert on public.record_custom_entries for insert to authenticated
  with check (record_visible(record_id) and record_tab_grant(record_id, 'other') = 'edit');
create policy record_custom_entries_update on public.record_custom_entries for update to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'other') = 'edit')
  with check (record_visible(record_id) and record_tab_grant(record_id, 'other') = 'edit');
create policy record_custom_entries_delete on public.record_custom_entries for delete to authenticated
  using (record_visible(record_id) and record_tab_grant(record_id, 'other') = 'edit');


-- ═══════════════════════════ NOTES ═══════════════════════════════════════
-- A note's tab comes from its scope. A scope naming neither a tab nor a field
-- kept its original "visible by default" reading for SELECT, and falls back to
-- the module ceiling for writes — the rule `requireNoteEdit` applies in
-- `lib/records/notes.ts`.

drop policy if exists notes_all on public.notes;

create policy notes_select on public.notes for select to authenticated
  using (
    record_visible(record_id)
    and coalesce(tab_visible(record_id, note_scope_tab_key(scope_kind::text, scope_id)), true)
  );
create policy notes_insert on public.notes for insert to authenticated
  with check (
    record_visible(record_id)
    and coalesce(
          record_tab_grant(record_id, note_scope_tab_key(scope_kind::text, scope_id)) = 'edit',
          record_module_editable(record_id)
        )
  );
create policy notes_update on public.notes for update to authenticated
  using (
    record_visible(record_id)
    and coalesce(
          record_tab_grant(record_id, note_scope_tab_key(scope_kind::text, scope_id)) = 'edit',
          record_module_editable(record_id)
        )
  )
  with check (
    record_visible(record_id)
    and coalesce(
          record_tab_grant(record_id, note_scope_tab_key(scope_kind::text, scope_id)) = 'edit',
          record_module_editable(record_id)
        )
  );
create policy notes_delete on public.notes for delete to authenticated
  using (
    record_visible(record_id)
    and coalesce(
          record_tab_grant(record_id, note_scope_tab_key(scope_kind::text, scope_id)) = 'edit',
          record_module_editable(record_id)
        )
  );


-- ═══════════════════════ MEMBERSHIP AND PIPELINES ════════════════════════
-- Module-scoped, not tab-scoped. Reads stay as they were; writes need Edit on
-- the record and on the module the row names.

drop policy if exists record_modules_all on public.record_modules;

create policy record_modules_select on public.record_modules for select to authenticated
  using (record_visible(record_id));
create policy record_modules_insert on public.record_modules for insert to authenticated
  with check (record_module_editable(record_id) and module_editable(module_id));
create policy record_modules_update on public.record_modules for update to authenticated
  using (record_module_editable(record_id) and module_editable(module_id))
  with check (record_module_editable(record_id) and module_editable(module_id));
create policy record_modules_delete on public.record_modules for delete to authenticated
  using (record_module_editable(record_id) and module_editable(module_id));


drop policy if exists record_pipelines_all on public.record_pipelines;

create policy record_pipelines_select on public.record_pipelines for select to authenticated
  using (record_visible(record_id));
create policy record_pipelines_insert on public.record_pipelines for insert to authenticated
  with check (record_module_editable(record_id) and module_editable(module_id));
create policy record_pipelines_update on public.record_pipelines for update to authenticated
  using (record_module_editable(record_id) and module_editable(module_id))
  with check (record_module_editable(record_id) and module_editable(module_id));
create policy record_pipelines_delete on public.record_pipelines for delete to authenticated
  using (record_module_editable(record_id) and module_editable(module_id));
