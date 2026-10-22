-- =============================================================================
-- profile_names(): a person with no full name is named by their email
-- =============================================================================
-- A profile created by invitation has no `full_name` until the person fills
-- it in. Every place that shows a person — mention pickers, "was notified"
-- chips, notification rows, update authors — resolved such a profile to
-- "Unknown user", and the @mention picker could not be typed against at all
-- ("@demo" matched nothing, because the roster entry was "Unknown user").
--
-- Found by the browser suite (scripts/verify-mentions.mjs) against
-- demo.rep@tapdash.test, which has no name. The local part of the email is
-- what the person signed in with, so it is a name they recognise.
-- =============================================================================

create or replace function public.profile_names(p_ids uuid[])
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id,
         coalesce(nullif(btrim(p.full_name), ''), split_part(p.email::text, '@', 1))
    from profiles p
   where p.id = any (p_ids);
$$;
