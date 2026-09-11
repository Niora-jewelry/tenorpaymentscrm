-- =============================================================================
-- Part 67: make the Files / Cases / Statements TAB GRANT reach the bytes.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────
-- The bucket's four policies all ask the same single question:
--
--     can_see_record((storage.foldername(name))[1]::uuid)
--
-- Record visibility, and nothing else. So every tab grant over documents was
-- enforced where the LIST is rendered and nowhere near the file itself.
-- Someone holding Statements = Hidden on a record they can otherwise see was
-- one request away from every processing statement on it.
--
-- That was reachable, not theoretical. `getFileUrlAction` and
-- `getStatementUrlAction` took a storage path FROM THE BROWSER and signed it;
-- both `signedUrlFor` and `signedStatementUrlFor` marked their context `_ctx`
-- because neither read it. The caller chose the file, across every kind, and
-- this policy was the only thing in the way.
--
-- The application side is fixed in the same change: those functions now take
-- the file's ID, resolve the path themselves, and call `requireTabView` with
-- the tab the row actually belongs to. This migration is the second layer, and
-- the one that holds if a third caller appears — per CLAUDE.md, a rule that
-- must not break belongs in the database as well as the code.
--
-- ── THE PATH IS THE SCOPE ────────────────────────────────────────────────
-- Uploads write `<record>/<kind>/<row>/<file>`, so segment 2 says which tab
-- governs the object:
--
--     application, other   -> the Files tab
--     case                 -> the Cases tab   (an attachment is an ordinary
--                             file row, but Cases is what governs it — the
--                             same split `uploadFile` already makes)
--     statements           -> the Statements tab
--
-- Anything else resolves to Files, which is the most restrictive sensible
-- default rather than an open one.
--
-- ── HOW THE LEVEL IS WORKED OUT ──────────────────────────────────────────
-- Mirrors `lib/records/tabAccess.ts` exactly, because two different answers to
-- the same question is worse than either answer alone:
--
--   • an admin short-circuits to Edit;
--   • otherwise the module ceiling is the HIGHEST grant the viewer holds over
--     any module the record is displayed in — a record in both Leads and Deals
--     is one record, and Edit on either is Edit on it;
--   • admin-only modules (the Records List) never contribute a ceiling to a
--     non-admin;
--   • the tab grant is then capped by that ceiling, narrower never widening.
--
-- A record in no module at all resolves to Hidden, which is right: it is
-- archived, it lives only in the admin-only Records List, and an admin never
-- reaches this branch.
--
-- ⚠️ `can_see_record` is KEPT in every policy. This is an additional
-- condition, not a replacement — visibility and tab permission are different
-- questions and the spec answers them separately.
-- =============================================================================

create or replace function storage_tab_access(rec uuid, kind_segment text)
returns permission_level
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then 'edit'::permission_level
    else least(
      -- Module ceiling: the best grant over any module the record is shown in.
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
      -- The tab that governs this kind of object.
      effective_grant(
        auth.uid(),
        'tab',
        (
          select t.id
            from tabs t
           where t.key = case kind_segment
                           when 'case'       then 'cases'
                           when 'statements' then 'statements'
                           else                   'files'
                         end
        )
      )
    )
  end;
$$;

revoke execute on function storage_tab_access(uuid, text) from public, anon;
grant execute on function storage_tab_access(uuid, text) to authenticated, service_role;

-- ── The four policies, rebuilt ───────────────────────────────────────────
-- Reading needs View or better; writing needs Edit. Dropped and recreated
-- rather than altered so the whole predicate is visible in one place here.

drop policy if exists records_bucket_select on storage.objects;
create policy records_bucket_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'records'
    and can_see_record((storage.foldername(name))[1]::uuid)
    and storage_tab_access((storage.foldername(name))[1]::uuid, (storage.foldername(name))[2]) <> 'hidden'
  );

drop policy if exists records_bucket_insert on storage.objects;
create policy records_bucket_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'records'
    and can_see_record((storage.foldername(name))[1]::uuid)
    and storage_tab_access((storage.foldername(name))[1]::uuid, (storage.foldername(name))[2]) = 'edit'
  );

drop policy if exists records_bucket_update on storage.objects;
create policy records_bucket_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'records'
    and can_see_record((storage.foldername(name))[1]::uuid)
    and storage_tab_access((storage.foldername(name))[1]::uuid, (storage.foldername(name))[2]) = 'edit'
  );

drop policy if exists records_bucket_delete on storage.objects;
create policy records_bucket_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'records'
    and can_see_record((storage.foldername(name))[1]::uuid)
    and storage_tab_access((storage.foldername(name))[1]::uuid, (storage.foldername(name))[2]) = 'edit'
  );
