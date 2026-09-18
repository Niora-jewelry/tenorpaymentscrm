-- =============================================================================
-- Part 81: writing a record needs EDIT, not merely being able to see it.
--
-- ── WHAT WAS WRONG, AND HOW IT WAS FOUND ─────────────────────────────────
-- Found by signing in as a real member and calling PostgREST directly with
-- their own token. A user holding Tickets = View rewrote a Tickets record:
--
--   PATCH /rest/v1/records?id=eq.<a Tickets record>
--   {"deal_name":"PWNED-VIEW-ONLY"}                            -> 200, 1 row
--
-- The policy was:
--
--   records_update USING (deleted_at IS NULL
--                     AND can_see_record(id)
--                     AND record_module_visible(id))
--
-- `record_module_visible` asks "is this grant something other than hidden".
-- VIEW passes it. So View meant read-only in the UI and in every server
-- action, and meant nothing at all in the database — which is the boundary
-- the specification says is the real one ("UI-level hiding is never the
-- security boundary").
--
-- Through the `values` column the same request could overwrite a field the
-- viewer is not allowed to READ, and because `sync_record_team_members()`
-- fires on `UPDATE OF values`, it could also rewrite the record's team — the
-- set of people who can see it — by writing `team_members_assigned`.
--
-- ── WHY THIS REVOKES UPDATE INSTEAD OF NARROWING THE POLICY ──────────────
-- Every record write in this codebase already goes through a SECURITY DEFINER
-- function — `set_record_value`, `set_record_values`, `bulk_set_values`,
-- `delete_record`, `restore_record`, `purge_record`. All eight writers were
-- checked: all are DEFINER, all owned by `postgres`, so none of them consults
-- the caller's table privileges and none is affected by this.
--
-- Direct UPDATE by `authenticated` is therefore used by NOTHING. A narrowed
-- policy would leave a second, unguarded path into the table that happens to
-- be closed today; revoking the privilege removes the path. Anything that
-- needs it later fails loudly at the query instead of silently skipping the
-- history, the activity log and the compare-and-swap that the RPCs provide.
--
-- ⚠ THE COLUMN-LEVEL REVOKE IS NOT REDUNDANT. `REVOKE UPDATE ON records`
-- removes the table-level privilege and leaves per-column grants standing —
-- the same asymmetry that made migration 75 apply cleanly and change nothing.
-- Both halves, or this does not hold.
-- =============================================================================


-- ── Does this viewer hold Edit on a module this record is displayed in? ───
-- Mirrors `record_module_visible`, one level stricter. Admin-only modules are
-- excluded for non-admins on purpose: the Records List is not a route by which
-- a member acquires write access to anything.
create or replace function public.record_module_editable(rec uuid)
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
       and effective_grant(auth.uid(), 'module'::grant_scope, rm.module_id, null) = 'edit'
  );
$$;

revoke execute on function public.record_module_editable(uuid) from public, anon;
grant execute on function public.record_module_editable(uuid) to authenticated, service_role;


-- ── Does this viewer hold Edit on one specific module? ────────────────────
create or replace function public.module_editable(p_module uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_is_admin() then true
    else exists (
      select 1
        from modules m
       where m.id = p_module
         and not m.admin_only
         and effective_grant(auth.uid(), 'module'::grant_scope, m.id, null) = 'edit'
    )
  end;
$$;

revoke execute on function public.module_editable(uuid) from public, anon;
grant execute on function public.module_editable(uuid) to authenticated, service_role;


-- ── No direct UPDATE of a record by a signed-in user, at all ──────────────
drop policy if exists records_update on public.records;

revoke update on table public.records from authenticated;
revoke update (
  id, deal_name, "values", creator_kind, creator_user_id, creator_campaign_id,
  created_at, updated_at, deleted_at
) on table public.records from authenticated;


-- =============================================================================
-- INSERT had `WITH CHECK (true)`, which is not a gate.
--
-- What stopped a member inserting an arbitrary record today was the
-- `creator_matches_kind` CHECK constraint refusing a malformed creator — a
-- shape problem, not a permission. Supplying a well-formed creator got past it.
--
-- Creation stays open, because members are supposed to create records; it now
-- has to look like a real creation by the person making it, and the person has
-- to hold Edit on at least one display module. Someone with no Edit anywhere
-- has nowhere to put a record and cannot make one.
--
-- The module a record lands in is NOT checked here and cannot be: the row is
-- inserted before any `record_modules` row exists (`createRecord` inserts,
-- then calls `set_record_memberships`). That second call is where the module
-- is checked, by the guard added below.
-- =============================================================================

drop policy if exists records_insert on public.records;

create policy records_insert on public.records
  for insert to authenticated
  with check (
    creator_kind = 'user'
    and creator_user_id = auth.uid()
    and (
      auth_is_admin()
      or exists (
        select 1
          from modules m
         where not m.admin_only
           and effective_grant(auth.uid(), 'module'::grant_scope, m.id, null) = 'edit'
      )
    )
  );

-- `createRecord` sets id, deal_name, creator_kind, creator_user_id and values,
-- and nothing else. The rest have defaults and no legitimate caller-supplied
-- value, so a client that sends one is either confused or probing — either way
-- the answer is no. `deleted_at` is the one that matters: settable at INSERT,
-- it is a record born in the Recycle Bin.
revoke insert (created_at, updated_at, deleted_at, creator_campaign_id)
  on table public.records from authenticated;


-- =============================================================================
-- Module membership was guarded by `record_visible()` and nothing else.
--
-- So anyone who could SEE a record could move it between modules: into a
-- module hidden to them, or into none at all — which is Archive, and removes
-- the record from every colleague's dashboard. A member holding Tickets = View
-- could archive a record out of the whole CRM.
--
-- Two checks, and the split matters:
--
--   1. A record already displayed somewhere needs Edit ON THE RECORD.
--      Skipped when the record is in no module yet, which is not a loophole
--      but the ordinary state of a record one statement old — `createRecord`
--      inserts and then calls this. There is nothing to hold access to yet,
--      and check 2 still governs where it may go.
--
--   2. Every module ADDED OR REMOVED needs Edit on THAT module. Adding a
--      record to Deals is a change to Deals.
--
-- Modules left untouched are deliberately not checked: archiving a record out
-- of Leads should not be blocked because it also sits in a module the viewer
-- cannot see, since that membership is not being altered.
--
-- `module_editable` refuses admin-only modules for non-admins, so this is also
-- what stops a member filing a record into the Records List.
-- =============================================================================

create or replace function public.set_record_memberships(p_record_id uuid, p_module_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_had_any boolean;
  v_ids uuid[] := coalesce(p_module_ids, '{}');
  v_mod record;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  select exists(select 1 from record_modules where record_id = p_record_id) into v_had_any;

  if not auth_is_admin() then
    if v_had_any and not record_module_editable(p_record_id) then
      raise exception 'You do not have edit access to this record.'
        using errcode = '42501';
    end if;

    for v_mod in
      select m.id, m.label
        from modules m
       where (m.id = any (v_ids))
             is distinct from
             (exists (select 1
                        from record_modules rm
                       where rm.record_id = p_record_id
                         and rm.module_id = m.id))
    loop
      if not module_editable(v_mod.id) then
        raise exception 'You do not have edit access to %.', v_mod.label
          using errcode = '42501';
      end if;
    end loop;
  end if;

  delete from record_modules
   where record_id = p_record_id and module_id <> all (v_ids);

  insert into record_modules (record_id, module_id, added_by)
  select p_record_id, m, auth.uid()
    from unnest(v_ids) as m
  on conflict (record_id, module_id) do nothing;

  if v_had_any and coalesce(array_length(p_module_ids, 1), 0) = 0 then
    insert into record_activity (record_id, actor_id, kind, summary)
    values (p_record_id, auth.uid(), 'membership', 'Archived — no longer displayed in any module');
  else
    insert into record_activity (record_id, actor_id, kind, summary)
    values (p_record_id, auth.uid(), 'membership', 'Module membership updated');
  end if;
end;
$function$;
