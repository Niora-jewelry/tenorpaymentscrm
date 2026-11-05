-- =============================================================================
-- Part 9907: Teams on a merchant record — chats linked to a record, shown in its
-- Communication › Teams sub-tab.
--
-- ── WHAT IS STORED, AND WHAT NEVER IS ───────────────────────────────
-- A link says "this Teams conversation belongs to this record". Microsoft stays
-- the only copy of the messages (Teams spec: nothing is mirrored), so this table
-- holds a pointer, a name to show on the card, and who made the link. Never a
-- message, a preview or a member list.
--
-- ── NO ACCOUNT IN THE KEY ───────────────────────────────────────────
-- Graph's chat, team and channel ids are the same for everyone in the
-- conversation, so a link belongs to the conversation rather than to whoever made
-- it: two people linking the same chat to one record make one link, and everyone
-- in the chat reads it with their own account. `linked_identity_id` only records
-- whose account made it, for a viewer holding All users (look only).
--
-- ── WHY A NEW FLAG INSTEAD OF CLEARING coming_soon ──────────────────
-- A migration here is live on the shared database before its code is deployed.
-- The code live today falls through to the EMAIL view for any Communication
-- sub-tab that is neither `phone` nor coming soon, so clearing the flag now would
-- show a record's email under "Teams" until the deploy finished, and again on any
-- rollback. So `coming_soon` stays true: it is what any build without this feature
-- reads. `shows_record_chats` is what this build reads, and it wins. Turning it
-- off puts the sub-tab back to Coming soon, so this stays configuration.
-- =============================================================================

alter type activity_kind add value if not exists 'teams';

alter table subtabs
  add column if not exists shows_record_chats boolean not null default false;

comment on column subtabs.shows_record_chats is
  'This sub-tab shows the Teams conversations linked to the record. Wins over coming_soon, which stays true for builds that predate it (migration 9907).';

update subtabs s
   set shows_record_chats = true
  from tabs t
 where s.tab_id = t.id
   and t.key = 'communication'
   and s.key = 'teams';

create table if not exists record_teams_links (
  id                  uuid primary key default gen_random_uuid(),
  record_id           uuid not null references records (id) on delete cascade,
  conversation_kind   text not null check (conversation_kind in ('chat', 'channel')),
  chat_id             text,
  team_id             text,
  channel_id          text,
  -- `chat|<chatId>` or `channel|<teamId>|<channelId>`: the conversation, whoever's account.
  ref_key             text not null,
  chat_kind           text not null check (chat_kind in ('oneOnOne', 'group', 'meeting', 'channel')),
  -- Read from Microsoft when linked, never taken from the browser.
  title               text not null check (char_length(title) between 1 and 200),
  team_name           text check (team_name is null or char_length(team_name) <= 200),
  linked_by           uuid references profiles (id) on delete set null,
  linked_identity_id  uuid references mail_identities (id) on delete set null,
  linked_at           timestamptz not null default now(),
  constraint record_teams_links_one_per_record unique (record_id, ref_key),
  constraint record_teams_links_shape check (
    (conversation_kind = 'chat' and chat_id is not null and team_id is null and channel_id is null and ref_key = 'chat|' || chat_id)
    or
    (conversation_kind = 'channel' and chat_id is null and team_id is not null and channel_id is not null and ref_key = 'channel|' || team_id || '|' || channel_id)
  )
);

create index if not exists record_teams_links_ref on record_teams_links (ref_key);

-- Server only: every read goes through the gate in lib/msteams/recordLinks.ts.
alter table record_teams_links enable row level security;
alter table record_teams_links force row level security;
revoke all on record_teams_links from public, anon, authenticated;

/* The link and its history entry, one transaction (CLAUDE.md rule 5).
   Returns null when this conversation is already on this record. */
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
  values (p_record, p_actor, 'teams', left(format('Linked Teams %s “%s”', p_kind, left(p_title, 200)), 500), 'Teams');
  return v_id;
end $$;

/* Takes the pointer off the record. The conversation itself is Microsoft's and is untouched. */
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
  values (v_row.record_id, p_actor, 'teams', left(format('Unlinked Teams %s “%s”', v_row.conversation_kind, v_row.title), 500), 'Teams');
  return true;
end $$;

revoke all on function record_teams_link(uuid, uuid, uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function record_teams_unlink(uuid, uuid) from public, anon, authenticated;
grant execute on function record_teams_link(uuid, uuid, uuid, text, text, text, text, text, text, text, text) to service_role;
grant execute on function record_teams_unlink(uuid, uuid) to service_role;
