-- =============================================================================
-- A record with an open case is shown in the module that holds open cases;
-- a record with no open case is not.
--
-- Client, 16 Oct 2026 (Addition 3):
--   "If a record has an open case it should automatically be in the tickets
--    section. If a record has no open cases then the record should not
--    display in the tickets section."
--
-- ── NO CODE NAMES A MODULE ───────────────────────────────────────────────
-- CLAUDE.md §1. The behaviour hangs off a flag on `modules`, `shows_open_cases`,
-- and this migration sets it on the Tickets row the same way the seed named
-- it: as configuration. Nothing in the functions below knows the word
-- "tickets"; flag a seventh module and it behaves the same way.
--
-- ── A FLAGGED MODULE IS AUTOMATIC, NOT A CHOICE ──────────────────────────
-- The second sentence is as binding as the first. If people could add a record
-- to the flagged module by hand, a record with no open case would be displayed
-- there — exactly what the client ruled out. So membership of a flagged module
-- is owned entirely by the cases table:
--
--   * `sync_open_case_memberships(record)` makes the record's membership of
--     every flagged module equal to "has at least one open, undeleted case".
--     It runs from a trigger on `cases` for every insert, every change of
--     state or deletion, and every hard delete.
--   * `set_record_memberships` — the one writer every chip, archive and bulk
--     action goes through — leaves flagged modules exactly as they are. A
--     caller asking to add or drop one is neither refused nor obeyed: the
--     request is simply about the other modules. The drawer renders the chip
--     as an indicator for the same reason.
--
-- Archive therefore means "removed from every module a person can choose".
-- A record archived while a case is open stays in the flagged module until
-- the case is closed, and the activity log says so.
--
-- ── BACKFILL ─────────────────────────────────────────────────────────────
-- The rule is a statement about state, so it is applied to today's data too:
-- every record with an open case is placed, every record in a flagged module
-- without one is removed. Run on 16 Oct this places three archived demo
-- records that carry open demo cases; closing those cases removes them again.
-- Nothing is deleted.
-- =============================================================================

alter table modules
  add column if not exists shows_open_cases boolean not null default false;

comment on column modules.shows_open_cases is
  'A record is a member of this module exactly while it has an open case. Membership is maintained by the cases trigger and cannot be set by hand.';

-- Configuration, not code: the seed named this module the same way.
update modules set shows_open_cases = true where slug = 'tickets';


-- ── THE SYNC ─────────────────────────────────────────────────────────────
-- SECURITY DEFINER: it runs inside a trigger fired by whoever touched the
-- case, and that person may hold no module grant at all on the flagged module
-- — a rep closing a case on the Cases tab must still take the record out of
-- Tickets. `search_path` pinned per CLAUDE.md §8.
create or replace function public.sync_open_case_memberships(p_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_open   boolean;
  v_alive  boolean;
  v_mod    record;
begin
  select exists (
    select 1 from records r where r.id = p_record_id and r.deleted_at is null
  ) into v_alive;
  -- A record in the Recycle Bin holds no memberships (delete_record refuses
  -- otherwise); its cases are not a reason to put any back.
  if not v_alive then return; end if;

  select exists (
    select 1 from cases c
     where c.record_id = p_record_id
       and c.state = 'open'
       and c.deleted_at is null
  ) into v_open;

  for v_mod in select m.id, m.label from modules m where m.shows_open_cases loop
    if v_open then
      insert into record_modules (record_id, module_id, added_by)
      values (p_record_id, v_mod.id, auth.uid())
      on conflict (record_id, module_id) do nothing;
      if found then
        insert into record_activity (record_id, actor_id, kind, summary)
        values (p_record_id, auth.uid(), 'membership',
                format('Shown in %s — a case is open', v_mod.label));
      end if;
    else
      delete from record_modules
       where record_id = p_record_id and module_id = v_mod.id;
      if found then
        insert into record_activity (record_id, actor_id, kind, summary)
        values (p_record_id, auth.uid(), 'membership',
                format('Removed from %s — no open cases', v_mod.label));
      end if;
    end if;
  end loop;
end;
$$;

revoke execute on function public.sync_open_case_memberships(uuid) from public, anon, authenticated;

create or replace function public.cases_sync_open_case_memberships()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform sync_open_case_memberships(coalesce(new.record_id, old.record_id));
  return null;
end;
$$;

drop trigger if exists cases_place_record_by_open_case on cases;
create trigger cases_place_record_by_open_case
  after insert or update of state, deleted_at or delete on cases
  for each row execute function cases_sync_open_case_memberships();


-- ── THE WRITER LEAVES FLAGGED MODULES ALONE ──────────────────────────────
-- Same function as migration 84, with one addition: the set of flagged module
-- ids is removed from the request and from the delete, so a caller can
-- neither add nor remove one. The permission loop runs only over modules the
-- caller is actually changing, as before. "Archived" is now judged on the
-- record's memberships AFTER the write, since a flagged membership may
-- legitimately remain.
create or replace function public.set_record_memberships(p_record_id uuid, p_module_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_had_any   boolean;
  v_has_now   boolean;
  v_ever_had  boolean;
  v_is_fresh  boolean;
  v_auto      uuid[];
  v_ids       uuid[];
  v_mod       record;
begin
  select coalesce(array_agg(m.id), '{}') into v_auto from modules m where m.shows_open_cases;

  -- Flagged modules are not the caller's to set.
  select coalesce(array_agg(x), '{}') into v_ids
    from unnest(coalesce(p_module_ids, '{}')) as x
   where x <> all (v_auto);

  select exists(select 1 from record_modules where record_id = p_record_id) into v_had_any;

  select exists(
    select 1 from record_activity ra
     where ra.record_id = p_record_id and ra.kind = 'membership'
  ) into v_ever_had;

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

    for v_mod in
      select m.id, m.label
        from modules m
       where m.id <> all (v_auto)
         and (m.id = any (v_ids))
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


-- ── BACKFILL: TODAY'S DATA OBEYS THE RULE ────────────────────────────────
do $$
declare r record;
begin
  for r in
    select distinct c.record_id as id from cases c
     union
    select rm.record_id from record_modules rm join modules m on m.id = rm.module_id where m.shows_open_cases
  loop
    perform sync_open_case_memberships(r.id);
  end loop;
end $$;
