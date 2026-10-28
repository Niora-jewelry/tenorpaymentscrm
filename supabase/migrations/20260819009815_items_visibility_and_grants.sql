-- =============================================================================
-- Permissions spec — part 6: Updates, cases and tab notes.
--
--   Cases       Hidden · Only mine · See all + grant   (Tickets follows it)
--   Updates     Only mine · See all + grant
--   Tab notes   Only mine · See all + grant
--
-- "Only mine: the user sees only items they created, were @'d on, or were given
-- access to." "See all + grant: the user sees every item and every reply, and
-- can give other users access to an item they can't otherwise see."
--
-- Granting: to a user type or to one user, for that ONE item, and only to
-- someone who can already open the record — the same rule as an @mention.
--
-- Replies: everyone who can see an item sees its replies, except that the
-- person who wrote a reply can hide that reply from specific users.
--
-- All on top of what already applied: the record must be one the user can
-- open, and the tab (Updates, Cases, or the tab a note sits on) not Hidden.
-- A case's managers count as "mine": they were put on it.
-- =============================================================================

-- ── who was given access ─────────────────────────────────────────────────────
create table if not exists item_access_grants (
  id           uuid primary key default gen_random_uuid(),
  item_kind    text not null check (item_kind in ('case', 'update', 'note')),
  item_id      uuid not null,
  record_id    uuid not null references records(id) on delete cascade,
  grantee_user uuid references profiles(id) on delete cascade,
  grantee_type text check (grantee_type in ('super_admin', 'admin', 'underwriter', 'accounting', 'customer_service', 'sales_agent')),
  granted_by   uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint item_access_grants_one_grantee check ((grantee_user is null) <> (grantee_type is null))
);
create unique index if not exists item_access_grants_user_once
  on item_access_grants (item_kind, item_id, grantee_user) where grantee_user is not null;
create unique index if not exists item_access_grants_type_once
  on item_access_grants (item_kind, item_id, grantee_type) where grantee_type is not null;
create index if not exists item_access_grants_item on item_access_grants (item_kind, item_id);
alter table item_access_grants enable row level security;
alter table item_access_grants force row level security;
revoke all on item_access_grants from anon, authenticated;
grant select on item_access_grants to authenticated;

-- ── replies hidden from someone ──────────────────────────────────────────────
create table if not exists reply_hidden_from (
  reply_kind text not null check (reply_kind in ('update', 'case_reply')),
  reply_id   uuid not null,
  user_id    uuid not null references profiles(id) on delete cascade,
  hidden_by  uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (reply_kind, reply_id, user_id)
);
alter table reply_hidden_from enable row level security;
alter table reply_hidden_from force row level security;
revoke all on reply_hidden_from from anon, authenticated;
grant select on reply_hidden_from to authenticated;

-- ── the one visibility rule ──────────────────────────────────────────────────
create or replace function user_type_of(u uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pt.user_type from user_templates ut join permission_templates pt on pt.id = ut.template_id where ut.user_id = u;
$$;

/* Is this item one this user may see, by the items setting alone?
   p_mine: created it, was @'d on it, or (a case) manages it. */
create or replace function user_sees_item(u uuid, p_kind text, p_item uuid, p_mine boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case user_perm(u, case p_kind when 'case' then 'items.cases' when 'update' then 'items.updates' else 'items.notes' end)
    when 'all' then true
    when 'mine' then p_mine or exists (
      select 1 from item_access_grants g
       where g.item_kind = p_kind and g.item_id = p_item
         and (g.grantee_user = u or g.grantee_type = user_type_of(u)))
    else false
  end;
$$;

create or replace function update_visible_to(u uuid, p_update uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select user_sees_item(
             u, 'update', root.id,
             root.author_id = u
             or exists (select 1 from update_mentions m
                         where m.user_id = u
                           and m.update_id in (select root.id union all select r.id from updates r where r.parent_id = root.id)))
       and (x.parent_id is null
            or x.author_id = u
            or not exists (select 1 from reply_hidden_from h
                            where h.reply_kind = 'update' and h.reply_id = x.id and h.user_id = u))
      from updates x
      join updates root on root.id = coalesce(x.parent_id, x.id)
     where x.id = p_update
  ), false);
$$;

create or replace function case_visible_to(u uuid, p_case uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select user_sees_item(
             u, 'case', c.id,
             c.issue_author = u
             or c.solution_author = u
             or exists (select 1 from case_managers cm where cm.case_id = c.id and cm.user_id = u)
             or exists (select 1 from case_replies r join case_reply_mentions m on m.case_reply_id = r.id
                         where r.case_id = c.id and m.user_id = u)
             or exists (select 1 from case_replies r where r.case_id = c.id and r.author_id = u))
      from cases c where c.id = p_case
  ), false);
$$;

create or replace function case_reply_visible_to(u uuid, p_reply uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case_visible_to(u, r.case_id)
       and (r.author_id = u
            or not exists (select 1 from reply_hidden_from h
                            where h.reply_kind = 'case_reply' and h.reply_id = r.id and h.user_id = u))
      from case_replies r where r.id = p_reply
  ), false);
$$;

create or replace function note_visible_to(u uuid, p_note uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Tab notes follow Tab notes; a note on a field follows its field (unchanged).
  select coalesce((
    select n.scope_kind <> 'tab' or user_sees_item(u, 'note', n.id, n.author_id = u)
      from notes n where n.id = p_note
  ), false);
$$;

revoke execute on function user_sees_item(uuid, text, uuid, boolean) from public, anon;
revoke execute on function update_visible_to(uuid, uuid) from public, anon;
revoke execute on function case_visible_to(uuid, uuid) from public, anon;
revoke execute on function case_reply_visible_to(uuid, uuid) from public, anon;
revoke execute on function note_visible_to(uuid, uuid) from public, anon;
grant execute on function update_visible_to(uuid, uuid) to authenticated;
grant execute on function case_visible_to(uuid, uuid) to authenticated;
grant execute on function case_reply_visible_to(uuid, uuid) to authenticated;
grant execute on function note_visible_to(uuid, uuid) to authenticated;

-- ── the reads ────────────────────────────────────────────────────────────────
drop policy if exists updates_select on updates;
create policy updates_select on updates for select
  using (record_visible(record_id)
         and tab_visible(record_id, 'updates')
         and (field_key is null or record_field_grant(record_id, field_key::text) <> 'hidden')
         and update_visible_to(auth.uid(), id));

drop policy if exists cases_select on cases;
create policy cases_select on cases for select
  using (record_visible(record_id) and tab_visible(record_id, 'cases') and case_visible_to(auth.uid(), id));

drop policy if exists case_replies_select on case_replies;
create policy case_replies_select on case_replies for select
  using (exists (select 1 from cases c
                  where c.id = case_replies.case_id and record_visible(c.record_id) and tab_visible(c.record_id, 'cases'))
         and case_reply_visible_to(auth.uid(), id));

drop policy if exists notes_select on notes;
create policy notes_select on notes for select
  using (record_visible(record_id)
         and coalesce(tab_visible(record_id, note_scope_tab_key(scope_kind::text, scope_id)), true)
         and note_visible_to(auth.uid(), id));

-- Granted / hidden rows are readable by the people they concern and by those
-- who can see the item and grant (See all + grant), on records they can open.
drop policy if exists item_access_grants_select on item_access_grants;
create policy item_access_grants_select on item_access_grants for select
  using (record_visible(record_id)
         and (grantee_user = auth.uid() or granted_by = auth.uid()
              or auth_perm(case item_kind when 'case' then 'items.cases' when 'update' then 'items.updates' else 'items.notes' end) = 'all'));
drop policy if exists reply_hidden_from_select on reply_hidden_from;
create policy reply_hidden_from_select on reply_hidden_from for select
  using (hidden_by = auth.uid() or user_id = auth.uid());

-- ── granting ────────────────────────────────────────────────────────────────
create or replace function grant_item_access(p_kind text, p_item uuid, p_user uuid, p_type text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_record uuid;
  v_id     uuid;
  v_key    text := case p_kind when 'case' then 'items.cases' when 'update' then 'items.updates' when 'note' then 'items.notes' end;
begin
  if v_key is null then raise exception 'Unknown item.'; end if;
  if (p_user is null) = (p_type is null) then raise exception 'Choose one person or one user type.'; end if;
  v_record := case p_kind
    when 'case' then (select record_id from cases where id = p_item and deleted_at is null)
    when 'update' then (select record_id from updates where id = p_item and deleted_at is null)
    else (select record_id from notes where id = p_item and deleted_at is null) end;
  if v_record is null or not record_visible(v_record) then raise exception 'not found'; end if;
  if auth_perm(v_key) <> 'all' then
    raise exception 'Only someone who sees all of these can give access.' using errcode = '42501';
  end if;
  if p_user is not null and not user_can_see_record(p_user, v_record) then
    raise exception 'That person cannot open this record, so they cannot be given access to it.' using errcode = '42501';
  end if;
  insert into item_access_grants (item_kind, item_id, record_id, grantee_user, grantee_type, granted_by)
  values (p_kind, p_item, v_record, p_user, p_type, auth.uid())
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function revoke_item_access(p_grant uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare g item_access_grants;
begin
  select * into g from item_access_grants where id = p_grant;
  if g.id is null or not record_visible(g.record_id) then raise exception 'not found'; end if;
  if g.granted_by is distinct from auth.uid()
     and auth_perm(case g.item_kind when 'case' then 'items.cases' when 'update' then 'items.updates' else 'items.notes' end) <> 'all' then
    raise exception 'You cannot remove this access.' using errcode = '42501';
  end if;
  delete from item_access_grants where id = p_grant;
end;
$$;

-- ── hiding a reply ───────────────────────────────────────────────────────────
-- The reply's author sets the whole list at once; an empty list shows it to
-- everyone who sees the item again.
create or replace function set_reply_hidden_from(p_kind text, p_reply uuid, p_users uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_author uuid;
begin
  v_author := case p_kind
    when 'update' then (select author_id from updates where id = p_reply and parent_id is not null and deleted_at is null)
    when 'case_reply' then (select author_id from case_replies where id = p_reply and deleted_at is null) end;
  if v_author is null then raise exception 'not found'; end if;
  if v_author <> auth.uid() then
    raise exception 'Only the person who wrote a reply can hide it.' using errcode = '42501';
  end if;
  delete from reply_hidden_from where reply_kind = p_kind and reply_id = p_reply;
  insert into reply_hidden_from (reply_kind, reply_id, user_id, hidden_by)
  select p_kind, p_reply, x, auth.uid() from unnest(coalesce(p_users, '{}')) x where x <> auth.uid()
  on conflict do nothing;
end;
$$;

revoke execute on function grant_item_access(text, uuid, uuid, text) from public, anon;
revoke execute on function revoke_item_access(uuid) from public, anon;
revoke execute on function set_reply_hidden_from(text, uuid, uuid[]) from public, anon;
grant execute on function grant_item_access(text, uuid, uuid, text) to authenticated;
grant execute on function revoke_item_access(uuid) to authenticated;
grant execute on function set_reply_hidden_from(text, uuid, uuid[]) to authenticated;
