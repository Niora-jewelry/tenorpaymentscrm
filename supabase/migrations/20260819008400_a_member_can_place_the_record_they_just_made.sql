-- =============================================================================
-- Part 84: a member could not create a record at all.
--
-- ── THE SEQUENCE ─────────────────────────────────────────────────────────
-- `createRecord` inserts the row and THEN places it in its modules, because a
-- record's module membership lives in `record_modules` and there is nothing to
-- reference until the record exists:
--
--   insert into records ...                       -- 201
--   select set_record_memberships(id, '{leads}')  -- ERROR: not found
--
-- `set_record_memberships` opens with `record_visible()`, and since migration
-- 74 that means `can_see_record() AND record_module_visible()` — where
-- `record_module_visible` requires at least one non-admin-only module whose
-- grant is not Hidden. A record one statement old is in NO module, so it is
-- invisible to its own creator, and placing it was refused.
--
-- Admins never saw this: `record_module_visible` short-circuits on
-- `auth_is_admin()`. It only ever failed for members, which is why it survived
-- — and it failed AFTER the insert, so every attempt left an orphan record in
-- no module, visible only through the admin-only Records List.
--
-- Found while testing migration 83's guards, by running the create flow as a
-- real member rather than reasoning about it.
--
-- ── THE NARROWEST BRANCH THAT FIXES IT ───────────────────────────────────
-- "No modules" is ALSO what an archived record looks like, and un-archiving is
-- an admin action from the Records List — not something a member may do by
-- calling this RPC on any archived record they happen to be a team member of.
-- So the exemption is not "a record with no modules"; it is:
--
--   * the caller can see it, and
--   * the caller CREATED it, and
--   * it has never been in a module — no `membership` activity has ever been
--     written for it.
--
-- An archived record fails the third test: archiving writes a membership row
-- ("Archived — no longer displayed in any module"), so its history is never
-- empty. That leaves exactly one thing this branch admits — a record between
-- its INSERT and its first placement — and nothing else.
--
-- Everything migration 81 added still applies underneath: the module being
-- added must still be one the caller holds Edit on, which is what stops a new
-- record being filed somewhere its creator cannot go.
-- =============================================================================

create or replace function public.set_record_memberships(p_record_id uuid, p_module_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_had_any   boolean;
  v_ever_had  boolean;
  v_is_fresh  boolean;
  v_ids       uuid[] := coalesce(p_module_ids, '{}');
  v_mod       record;
begin
  select exists(select 1 from record_modules where record_id = p_record_id) into v_had_any;

  select exists(
    select 1 from record_activity ra
     where ra.record_id = p_record_id and ra.kind = 'membership'
  ) into v_ever_had;

  -- A record between its INSERT and its first placement, being placed by the
  -- person who made it. See the header: an archived record cannot reach this,
  -- because archiving leaves a `membership` row behind.
  v_is_fresh := not v_had_any
            and not v_ever_had
            and exists (
                  select 1 from records r
                   where r.id = p_record_id
                     and r.deleted_at is null
                     and r.creator_user_id = auth.uid()
                );

  if not (record_visible(p_record_id) or (v_is_fresh and can_see_record(p_record_id))) then
    raise exception 'not found';
  end if;

  if not auth_is_admin() then
    if v_had_any and not record_module_editable(p_record_id) then
      raise exception 'You do not have edit access to this record.'
        using errcode = '42501';
    end if;

    -- Every module ADDED or REMOVED needs Edit on that module. Modules left
    -- untouched are deliberately not checked.
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
