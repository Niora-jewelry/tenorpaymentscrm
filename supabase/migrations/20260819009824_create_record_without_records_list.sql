-- =============================================================================
-- Sales agents and Underwriters could not create records.
--
-- Both have "Create new records" = Yes. createRecord inserts the row, then
-- places it with set_record_memberships. Since migration 9811 that refused a
-- fresh record with "not found": it asked can_see_record(), and a record in
-- no module is reachable only through the Records List, which is Hidden for
-- those types. (Admin and Super admin have the Records List, so testing as
-- them never showed it.)
--
-- The creator of a fresh record may now place it, into display modules they
-- can open — never into one Hidden to them, so the record cannot be created
-- out of its creator's sight. Everything else in the function is unchanged.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_record_memberships(p_record_id uuid, p_module_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_had_any   boolean;
  v_has_now   boolean;
  v_ever_had  boolean;
  v_is_fresh  boolean;
  v_auto      uuid[];
  v_ids       uuid[];
  v_mod       record;
begin
  -- Modules that show open cases (Tickets) are automatic: never set by hand.
  select coalesce(array_agg(m.id), '{}') into v_auto from modules m where m.shows_open_cases;
  select coalesce(array_agg(x), '{}') into v_ids
    from unnest(coalesce(p_module_ids, '{}')) as x
   where x <> all (v_auto);

  select exists(select 1 from record_modules where record_id = p_record_id) into v_had_any;
  select exists(select 1 from record_activity ra where ra.record_id = p_record_id and ra.kind = 'membership')
    into v_ever_had;
  -- A record its creator just made, getting its first modules.
  v_is_fresh := not v_had_any and not v_ever_had
            and exists (select 1 from records r
                         where r.id = p_record_id and r.deleted_at is null and r.creator_user_id = auth.uid());

  -- A fresh record is in no module yet, so only the Records List could show
  -- it — and most user types have that Hidden. Its own creator may still
  -- place it; the modules they pick are checked below.
  if not (record_visible(p_record_id) or v_is_fresh) then
    raise exception 'not found';
  end if;

  if not auth_is_admin() then
    if v_is_fresh then
      if auth_perm('action.create') <> 'yes' then
        raise exception 'You cannot create records.' using errcode = '42501';
      end if;
      -- Only into display modules they can open, so a new record is never
      -- created out of its creator's own sight.
      for v_mod in select m.id, m.label, m.kind from modules m where m.id = any (v_ids) loop
        if v_mod.kind <> 'display' or coalesce(user_module_scope(auth.uid(), v_mod.id), 'hidden') = 'hidden' then
          raise exception 'You cannot create records in %.', v_mod.label using errcode = '42501';
        end if;
      end loop;
    elsif v_had_any and cardinality(v_ids) = 0
          and not exists (select 1 from record_modules rm where rm.record_id = p_record_id and rm.module_id = any (v_auto)) then
      -- Out of its last module: that is archiving.
      if auth_perm('action.archive') <> 'yes' then
        raise exception 'You do not have permission to archive records.' using errcode = '42501';
      end if;
    else
      for v_mod in
        select m.id, m.label
          from modules m
         where m.id <> all (v_auto)
           and (m.id = any (v_ids))
               is distinct from
               (exists (select 1 from record_modules rm where rm.record_id = p_record_id and rm.module_id = m.id))
      loop
        if not module_membership_allowed(v_mod.id) then
          raise exception 'You cannot add records to or remove them from %.', v_mod.label
            using errcode = '42501';
        end if;
      end loop;
    end if;
  end if;

  delete from record_modules
   where record_id = p_record_id
     and module_id <> all (v_ids)
     and module_id <> all (v_auto);
  insert into record_modules (record_id, module_id, added_by)
  select p_record_id, m, auth.uid()
    from unnest(v_ids) as m
  on conflict (record_id, module_id) do nothing;

  select exists(select 1 from record_modules where record_id = p_record_id) into v_has_now;
  if v_had_any and not v_has_now then
    insert into record_activity (record_id, actor_id, kind, summary)
    values (p_record_id, auth.uid(), 'membership', 'Archived — no longer displayed in any module');
  else
    insert into record_activity (record_id, actor_id, kind, summary)
    values (p_record_id, auth.uid(), 'membership', 'Module membership updated');
  end if;
end;
$function$;
