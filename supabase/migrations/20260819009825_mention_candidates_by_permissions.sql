-- =============================================================================
-- Who can be @'d on a record, under the Permissions spec.
--
-- Two gaps since the user types landed:
--
--  1. The pool was "Super admins ∪ the record's team ∪ visibility grants" —
--     the old rule for who can open a record. Module access now also opens it
--     (All records), so an Underwriter or Accounting user who can see every
--     lead was never offered. The pool is now every active person, kept only
--     if they can open this record (user_record_visible), as before.
--
--  2. A case mention ignored the Cases setting. Someone with Cases = Hidden
--     sees no cases at all, so @'ing them on one would notify them about
--     something they cannot open.
--
-- Updates and fields keep their own checks, unchanged.
-- =============================================================================

create or replace function mention_candidates(p_record_id uuid, p_scope text)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_field text := case when p_scope like 'field:%' then substr(p_scope, 7) else null end;
  v_out   uuid[];
begin
  if not record_visible(p_record_id) then
    raise exception 'not found';
  end if;
  if p_scope not in ('updates', 'cases') and v_field is null then
    raise exception 'Unknown mention scope' using errcode = '22023';
  end if;

  select coalesce(array_agg(p.id order by lower(coalesce(p.full_name, p.email::text)), p.id), '{}')
    into v_out
    from profiles p
   where p.status = 'active'
     and p.deleted_at is null
     and p.id <> auth.uid()
     and user_record_visible(p.id, p_record_id)
     and case
           when p_scope = 'updates' then user_record_tab_grant(p.id, p_record_id, 'updates') <> 'hidden'
           when p_scope = 'cases'   then user_record_tab_grant(p.id, p_record_id, 'cases') <> 'hidden'
                                         and (user_is_admin(p.id) or user_perm(p.id, 'items.cases') <> 'hidden')
           else user_record_field_grant(p.id, p_record_id, v_field) <> 'hidden'
         end;
  return v_out;
end;
$$;
