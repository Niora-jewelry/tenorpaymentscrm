-- =============================================================================
-- Permissions spec — part 5.
--
-- 1. Notifications, "All users = everyone's". The Notifications page gains a
--    view of another person's notifications, or everyone's, for a user whose
--    Notifications setting is All users. Same filter, cursor and visibility
--    rules as notifications_list (still only items on records this person can
--    open — notification_visible); only the recipient differs. A user who is
--    Own only asking for anyone else's gets nothing.
--
-- 2. Call recordings in storage follow the same rule as the recording rows
--    (migration 9813): your own calls; a record's calls with Communication =
--    Whole org; everyone's with Phone = All users.
-- =============================================================================

create or replace function notifications_list_of(
  p_user uuid,                                     -- null = everyone
  p_filter text,
  p_cursor_at timestamptz default null,
  p_cursor_id uuid default null,
  p_limit int default 30
)
returns setof notification_row
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with page as (
    select n.id, n.created_at
      from notifications n
     where (p_user is null or n.recipient_id = p_user)
       and (p_user = auth.uid() or auth_perm('notifications.scope') = 'all')
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
revoke execute on function notifications_list_of(uuid, text, timestamptz, uuid, int) from public, anon;
grant execute on function notifications_list_of(uuid, text, timestamptz, uuid, int) to authenticated;

drop policy if exists phone_recordings_bucket_select on storage.objects;
create policy phone_recordings_bucket_select on storage.objects for select
  using (bucket_id = 'phone-recordings'
         and exists (select 1 from phone_calls c
                      where c.id = ((storage.foldername(objects.name))[2])::uuid
                        and c.deleted_at is null
                        and (auth_perm('phone.scope') = 'all'
                             or c.owner_id = auth.uid()
                             or (c.record_id is not null and record_visible(c.record_id)
                                 and auth_perm('communication.scope') = 'org'))));
