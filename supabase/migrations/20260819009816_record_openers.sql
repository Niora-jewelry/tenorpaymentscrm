-- =============================================================================
-- Permissions spec: "Access can only be granted to someone who can already
-- open the record." The share control offers exactly those people — asked of
-- the database, never guessed in the browser. Only someone who can open the
-- record may ask.
-- =============================================================================
create or replace function record_openers(p_record uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when record_visible(p_record) then coalesce((
    select array_agg(p.id order by p.full_name)
      from profiles p
     where p.deleted_at is null and p.status = 'active'
       and user_can_see_record(p.id, p_record)
  ), '{}') else '{}' end;
$$;
revoke execute on function record_openers(uuid) from public, anon;
grant execute on function record_openers(uuid) to authenticated;
