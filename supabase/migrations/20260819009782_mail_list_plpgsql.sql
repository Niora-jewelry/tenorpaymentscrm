-- =============================================================================
-- Email module P9: mail_list in plpgsql — same query, 15x faster.
--
-- Found by the scale test (src/lib/mail/scale.integration.test.ts): with a
-- 4,000-message Inbox, mail_list took ~450 ms of database time (2.4 s at
-- 10,000 messages in the mailbox) although its query runs in ~20 ms. A SQL
-- function with a SET clause is never inlined and its body is planned afresh
-- on every call; plpgsql keeps the plan. Dropping the SET would also have
-- fixed it, but the pinned search_path stays (CLAUDE.md rule 8 spirit, and
-- defence in depth for an invoker function).
--
-- The query text is unchanged from 9776; only the language changes.
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
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  return query
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
end;
$$;
