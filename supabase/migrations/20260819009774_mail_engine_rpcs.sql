-- =============================================================================
-- The Email module — what the sync engine needs from the database.
--
-- All SERVICE ROLE ONLY: the cron tick and the webhook handlers call these
-- after their own authentication; no signed-in session can reach them.
--
--   mail_mailboxes.change_seq  bumped whenever a mailbox's mail changes, so a
--                              browser polling "anything new?" compares one
--                              number per mailbox instead of re-reading lists
--   mail_schedule_due          queues folder reconciliation by tier
--   mail_claim_mailboxes       leases mailboxes that have due work
--   mail_bump_seq              one increment of change_seq
--   mail_soft_delete_messages  tombstones — only while the row is still in the
--                              folder that reported it gone (a move must not
--                              delete a message the new folder already holds)
--   mail_prune                 retention for runs and finished queue rows
-- =============================================================================

alter table public.mail_mailboxes add column if not exists change_seq bigint not null default 0;

-- ── scheduling ──────────────────────────────────────────────────────────────
-- Hot folders (Inbox, Sent, Drafts, and anything opened in the last ten
-- minutes) every tick while Microsoft's push notifications are unhealthy, and
-- every five minutes as a safety net while they work. Warm every 15 minutes,
-- cold hourly. 50 seconds rather than 60 so a one-minute cron never skips a
-- beat because the previous run finished a moment after the tick began.
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

  return v_n;
end;
$$;

-- ── claiming ────────────────────────────────────────────────────────────────
-- Leases up to p_limit mailboxes that have due work, most urgent first. Two
-- overlapping ticks (or a tick and a webhook) never hold the same mailbox:
-- SKIP LOCKED plus the lease_until check.
create or replace function public.mail_claim_mailboxes(
  p_owner         text,
  p_limit         int,
  p_lease_seconds int,
  p_only          uuid default null
)
returns table (id uuid, address citext, graph_user_id text, sync_identity_id uuid, kind text, sync_status text)
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select m.id
      from public.mail_mailboxes m
     where m.deleted_at is null and m.deactivated_at is null and m.sync_identity_id is not null
       and m.sync_status not in ('paused', 'broken', 'stalled')
       and (m.throttled_until is null or m.throttled_until <= now())
       and (m.lease_until is null or m.lease_until <= now())
       and (p_only is null or m.id = p_only)
       and exists (select 1 from public.mail_sync_queue q
                    where q.mailbox_id = m.id and q.processed_at is null and q.not_before <= now())
     order by (select min(q.priority) from public.mail_sync_queue q
                where q.mailbox_id = m.id and q.processed_at is null and q.not_before <= now()),
              m.last_sync_at nulls first
     limit greatest(p_limit, 0)
     for update of m skip locked
  )
  update public.mail_mailboxes m
     set lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)), lease_owner = p_owner
    from due
   where m.id = due.id
  returning m.id, m.address, m.graph_user_id, m.sync_identity_id, m.kind, m.sync_status;
$$;

create or replace function public.mail_bump_seq(p_mailbox_id uuid)
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.mail_mailboxes set change_seq = change_seq + 1 where id = p_mailbox_id returning change_seq;
$$;

create or replace function public.mail_soft_delete_messages(
  p_mailbox_id uuid,
  p_graph_ids  text[],
  p_folder_id  uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update public.mail_messages
     set deleted_at = now(), updated_at = now()
   where mailbox_id = p_mailbox_id and graph_id = any (p_graph_ids) and deleted_at is null
     and (p_folder_id is null or folder_id = p_folder_id);
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
$$;

revoke all on function public.mail_schedule_due() from public, anon, authenticated;
revoke all on function public.mail_claim_mailboxes(text, int, int, uuid) from public, anon, authenticated;
revoke all on function public.mail_bump_seq(uuid) from public, anon, authenticated;
revoke all on function public.mail_soft_delete_messages(uuid, text[], uuid) from public, anon, authenticated;
revoke all on function public.mail_prune() from public, anon, authenticated;
grant execute on function public.mail_schedule_due() to service_role;
grant execute on function public.mail_claim_mailboxes(text, int, int, uuid) to service_role;
grant execute on function public.mail_bump_seq(uuid) to service_role;
grant execute on function public.mail_soft_delete_messages(uuid, text[], uuid) to service_role;
grant execute on function public.mail_prune() to service_role;
