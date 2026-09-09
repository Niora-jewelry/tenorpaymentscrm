-- =============================================================================
-- Module 2 — Part 34: @mentions + notifications — the primitives existed
-- (`update_mentions`, `notifications`, `notify()`, migrations 4/11) but
-- nothing ever called them. This is that wiring, as its own atomic RPC —
-- `notify()` itself has no grant to anyone (migration 22: "if it ever gains
-- a caller it should be through a wrapper that validates first"), so posting
-- an update with mentions needs a purpose-built function, the same shape as
-- every other combined write this build already uses (record_file_upload,
-- set_case_solution, etc).
--
-- record_team_member_ids() exists for the same reason profile_names() does:
-- `record_team_members`' own RLS (`user_id = auth.uid() or auth_is_admin()`)
-- only lets a regular user see THEIR OWN membership row, not the full
-- roster — so there was no way for the client to even list who's on a
-- record's team to offer as @mention targets. Returns bare ids; names come
-- from the existing profile_names().
-- =============================================================================

create or replace function record_team_member_ids(p_record_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(user_id), '{}')
    from record_team_members
   where record_id = p_record_id and record_visible(p_record_id);
$$;

-- Only ever notifies/records a mention for someone actually on the record's
-- team — an arbitrary id passed in never creates a fake notification, and
-- mentioning yourself never self-notifies.
create or replace function add_update_with_mentions(
  p_record_id           uuid,
  p_body                text,
  p_parent_id           uuid,
  p_mentioned_user_ids  uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_update_id      uuid;
  v_valid_mentions uuid[];
  v_mentioned      uuid;
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;

  if p_parent_id is not null and not exists (
    select 1 from updates where id = p_parent_id and record_id = p_record_id and parent_id is null
  ) then
    raise exception 'invalid parent update';
  end if;

  insert into updates (record_id, parent_id, author_id, body)
  values (p_record_id, p_parent_id, auth.uid(), p_body)
  returning id into v_update_id;

  select array_agg(distinct m.user_id) into v_valid_mentions
    from unnest(coalesce(p_mentioned_user_ids, '{}')) as m(user_id)
    join record_team_members rtm on rtm.record_id = p_record_id and rtm.user_id = m.user_id;

  if v_valid_mentions is not null then
    insert into update_mentions (update_id, user_id)
    select v_update_id, m from unnest(v_valid_mentions) as m;

    foreach v_mentioned in array v_valid_mentions loop
      if v_mentioned <> auth.uid() then
        perform notify(v_mentioned, 'mentioned you in an update', p_record_id, 'update');
      end if;
    end loop;
  end if;

  return v_update_id;
end;
$$;

revoke all on function record_team_member_ids(uuid) from public, anon, authenticated;
revoke all on function add_update_with_mentions(uuid, text, uuid, uuid[]) from public, anon, authenticated;
grant execute on function record_team_member_ids(uuid) to authenticated;
grant execute on function add_update_with_mentions(uuid, text, uuid, uuid[]) to authenticated;
