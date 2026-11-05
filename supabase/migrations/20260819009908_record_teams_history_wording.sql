-- =============================================================================
-- Part 9908: a linked chat's name stays out of the record's history.
--
-- An untitled Teams chat is named after the people in it, and Communication's
-- "Own only" means a viewer sees only what they were part of. The cards obey that
-- (lib/msteams/recordLinks.ts), but the history entries from 9907 carried the name
-- to anyone who can read the record's activity. So the entry now says what happened
-- and who did it, and the name stays on the card.
-- =============================================================================

create or replace function record_teams_link(
  p_record uuid, p_actor uuid, p_identity uuid,
  p_kind text, p_chat text, p_team text, p_channel text,
  p_ref text, p_chat_kind text, p_title text, p_team_name text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  insert into record_teams_links (record_id, conversation_kind, chat_id, team_id, channel_id, ref_key, chat_kind, title, team_name, linked_by, linked_identity_id)
  values (p_record, p_kind, p_chat, p_team, p_channel, p_ref, p_chat_kind, left(p_title, 200), left(p_team_name, 200), p_actor, p_identity)
  on conflict (record_id, ref_key) do nothing
  returning id into v_id;
  if v_id is null then
    return null;
  end if;
  insert into record_activity (record_id, actor_id, kind, summary, source)
  values (p_record, p_actor, 'teams', format('Linked a Teams %s', p_kind), 'Teams');
  return v_id;
end $$;

create or replace function record_teams_unlink(p_link uuid, p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row record_teams_links%rowtype;
begin
  delete from record_teams_links where id = p_link returning * into v_row;
  if v_row.id is null then
    return false;
  end if;
  insert into record_activity (record_id, actor_id, kind, summary, source)
  values (v_row.record_id, p_actor, 'teams', format('Unlinked a Teams %s', v_row.conversation_kind), 'Teams');
  return true;
end $$;

revoke all on function record_teams_link(uuid, uuid, uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function record_teams_unlink(uuid, uuid) from public, anon, authenticated;
grant execute on function record_teams_link(uuid, uuid, uuid, text, text, text, text, text, text, text, text) to service_role;
grant execute on function record_teams_unlink(uuid, uuid) to service_role;
