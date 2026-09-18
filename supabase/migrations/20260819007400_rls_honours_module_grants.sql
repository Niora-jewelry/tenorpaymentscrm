-- =============================================================================
-- Part 74: a hidden MODULE now hides its records from the API too.
--
-- ── MEASURED ─────────────────────────────────────────────────────────────
-- Migration 72/73 closed tab grants. The level above them was still open. A
-- signed-in user with Leads = Hidden, using the session token any browser
-- holds:
--
--   GET /rest/v1/records?select=deal_name
--     -> 200 [{"deal_name":"Lakeside Marine Supply"}]
--
-- Leads hidden, the record still readable. The sidebar correctly refused to
-- list the module and `[module]/page.tsx` correctly redirects a hidden module
-- to the dashboard — but the row itself was never protected, because the
-- `records` policy asked `can_see_record()` (team membership) and nothing
-- about modules.
--
-- ── THE RULE, MATCHING lib/records/tabAccess.ts ──────────────────────────
-- A record is readable when the viewer holds at least View on ANY module it is
-- displayed in. Highest-wins is deliberate and already the app's rule: a record
-- shown in both Leads and Deals is ONE record, so being able to see either
-- module is being able to see it.
--
-- ⚠ ADMIN-ONLY MODULES NEVER COUNT. The Records List is `admin_only`, and
-- every record is in it. Counting it would make this test pass for everyone and
-- change nothing.
--
-- ⚠ A RECORD IN NO MODULE IS ARCHIVED, and therefore invisible to non-admins.
-- That is correct rather than incidental: archiving means "removed from every
-- display module", the archived record lives only in the admin-only Records
-- List, and an admin short-circuits on the first line anyway.
-- =============================================================================

create or replace function public.record_module_visible(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth_is_admin() or exists (
    select 1
      from record_modules rm
      join modules m on m.id = rm.module_id
     where rm.record_id = rec
       and not m.admin_only
       and effective_grant(auth.uid(), 'module', rm.module_id) <> 'hidden'
  );
$$;

revoke execute on function public.record_module_visible(uuid) from public, anon;
grant execute on function public.record_module_visible(uuid) to authenticated, service_role;


/*
 * Folded into `record_visible()` rather than added to each policy.
 *
 * Every per-record policy in this schema already calls `record_visible()` —
 * logins, cases, files, updates, notes, messages, custom entries and the
 * records table itself. Putting the module test inside it means the rule
 * arrives everywhere at once and cannot be forgotten by the next table, which
 * is exactly how tab grants came to be missing from nine tables.
 */
create or replace function public.record_visible(rec uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from records r where r.id = rec and r.deleted_at is null
  )
  and can_see_record(rec)
  and record_module_visible(rec);
$$;


/*
 * The `records` table's own policy has to gain it explicitly: it is written
 * against `can_see_record()` directly, not `record_visible()`.
 */
drop policy if exists records_select on records;
create policy records_select on records
  for select to authenticated
  using (deleted_at is null and can_see_record(id) and record_module_visible(id));

/*
 * And the UPDATE policy, for the same reason — enumerated rather than guessed
 * at, after migration 73 was needed because two permissive policies on `logins`
 * went unnoticed and kept the row readable. `records` carries three:
 * records_insert (true — creation is gated in the service layer), and these two.
 */
drop policy if exists records_update on records;
create policy records_update on records
  for update to authenticated
  using (deleted_at is null and can_see_record(id) and record_module_visible(id));
