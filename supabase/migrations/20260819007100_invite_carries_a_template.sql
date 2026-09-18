-- =============================================================================
-- Part 71: an invite can carry a permission template.
--
-- ── THE GAP THE CLIENT FOUND ─────────────────────────────────────────────
-- "When inviting a user I should be able to immediately assign permissions."
--
-- Per-user permissions were already built — `user_grants`, `permission_templates`,
-- `template_grants`, the grant matrix, all of it. What could not be done was
-- assigning any of it AT INVITE TIME: an invite carried `role_id` and nothing
-- else, so the only route was invite → wait for them to sign up → find them in
-- the Users list → open Permissions → set grants.
--
-- That gap is worse than an inconvenience. Between signing up and an admin
-- getting round to them, a new person holds the DEFAULT, and the default in
-- this system is EDIT on everything unset — the rule the Permissions screen
-- warns about in its own words: "an empty template restricts nothing". So the
-- window between accepting an invite and being configured is a window of full
-- access.
--
-- ── WHY A TEMPLATE AND NOT A GRANT MATRIX IN THE DIALOG ──────────────────
-- A template IS "a named set of permissions" — the existing answer to this
-- question. Putting a scope-by-scope matrix in an invite dialog would duplicate
-- the Permissions screen, and the two would drift. Picking "Sales Rep" at
-- invite time is one decision an admin can actually make while typing an email
-- address, and it stays live-linked afterwards: editing the template later
-- reaches everyone who joined under it.
--
-- ── NULLABLE, AND ON DELETE SET NULL ─────────────────────────────────────
-- Null means "no template", which is the current behaviour and stays valid —
-- an admin may genuinely want to configure someone by hand. And a template
-- deleted while an invite is outstanding must not delete the invite: the person
-- still joins, just without it.
-- =============================================================================

alter table invites
  add column if not exists template_id uuid
    references permission_templates(id) on delete set null;

comment on column invites.template_id is
  'Permission template applied when this invite is accepted. Null = none.';


-- =============================================================================
-- `complete_signup` applies it.
--
-- ⚠ IT MUST HAPPEN HERE, IN THE SAME TRANSACTION AS THE PROFILE INSERT.
-- Doing it afterwards from application code would leave a gap — however
-- short — in which the account exists with no template and therefore resolves
-- to Edit on everything. That is precisely the window this migration exists to
-- close, so it would be an odd way to close it.
--
-- `on conflict do nothing`: `user_templates` is one row per user, and a retry
-- of a signup that already applied one must not fail.
-- =============================================================================

create or replace function public.complete_signup(
  p_user_id uuid,
  p_email citext,
  p_full_name text default null::text
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_email  citext := lower(btrim(p_email));
  v_invite invites%rowtype;
begin
  select * into v_invite
    from invites
   where email = v_email
     and status = 'pending'
     and expires_at > now()
   for update;

  if not found then
    raise exception 'INVITE_NOT_VALID' using errcode = 'P0001';
  end if;

  insert into profiles (id, email, full_name, role_id)
  values (p_user_id, v_email, nullif(btrim(coalesce(p_full_name, '')), ''), v_invite.role_id);

  -- The permissions the admin chose when they sent the invite, applied before
  -- the account is usable rather than after.
  if v_invite.template_id is not null then
    insert into user_templates (user_id, template_id)
    values (p_user_id, v_invite.template_id)
    on conflict do nothing;
  end if;

  update invites
     set status = 'accepted', accepted_at = now()
   where id = v_invite.id;

  return v_invite.role_id;
end;
$function$;

revoke execute on function public.complete_signup(uuid, citext, text) from public, anon;
grant execute on function public.complete_signup(uuid, citext, text) to service_role;
