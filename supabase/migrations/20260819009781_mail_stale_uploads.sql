-- =============================================================================
-- Email module P9: sweeping attachments nobody will send.
--
-- The composer uploads files to the private `mail-outbox` bucket as soon as
-- they are added. They are deleted when their message is sent — but a file
-- added and then abandoned (composer closed, draft discarded elsewhere, an
-- undone message never re-sent, a send that failed for good) would stay
-- forever. This lists such files: older than 7 days and not referenced by a
-- message still waiting to go (held / scheduled / sending). The engine
-- deletes them through the Storage API (deleting storage.objects rows here
-- would leave the bytes behind).
--
-- Service role only.
-- =============================================================================

create or replace function public.mail_stale_uploads(p_limit int default 200)
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'mail-outbox'
     and o.created_at < now() - interval '7 days'
     and not exists (
       select 1
         from public.mail_outbox b
         cross join lateral jsonb_array_elements(coalesce(b.attachments, '[]'::jsonb)) a
        where b.status in ('held', 'scheduled', 'sending')
          and a->>'path' = o.name)
   order by o.created_at
   limit greatest(least(p_limit, 1000), 0);
$$;

revoke all on function public.mail_stale_uploads(int) from public, anon, authenticated;
grant execute on function public.mail_stale_uploads(int) to service_role;
