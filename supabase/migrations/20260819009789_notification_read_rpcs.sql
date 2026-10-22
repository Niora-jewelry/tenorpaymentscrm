-- =============================================================================
-- @Mentions — 4 of 5: reading and marking.
--
-- A mention is shown only while the person can still see what it points at:
-- the record (`record_visible`: not in the Recycle Bin, on the team or an
-- admin, module not hidden), the Updates/Cases tab, or the field (not
-- hidden) — and while the update / reply / case itself is not deleted.
-- Recycle bin, archive, lost access and deleted items all hide a mention by
-- construction, and it reappears when they are undone. Phone-call rows
-- (call, voicemail, recording, sms) pass through as before.
--
-- `notification_open` is the ONLY path that removes `previous_value`
-- (the client's rule: once the mentioned person has opened it). Mark read /
-- unread never touch it.
-- =============================================================================

create or replace function public.notification_visible(n public.notifications)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.revoked_at is null
     and (
       n.source_kind not like 'mention\_%'
       or (
         record_visible(n.record_id)
         and case n.source_kind
               when 'mention_update' then
                 tab_visible(n.record_id, 'updates')
                 and exists (select 1 from updates u
                              where u.id = n.update_id and u.deleted_at is null
                                and (u.parent_id is null or exists (select 1 from updates p where p.id = u.parent_id and p.deleted_at is null)))
               when 'mention_case_reply' then
                 tab_visible(n.record_id, 'cases')
                 and exists (select 1 from case_replies r join cases c on c.id = r.case_id
                              where r.id = n.case_reply_id and r.deleted_at is null and c.deleted_at is null)
               when 'mention_field' then
                 record_field_grant(n.record_id, n.field_key::text) <> 'hidden'
                 and exists (select 1 from fields f where f.key = n.field_key and f.archived_at is null)
               else false
             end
       )
     );
$$;

-- One row per notification with everything a list, a drawer or an email needs.
drop type if exists public.notification_row cascade;
create type public.notification_row as (
  id              uuid,
  source_kind     text,
  record_id       uuid,
  record_name     text,
  actor_id        uuid,
  actor_name      text,
  update_id       uuid,
  parent_update_id uuid,
  case_id         uuid,
  case_number     bigint,
  case_reply_id   uuid,
  field_key       text,
  field_label     text,
  tab_key         text,
  subtab_key      text,
  body            text,
  preview         text,
  note            text,
  current_value   text,
  previous_value  text,
  created_at      timestamptz,
  read_at         timestamptz,
  opened_at       timestamptz
);

create or replace function public.notification_rows(p_ids uuid[])
returns setof public.notification_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.id, n.source_kind, n.record_id, r.deal_name, n.actor_id, a.full_name,
         n.update_id, u.parent_id, n.case_id, c.number, n.case_reply_id,
         n.field_key::text, f.label,
         case n.source_kind
           when 'mention_update' then 'updates'
           when 'mention_case_reply' then 'cases'
           when 'mention_field' then t.key::text
           else null end,
         case when n.source_kind = 'mention_field' then s.key::text else null end,
         n.body, n.preview, n.note, n.current_value, n.previous_value,
         n.created_at, n.read_at, n.opened_at
    from notifications n
    left join records r on r.id = n.record_id
    left join profiles a on a.id = n.actor_id
    left join updates u on u.id = n.update_id
    left join cases c on c.id = n.case_id
    left join fields f on f.key = n.field_key
    left join tabs t on t.id = f.tab_id
    left join subtabs s on s.id = f.subtab_id
   where n.id = any (p_ids)
     and n.recipient_id = auth.uid();
$$;

-- Newest first, last 90 days, keyset paged. p_filter: unread | read | all.
create or replace function public.notifications_list(
  p_filter    text,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit     int default 30
)
returns setof public.notification_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with page as (
    select n.id, n.created_at
      from notifications n
     where n.recipient_id = auth.uid()
       and n.created_at >= now() - interval '90 days'
       and (p_filter = 'all'
            or (p_filter = 'unread' and n.read_at is null)
            or (p_filter = 'read' and n.read_at is not null))
       and (p_cursor_at is null or (n.created_at, n.id) < (p_cursor_at, p_cursor_id))
       and notification_visible(n)
     order by n.created_at desc, n.id desc
     limit least(greatest(coalesce(p_limit, 30), 1), 100)
  )
  select x.*
    from page
    join lateral notification_rows(array[page.id]) x on true
   order by x.created_at desc, x.id desc;
$$;

-- The sidebar: unread mentions, and unread phone alerts.
create or replace function public.my_unread_counts()
returns table (mentions int, phone int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    count(*) filter (where n.source_kind like 'mention\_%')::int,
    count(*) filter (where n.source_kind in ('call', 'voicemail', 'recording', 'sms'))::int
    from notifications n
   where n.recipient_id = auth.uid()
     and n.read_at is null
     and n.created_at >= now() - interval '90 days'
     and notification_visible(n);
$$;

-- List rows: unread mentions per record, for the records on the page.
create or replace function public.my_unread_mention_counts(p_record_ids uuid[])
returns table (record_id uuid, unread int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select n.record_id, count(*)::int
    from notifications n
   where n.recipient_id = auth.uid()
     and n.record_id = any (p_record_ids)
     and n.read_at is null
     and n.source_kind like 'mention\_%'
     and notification_visible(n)
   group by n.record_id;
$$;

-- The drawer: every unread mention on one record, oldest first.
create or replace function public.my_record_mentions(p_record_id uuid)
returns setof public.notification_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.*
    from notifications n
    join lateral notification_rows(array[n.id]) x on true
   where n.recipient_id = auth.uid()
     and n.record_id = p_record_id
     and n.read_at is null
     and n.source_kind like 'mention\_%'
     and record_visible(p_record_id)
     and notification_visible(n)
   order by n.created_at asc;
$$;

-- Click-through: read, opened, and the previous value is gone for good.
create or replace function public.notification_open(p_id uuid)
returns setof public.notification_row
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update notifications
     set read_at = coalesce(read_at, now()),
         opened_at = coalesce(opened_at, now())
   where id = p_id and recipient_id = auth.uid();
  -- Returned BEFORE the old value is cleared, so this one view can show it.
  return query select * from notification_rows(array[p_id]);
  update notifications set previous_value = null
   where id = p_id and recipient_id = auth.uid() and previous_value is not null;
end;
$$;

create or replace function public.notifications_mark(p_ids uuid[], p_read boolean)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n int;
begin
  update notifications
     set read_at = case when p_read then coalesce(read_at, now()) else null end
   where id = any (p_ids) and recipient_id = auth.uid()
     and (read_at is null) = p_read;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- p_kinds: null = everything; e.g. array['call','voicemail','recording','sms'] for the Phone page.
create or replace function public.notifications_mark_all_read(p_kinds text[] default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n int;
begin
  update notifications
     set read_at = now()
   where recipient_id = auth.uid()
     and read_at is null
     and revoked_at is null
     and (p_kinds is null or source_kind = any (p_kinds));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.notification_visible(public.notifications) from public, anon;
revoke execute on function public.notification_rows(uuid[]) from public, anon;
revoke execute on function public.notifications_list(text, timestamptz, uuid, int) from public, anon;
revoke execute on function public.my_unread_counts() from public, anon;
revoke execute on function public.my_unread_mention_counts(uuid[]) from public, anon;
revoke execute on function public.my_record_mentions(uuid) from public, anon;
revoke execute on function public.notification_open(uuid) from public, anon;
revoke execute on function public.notifications_mark(uuid[], boolean) from public, anon;
revoke execute on function public.notifications_mark_all_read(text[]) from public, anon;
grant execute on function public.notification_visible(public.notifications) to authenticated, service_role;
grant execute on function public.notification_rows(uuid[]) to authenticated, service_role;
grant execute on function public.notifications_list(text, timestamptz, uuid, int) to authenticated, service_role;
grant execute on function public.my_unread_counts() to authenticated, service_role;
grant execute on function public.my_unread_mention_counts(uuid[]) to authenticated, service_role;
grant execute on function public.my_record_mentions(uuid) to authenticated, service_role;
grant execute on function public.notification_open(uuid) to authenticated, service_role;
grant execute on function public.notifications_mark(uuid[], boolean) to authenticated, service_role;
grant execute on function public.notifications_mark_all_read(text[]) to authenticated, service_role;
