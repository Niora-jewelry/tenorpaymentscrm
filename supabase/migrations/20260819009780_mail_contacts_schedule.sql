-- =============================================================================
-- Email module P7: Outlook contacts on a schedule.
--
-- mail_schedule_due gains one block: a contacts delta every 15 minutes for
-- each personal mailbox (shared mailboxes' contacts would need
-- Contacts.Read.Shared, which the app does not request). Everything else in
-- the function is unchanged from 9774.
--
-- Rules are NOT scheduled: the rules screen reads them from Outlook when it
-- opens and every minute while open, and the connect flow's bootstrap
-- `rules_refresh` fills the cache once.
-- =============================================================================

create or replace function public.mail_schedule_due()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  insert into public.mail_sync_queue (mailbox_id, kind, target, priority)
  select f.mailbox_id, 'folder_delta', f.id::text,
         case when f.tier = 'hot' or f.last_opened_at > now() - interval '10 minutes' then 3
              when f.tier = 'warm' then 5 else 7 end
    from public.mail_folders f
    join public.mail_mailboxes m on m.id = f.mailbox_id
   where f.deleted_at is null and f.seeded_at is not null and f.delta_link is not null
     and coalesce(f.well_known, '') <> 'outbox'
     and m.deleted_at is null and m.deactivated_at is null and m.sync_identity_id is not null
     and m.sync_status not in ('paused', 'broken', 'stalled')
     and coalesce(f.delta_synced_at, '-infinity'::timestamptz) < now() - case
           when f.tier = 'hot' or f.last_opened_at > now() - interval '10 minutes'
             then case when m.subscription_healthy then interval '5 minutes' else interval '50 seconds' end
           when f.tier = 'warm' then interval '15 minutes'
           else interval '60 minutes' end
  on conflict (mailbox_id, kind, target) where processed_at is null do nothing;
  get diagnostics v_n = row_count;

  -- Folders never seeded (a failed first attempt), unless they keep failing.
  insert into public.mail_sync_queue (mailbox_id, kind, target, priority)
  select f.mailbox_id, 'seed_folder', f.id::text, case when f.tier = 'hot' then 2 else 5 end
    from public.mail_folders f
    join public.mail_mailboxes m on m.id = f.mailbox_id
   where f.deleted_at is null and f.seeded_at is null and f.delta_error_count < 5
     and coalesce(f.well_known, '') <> 'outbox' and (f.tier = 'hot' or f.total_count > 0)
     and m.deleted_at is null and m.deactivated_at is null and m.sync_identity_id is not null
     and m.sync_status not in ('paused', 'broken', 'stalled')
     and not exists (select 1 from public.mail_sync_queue q
                      where q.mailbox_id = f.mailbox_id and q.kind = 'seed_folder' and q.target = f.id::text
                        and (q.processed_at is null or q.processed_at > now() - interval '15 minutes'))
  on conflict (mailbox_id, kind, target) where processed_at is null do nothing;

  -- The folder tree itself, hourly.
  insert into public.mail_sync_queue (mailbox_id, kind, target, priority)
  select m.id, 'folders_refresh', '', 6
    from public.mail_mailboxes m
   where m.deleted_at is null and m.deactivated_at is null and m.sync_identity_id is not null
     and m.sync_status not in ('paused', 'broken', 'stalled')
     and coalesce(m.folders_synced_at, '-infinity'::timestamptz) < now() - interval '1 hour'
  on conflict (mailbox_id, kind, target) where processed_at is null do nothing;

  -- Outlook contacts (suggestions), every 15 minutes, personal mailboxes only.
  insert into public.mail_sync_queue (mailbox_id, kind, target, priority)
  select m.id, 'contacts_delta', '', 8
    from public.mail_mailboxes m
   where m.kind = 'personal' and m.deleted_at is null and m.deactivated_at is null and m.sync_identity_id is not null
     and m.sync_status not in ('paused', 'broken', 'stalled')
     and coalesce(m.contacts_synced_at, '-infinity'::timestamptz) < now() - interval '15 minutes'
  on conflict (mailbox_id, kind, target) where processed_at is null do nothing;

  return v_n;
end;
$$;

revoke all on function public.mail_schedule_due() from public, anon, authenticated;
grant execute on function public.mail_schedule_due() to service_role;
