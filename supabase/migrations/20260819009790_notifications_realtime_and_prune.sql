-- =============================================================================
-- @Mentions — 5 of 5: live counts, and retention.
--
-- Realtime: the sidebar count must move the moment a mention arrives, in
-- every open tab, without a refresh. Supabase Realtime streams the table's
-- changes to subscribers, checking each row against the table's SELECT
-- policy as the subscriber (`recipient_id = auth.uid()`), so a person only
-- ever receives their own rows. REPLICA IDENTITY stays DEFAULT on purpose:
-- FULL would put whole old rows into DELETE events, which Realtime does not
-- check against RLS — which is why nothing live-relevant is ever hard
-- deleted here (`revoked_at`, 9786).
--
-- Retention: 90 days (the plan), applied by the nightly housekeeping cron
-- through `notifications_prune` (service role only). Revoked rows go a day
-- after revocation, so an open tab that missed the UPDATE event reconciles
-- on its next load before the row vanishes.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;

create or replace function public.notifications_prune()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n int;
begin
  delete from notifications
   where created_at < now() - interval '90 days'
      or (revoked_at is not null and revoked_at < now() - interval '1 day');
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.notifications_prune() from public, anon, authenticated;
grant execute on function public.notifications_prune() to service_role;
