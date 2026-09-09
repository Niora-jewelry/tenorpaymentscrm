-- =============================================================================
-- Module 2 — Part 55: removing a user, in the three levels the client specified.
--
-- ── THE REQUIREMENT ──────────────────────────────────────────────────────
-- Admin Plan §2.1: "Remove users — three levels: **Pause** … **Soft delete** —
-- the user moves to the Recycle Bin and is restorable … **Full delete** —
-- permanent removal.
--
--   Forced reassignment: before a soft or full delete can proceed, the admin
--   must complete a reassignment flow covering every record on which the
--   departing user is the Team member (a bulk 'reassign all of X's records
--   to …' action). A delete is blocked until reassignment is complete."
--
-- Only Pause existed. There was no way to offboard anyone, and no reassignment
-- flow at all.
--
-- ── WHY THE BLOCK IS THE POINT ───────────────────────────────────────────
-- Team member is the ONLY field that grants record visibility (Admin §2.3).
-- Deleting the last Team member on a record therefore makes that record
-- invisible to every non-admin in the company — silently, and with no error,
-- because an empty team is a legal state. That is the exact accident the
-- forced-reassignment rule exists to prevent, so it is enforced HERE, in the
-- database, rather than as a step the interface asks nicely for.
--
-- `count_user_records` is what the interface counts with, and
-- `soft_delete_user` re-counts at write time rather than trusting the number it
-- was shown — the same shape `assignTemplate` already uses for its own
-- destructive confirmation.
--
-- ── REASSIGNMENT REWRITES THE FIELD, NOT A JOIN TABLE ────────────────────
-- `record_team_members` is a trigger-maintained projection of
-- `values->'team_members_assigned'`; writing it directly would be overwritten
-- by the next value edit. So the reassignment edits the JSONB field, and the
-- trigger follows. Each record's change is activity-logged individually,
-- because "who could see this record" changing is exactly what the log is for.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- How many records would be orphaned by removing this user.
-- -----------------------------------------------------------------------------
create or replace function count_user_records(p_user uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
    from records r
   where r.deleted_at is null
     and r.values -> 'team_members_assigned' @> to_jsonb(p_user::text);
$$;

-- -----------------------------------------------------------------------------
-- Bulk reassignment: replace one team member with another, everywhere.
-- -----------------------------------------------------------------------------
create or replace function reassign_user_records(p_from uuid, p_to uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rec   record;
  v_next  jsonb;
  v_count bigint := 0;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_from = p_to then
    raise exception 'Choose a different person to reassign to' using errcode = '23514';
  end if;
  if not exists (select 1 from profiles where id = p_to and status = 'active' and deleted_at is null) then
    raise exception 'That person is not an active user' using errcode = '23503';
  end if;

  for v_rec in
    select id, deal_name, values -> 'team_members_assigned' as team
      from records
     where deleted_at is null
       and values -> 'team_members_assigned' @> to_jsonb(p_from::text)
  loop
    -- Remove the departing user, add the replacement, and keep the result
    -- distinct so a record that already had both does not end up with a
    -- duplicate id in its team.
    -- The set-returning call sits in FROM, not WHERE: Postgres rejects an SRF
    -- in a WHERE clause outright (0A000), and expanding it once in FROM is
    -- also the only form that evaluates the array a single time.
    select coalesce(jsonb_agg(distinct s.x), '[]'::jsonb) into v_next
      from (
        select t.x
          from jsonb_array_elements_text(v_rec.team) as t(x)
         where t.x <> p_from::text
        union
        select p_to::text
      ) s(x);

    update records
       set values = jsonb_set(values, '{team_members_assigned}', v_next, true),
           updated_at = now()
     where id = v_rec.id;

    insert into record_activity (record_id, actor_id, kind, field_key, summary, from_value, to_value)
    values (v_rec.id, auth.uid(), 'field', 'team_members_assigned',
            'Team member reassigned during offboarding',
            v_rec.team #>> '{}', v_next #>> '{}');

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Soft delete → Recycle Bin. Blocked until reassignment is complete.
-- -----------------------------------------------------------------------------
create or replace function soft_delete_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_left  bigint;
  v_email text;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = '23514';
  end if;

  select email into v_email from profiles where id = p_user and deleted_at is null;
  if v_email is null then
    raise exception 'not found';
  end if;

  -- Re-counted at write time, never trusted from the caller.
  v_left := count_user_records(p_user);
  if v_left > 0 then
    raise exception
      'Reassign this user''s % record(s) before deleting them', v_left
      using errcode = '23514';
  end if;

  update profiles
     set deleted_at = now(),
         status = 'suspended',
         -- Every existing session dies with the account, the same lever
         -- `pauseUser` already pulls.
         sessions_valid_from = now()
   where id = p_user;

  -- Columns are event_type/metadata (migration 1), and the table is
  -- append-only at the database, so this entry cannot later be tidied away.
  insert into auth_audit_log (actor_id, event_type, email_attempted, metadata)
  values (auth.uid(), 'user_soft_deleted', v_email, jsonb_build_object('user_id', p_user));
end;
$$;

create or replace function restore_user(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_email text;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  select email into v_email from profiles where id = p_user and deleted_at is not null;
  if v_email is null then
    raise exception 'not found';
  end if;

  -- Comes back SUSPENDED, not active. Restoring an account and silently
  -- re-enabling sign-in are two decisions, and an admin should make the second
  -- one deliberately with Resume.
  update profiles set deleted_at = null, status = 'suspended' where id = p_user;

  insert into auth_audit_log (actor_id, event_type, email_attempted, metadata)
  values (auth.uid(), 'user_restored', v_email, jsonb_build_object('user_id', p_user));
end;
$$;

revoke execute on function count_user_records(uuid)      from public;
revoke execute on function reassign_user_records(uuid, uuid) from public;
revoke execute on function soft_delete_user(uuid)        from public;
revoke execute on function restore_user(uuid)            from public;
grant  execute on function count_user_records(uuid)      to authenticated;
grant  execute on function reassign_user_records(uuid, uuid) to authenticated;
grant  execute on function soft_delete_user(uuid)        to authenticated;
grant  execute on function restore_user(uuid)            to authenticated;

comment on function reassign_user_records(uuid, uuid) is
  'Replaces one Team member with another across every record they are on. '
  'Writes the JSONB field, not record_team_members — that table is a '
  'trigger-maintained projection and a direct write would be overwritten.';
