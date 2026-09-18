-- =============================================================================
-- Part 72: make ROW-LEVEL SECURITY honour tab permissions.
--
-- ── THE HOLE, MEASURED ───────────────────────────────────────────────────
-- Every tab-backed table was gated on `record_visible(record_id)` and nothing
-- else. Tab grants — Hidden / View / Edit on Logins, Statements, Cases, Files,
-- Updates — were enforced ONLY in application code.
--
-- That is precisely what CLAUDE.md rule 3 forbids: "A field the user may not
-- see must be ABSENT FROM THE QUERY, not filtered out afterwards… UI-level
-- hiding is never the security boundary."
--
-- Demonstrated against the live project with an ordinary signed-in user whose
-- template sets Logins = Hidden and Statements = Hidden. Not a crafted token —
-- the same session any browser holds, plus the publishable anon key that ships
-- in the client bundle:
--
--   GET /rest/v1/logins?select=id,login_type,username
--     -> 200 [{"login_type":"Processor portal",
--              "username":"seasidesurfrentals_admin"}]
--
--   GET /rest/v1/statement_files?select=id,name
--     -> 200 [{"name":"statement-2026-09.pdf"}, …]
--
-- Both tabs are hidden for that user. Both answered in full.
--
-- WRITES were already safe — an INSERT into `file_rows` came back 42501 — so
-- this is a read-disclosure hole, not a tampering one. On a CRM holding
-- merchant portal logins and processing statements, that is still the wrong
-- side of the line.
--
-- ── THE SHAPE OF THE FIX ─────────────────────────────────────────────────
-- One function, `record_tab_grant(record, tab_key)`, resolving the SAME chain
-- `lib/records/tabAccess.ts` resolves in TypeScript:
--
--   • an admin short-circuits to Edit;
--   • the module ceiling is the HIGHEST grant the viewer holds over any module
--     the record is displayed in — a record in both Leads and Deals is one
--     record, and Edit on either is Edit on it;
--   • admin-only modules never contribute a ceiling to a non-admin;
--   • the tab's own grant is then capped by that ceiling.
--
-- Two implementations of one rule is how they drift, so migration 67's
-- `storage_tab_access` is rewritten to call this rather than keep its own copy.
--
-- ⚠ `record_visible()` IS KEPT IN EVERY POLICY. Visibility and tab permission
-- are different questions and the spec answers them separately; this adds a
-- condition, it does not replace one.
--
-- ⚠ POLICIES STAY `for all`. The write paths already work — every writer goes
-- through a SECURITY DEFINER function or the service role — and narrowing a
-- working write path is not what this migration is for. Adding the tab test to
-- the existing `using` clause tightens reads AND writes consistently, which is
-- the correct direction for both.
-- =============================================================================

create or replace function public.record_tab_grant(rec uuid, p_tab_key text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then 'edit'::permission_level
    else least(
      coalesce(
        (
          select max(effective_grant(auth.uid(), 'module', rm.module_id))
            from record_modules rm
            join modules m on m.id = rm.module_id
           where rm.record_id = rec
             and not m.admin_only
        ),
        'hidden'::permission_level
      ),
      coalesce(
        (
          select effective_grant(auth.uid(), 'tab', t.id)
            from tabs t
           where t.key = p_tab_key
        ),
        'hidden'::permission_level
      )
    )
  end;
$$;

revoke execute on function public.record_tab_grant(uuid, text) from public, anon;
grant execute on function public.record_tab_grant(uuid, text) to authenticated, service_role;

/** Readable shorthand — the policies below only ever ask "not hidden". */
create or replace function public.tab_visible(rec uuid, p_tab_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select record_tab_grant(rec, p_tab_key) <> 'hidden';
$$;

revoke execute on function public.tab_visible(uuid, text) from public, anon;
grant execute on function public.tab_visible(uuid, text) to authenticated, service_role;


-- ── One rule, one implementation ─────────────────────────────────────────
-- Migration 67 carried its own copy of this chain for the recordings bucket.
-- Rewritten to delegate, so the two can no longer disagree.
create or replace function public.storage_tab_access(rec uuid, kind_segment text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select record_tab_grant(
    rec,
    case kind_segment
      when 'case'       then 'cases'
      when 'statements' then 'statements'
      else                   'files'
    end
  );
$$;


-- ═════════════════════════════════════════════════════════════════════════
-- The policies. Each table gains the tab that governs it.
-- ═════════════════════════════════════════════════════════════════════════

-- Logins — the sharpest one. Portal usernames for a merchant.
drop policy if exists logins_select on logins;
drop policy if exists logins_all on logins;
create policy logins_all on logins
  for all to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'logins'))
  with check (record_visible(record_id) and tab_visible(record_id, 'logins'));

-- Statements — processing statements and their filenames.
drop policy if exists statement_files_all on statement_files;
create policy statement_files_all on statement_files
  for all to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'statements'))
  with check (record_visible(record_id) and tab_visible(record_id, 'statements'));

-- Cases, and everything hanging off them.
drop policy if exists cases_all on cases;
create policy cases_all on cases
  for all to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'cases'))
  with check (record_visible(record_id) and tab_visible(record_id, 'cases'));

drop policy if exists case_replies_all on case_replies;
create policy case_replies_all on case_replies
  for all to authenticated
  using (exists (
    select 1 from cases c
     where c.id = case_replies.case_id
       and record_visible(c.record_id)
       and tab_visible(c.record_id, 'cases')
  ));

drop policy if exists case_managers_all on case_managers;
create policy case_managers_all on case_managers
  for all to authenticated
  using (exists (
    select 1 from cases c
     where c.id = case_managers.case_id
       and record_visible(c.record_id)
       and tab_visible(c.record_id, 'cases')
  ));

/*
 * Files. A file row's KIND decides which tab governs it: a case attachment is
 * an ordinary `files` row but lives in the Cases tab — the same split
 * `uploadFile` and `signedUrlFor` already make in application code.
 */
drop policy if exists file_rows_all on file_rows;
create policy file_rows_all on file_rows
  for all to authenticated
  using (
    record_visible(record_id)
    and tab_visible(record_id, case when kind::text like 'case%' then 'cases' else 'files' end)
  )
  with check (
    record_visible(record_id)
    and tab_visible(record_id, case when kind::text like 'case%' then 'cases' else 'files' end)
  );

drop policy if exists files_all on files;
create policy files_all on files
  for all to authenticated
  using (exists (
    select 1 from file_rows fr
     where fr.id = files.file_row_id
       and record_visible(fr.record_id)
       and tab_visible(fr.record_id, case when fr.kind::text like 'case%' then 'cases' else 'files' end)
  ));

-- Updates, and their mentions.
drop policy if exists updates_all on updates;
create policy updates_all on updates
  for all to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'updates'))
  with check (record_visible(record_id) and tab_visible(record_id, 'updates'));

drop policy if exists update_mentions_all on update_mentions;
create policy update_mentions_all on update_mentions
  for all to authenticated
  using (exists (
    select 1 from updates u
     where u.id = update_mentions.update_id
       and record_visible(u.record_id)
       and tab_visible(u.record_id, 'updates')
  ));

-- Custom entries live on the Other tab.
drop policy if exists record_custom_entries_all on record_custom_entries;
create policy record_custom_entries_all on record_custom_entries
  for all to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'other'))
  with check (record_visible(record_id) and tab_visible(record_id, 'other'));

-- Messages are the Communication tab.
drop policy if exists messages_select on messages;
create policy messages_select on messages
  for select to authenticated
  using (record_visible(record_id) and tab_visible(record_id, 'communication'));

/*
 * Notes are scoped to a TAB or a FIELD, so the note's own scope decides. A
 * field-scoped note is governed by the tab that field sits on.
 *
 * `coalesce(..., true)` is deliberate: a note whose scope row has since been
 * deleted must not become invisible to everyone, because the note is the thing
 * with the content and record visibility still gates it.
 */
drop policy if exists notes_all on notes;
create policy notes_all on notes
  for all to authenticated
  using (
    record_visible(record_id)
    and coalesce(
      case notes.scope_kind::text
        -- ⚠ `notes.scope_id` is TEXT, not uuid — it holds either a tab id or a
        -- field id as a string. Compared as text on both sides rather than
        -- cast to uuid, so a malformed value can never raise 22P02 inside a
        -- policy, which would fail the whole query rather than the row.
        when 'tab' then (
          select tab_visible(notes.record_id, t.key::text)
            from tabs t where t.id::text = notes.scope_id
        )
        when 'field' then (
          select tab_visible(notes.record_id, t.key::text)
            from fields f join tabs t on t.id = f.tab_id
           where f.id::text = notes.scope_id
        )
      end,
      true
    )
  )
  with check (record_visible(record_id));
