-- A screen already shows what its own person just did: the action that saved it
-- brings the new page back. So a ping says who it came from, and that person's
-- screen leaves it. Without this, one save rendered the drawer three times.

alter table record_pings add column if not exists by_user uuid;

create or replace function public.record_ping(p_record uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into record_pings (record_id, at, by_user) values (p_record, clock_timestamp(), auth.uid())
  on conflict (record_id) do update set at = excluded.at, by_user = excluded.by_user;
$$;
