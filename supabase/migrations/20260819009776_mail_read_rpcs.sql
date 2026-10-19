-- =============================================================================
-- The Email module — what the reading UI asks the database.
--
-- mail_list / mail_conversation / mail_search are SECURITY INVOKER: they run
-- as the signed-in person, so every row they touch has already passed the
-- mail_* select policies (mail_visible_mailbox_ids()). They cannot show a
-- message the caller could not have selected directly; they only shape it.
--
-- mail_touch_folder is the one definer function here: "I just opened this
-- folder" — it promotes the folder to hot for ten minutes and, if it is
-- stale, queues an immediate reconciliation. It checks visibility itself.
--
-- Conversations are keyed by Graph's conversationId, or 'msg:<id>' for a
-- message that has none, so every message belongs to exactly one row.
-- =============================================================================

create or replace function public.mail_list(
  p_folder_ids       uuid[],
  p_pinned           boolean,
  p_limit            int,
  p_cursor_at        timestamptz default null,
  p_cursor_key       text default null,
  p_unread_only      boolean default false,
  p_with_attachments boolean default false,
  p_since            timestamptz default null,
  p_until            timestamptz default null
)
returns table (
  mailbox_id        uuid,
  folder_id         uuid,
  conversation_key  text,
  latest_message_id uuid,
  subject           text,
  from_name         text,
  from_address      text,
  to_recipients     jsonb,
  direction         text,
  preview           text,
  last_at           timestamptz,
  message_count     int,
  unread_count      int,
  has_attachments   boolean,
  important         boolean,
  has_draft         boolean,
  is_pinned         boolean
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with m as (
    select x.id, x.mailbox_id, coalesce(x.conversation_id, 'msg:' || x.id::text) as ck,
           coalesce(x.received_at, x.sent_at, x.created_at) as at,
           x.is_read, x.has_attachments, x.importance, x.is_draft
      from public.mail_messages x
     where x.folder_id = any (p_folder_ids)
       and x.deleted_at is null
       and (p_since is null or coalesce(x.received_at, x.sent_at) >= p_since)
       and (p_until is null or coalesce(x.received_at, x.sent_at) < p_until)
  ), g as (
    select m.mailbox_id, m.ck,
           max(m.at) as last_at,
           count(*)::int as n,
           (count(*) filter (where not m.is_read))::int as unread,
           bool_or(m.has_attachments) as att,
           (array_agg(m.id order by m.at desc, m.id desc))[1] as latest_id,
           bool_or(m.importance = 'high') as important,
           bool_or(m.is_draft) as has_draft
      from m
     group by m.mailbox_id, m.ck
  )
  select g.mailbox_id, l.folder_id, g.ck, g.latest_id, l.subject, l.from_name, l.from_address::text,
         l.to_recipients, l.direction, l.preview, g.last_at, g.n, g.unread, g.att, g.important, g.has_draft,
         (p.conversation_id is not null)
    from g
    join public.mail_messages l on l.id = g.latest_id
    left join public.mail_pins p
      on p.mailbox_id = g.mailbox_id and p.folder_id = l.folder_id and p.conversation_id = g.ck
   where (p.conversation_id is not null) = p_pinned
     and (not coalesce(p_unread_only, false) or g.unread > 0)
     and (not coalesce(p_with_attachments, false) or g.att)
     and (p_cursor_at is null or (g.last_at, g.ck) < (p_cursor_at, p_cursor_key))
   order by g.last_at desc, g.ck desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.mail_conversation(p_mailbox_id uuid, p_key text)
returns table (
  id                   uuid,
  folder_id            uuid,
  folder_name          text,
  folder_well_known    text,
  subject              text,
  from_name            text,
  from_address         text,
  to_recipients        jsonb,
  cc_recipients        jsonb,
  bcc_recipients       jsonb,
  received_at          timestamptz,
  sent_at              timestamptz,
  is_read              boolean,
  is_draft             boolean,
  has_attachments      boolean,
  preview              text,
  body_state           text,
  direction            text,
  importance           text,
  meeting_message_type text,
  external_image_count int
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select x.id, x.folder_id, f.display_name, f.well_known, x.subject, x.from_name, x.from_address::text,
         x.to_recipients, x.cc_recipients, x.bcc_recipients, x.received_at, x.sent_at, x.is_read, x.is_draft,
         x.has_attachments, x.preview, x.body_state, x.direction, x.importance, x.meeting_message_type,
         jsonb_array_length(x.external_images)
    from public.mail_messages x
    left join public.mail_folders f on f.id = x.folder_id
   where x.mailbox_id = p_mailbox_id
     and x.deleted_at is null
     and case when p_key like 'msg:%' then x.id::text = substr(p_key, 5) else x.conversation_id = p_key end
   order by coalesce(x.received_at, x.sent_at, x.created_at) desc
   limit 200;
$$;

-- p_tsquery is built by the app from the person's words (each word a prefix
-- match, all required). A malformed one falls back to plain matching rather
-- than erroring; an empty one returns nothing.
create or replace function public.mail_search(
  p_tsquery     text,
  p_mailbox_ids uuid[],
  p_folder_ids  uuid[] default null,
  p_limit       int default 50
)
returns table (
  mailbox_id        uuid,
  folder_id         uuid,
  conversation_key  text,
  latest_message_id uuid,
  subject           text,
  from_name         text,
  from_address      text,
  to_recipients     jsonb,
  direction         text,
  preview           text,
  last_at           timestamptz,
  message_count     int,
  unread_count      int,
  has_attachments   boolean,
  important         boolean,
  has_draft         boolean,
  is_pinned         boolean
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  q tsquery;
begin
  begin
    q := to_tsquery('simple', p_tsquery);
  exception when others then
    q := plainto_tsquery('simple', p_tsquery);
  end;
  if q is null or numnode(q) = 0 then
    return;
  end if;

  return query
  with m as (
    select x.id, x.mailbox_id, coalesce(x.conversation_id, 'msg:' || x.id::text) as ck,
           coalesce(x.received_at, x.sent_at, x.created_at) as at,
           x.is_read, x.has_attachments, x.importance, x.is_draft
      from public.mail_messages x
     where x.search_vector @@ q
       and x.deleted_at is null
       and x.mailbox_id = any (p_mailbox_ids)
       and (p_folder_ids is null or x.folder_id = any (p_folder_ids))
  ), g as (
    select m.mailbox_id, m.ck, max(m.at) as last_at, count(*)::int as n,
           (count(*) filter (where not m.is_read))::int as unread,
           bool_or(m.has_attachments) as att,
           (array_agg(m.id order by m.at desc, m.id desc))[1] as latest_id,
           bool_or(m.importance = 'high') as important,
           bool_or(m.is_draft) as has_draft
      from m
     group by m.mailbox_id, m.ck
  )
  select g.mailbox_id, l.folder_id, g.ck, g.latest_id, l.subject, l.from_name, l.from_address::text,
         l.to_recipients, l.direction, l.preview, g.last_at, g.n, g.unread, g.att, g.important, g.has_draft,
         false
    from g
    join public.mail_messages l on l.id = g.latest_id
   order by g.last_at desc, g.ck desc
   limit least(greatest(coalesce(p_limit, 50), 1), 100);
end;
$$;

-- "I opened this folder": hot for ten minutes, and fetched now if stale.
-- Returns the mailbox id when work was queued (the caller drains it), else null.
create or replace function public.mail_touch_folder(p_folder_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mailbox uuid;
  v_synced  timestamptz;
  v_seeded  timestamptz;
begin
  select f.mailbox_id, f.delta_synced_at, f.seeded_at into v_mailbox, v_synced, v_seeded
    from public.mail_folders f
   where f.id = p_folder_id and f.deleted_at is null;
  if not found or not (v_mailbox = any (public.mail_visible_mailbox_ids())) then
    raise exception 'not found' using errcode = '42501';
  end if;

  update public.mail_folders set last_opened_at = now() where id = p_folder_id;

  if v_seeded is null or coalesce(v_synced, '-infinity'::timestamptz) < now() - interval '60 seconds' then
    perform public.mail_enqueue(v_mailbox, case when v_seeded is null then 'seed_folder' else 'folder_delta' end,
                                p_folder_id::text, 1::smallint);
    return v_mailbox;
  end if;
  return null;
end;
$$;

revoke all on function public.mail_list(uuid[], boolean, int, timestamptz, text, boolean, boolean, timestamptz, timestamptz) from public, anon;
revoke all on function public.mail_conversation(uuid, text) from public, anon;
revoke all on function public.mail_search(text, uuid[], uuid[], int) from public, anon;
revoke all on function public.mail_touch_folder(uuid) from public, anon;
grant execute on function public.mail_list(uuid[], boolean, int, timestamptz, text, boolean, boolean, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.mail_conversation(uuid, text) to authenticated, service_role;
grant execute on function public.mail_search(text, uuid[], uuid[], int) to authenticated, service_role;
grant execute on function public.mail_touch_folder(uuid) to authenticated, service_role;
