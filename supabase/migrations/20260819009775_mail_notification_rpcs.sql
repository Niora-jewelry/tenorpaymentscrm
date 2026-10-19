-- =============================================================================
-- The Email module — Graph change notifications.
--
-- SERVICE ROLE ONLY, like the rest of the engine.
--
--   mail_schedule_subscriptions  queue create/renew for every active mailbox
--                                whose pair is missing, failed or within a day
--                                of expiry; and stop calling a mailbox
--                                "healthy" the moment a subscription lapses,
--                                so its hot folders go back to per-minute
--                                polling without waiting for anyone
--   mail_enqueue_hot             Microsoft said it MISSED notifications:
--                                reconcile the hot folders now
--   mail_prune                   + subscriptions of mailboxes nobody uses
-- =============================================================================

create or replace function public.mail_schedule_subscriptions()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update public.mail_mailboxes m
     set subscription_healthy = false
   where m.subscription_healthy
     and (select count(*) from public.mail_subscriptions s
           where s.mailbox_id = m.id and s.status = 'active' and s.expires_at > now()) < 2;

  insert into public.mail_sync_queue (mailbox_id, kind, target, priority)
  select m.id, 'subscription_ensure', '', 4
    from public.mail_mailboxes m
   where m.deleted_at is null and m.deactivated_at is null and m.sync_identity_id is not null
     and m.sync_status not in ('paused', 'broken', 'stalled')
     and (select count(*) from public.mail_subscriptions s
           where s.mailbox_id = m.id and s.status = 'active' and s.expires_at > now() + interval '24 hours') < 2
     -- a mailbox whose last attempt FAILED is retried every ten minutes, not every tick
     and not exists (select 1 from public.mail_subscriptions s
                      where s.mailbox_id = m.id and s.status = 'failed'
                        and s.updated_at > now() - interval '10 minutes')
  on conflict (mailbox_id, kind, target) where processed_at is null do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.mail_enqueue_hot(p_mailbox_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  insert into public.mail_sync_queue (mailbox_id, kind, target, priority)
  select f.mailbox_id, 'folder_delta', f.id::text, 1
    from public.mail_folders f
   where f.mailbox_id = p_mailbox_id and f.deleted_at is null and f.tier = 'hot'
     and f.seeded_at is not null and f.delta_link is not null
  on conflict (mailbox_id, kind, target) where processed_at is null
  do update set priority = least(mail_sync_queue.priority, excluded.priority), not_before = least(mail_sync_queue.not_before, now());
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.mail_prune()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.mail_sync_runs where started_at < now() - interval '7 days';
  delete from public.mail_sync_queue where processed_at < now() - interval '1 day';
  -- Nobody is connected any more: their notifications are dropped on arrival,
  -- and Microsoft lets the subscription lapse within a week.
  delete from public.mail_subscriptions s
   using public.mail_mailboxes m
   where m.id = s.mailbox_id and (m.deactivated_at is not null or m.deleted_at is not null);
$$;

revoke all on function public.mail_schedule_subscriptions() from public, anon, authenticated;
revoke all on function public.mail_enqueue_hot(uuid) from public, anon, authenticated;
revoke all on function public.mail_prune() from public, anon, authenticated;
grant execute on function public.mail_schedule_subscriptions() to service_role;
grant execute on function public.mail_enqueue_hot(uuid) to service_role;
grant execute on function public.mail_prune() to service_role;
