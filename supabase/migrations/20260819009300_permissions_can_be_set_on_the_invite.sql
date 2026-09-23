-- =============================================================================
-- Part 93: per-person permission overrides can be set ON THE INVITE.
--
-- ── THE CLIENT'S ASK, VERBATIM ───────────────────────────────────────────
--   "When creating a user the admin should be able to assign a template and
--    also adjust permissions before sending invite — currently the admin can
--    only do this afterward"
--
-- The template half has existed since migration 71: `invites.template_id` is
-- carried on the invite and applied by `complete_signup` in the same
-- transaction that creates the profile. The missing half is the PERSONAL
-- override — the "(edited)" in the spec's own three labels, "Template: X
-- (edited)".
--
-- ── WHY IT COULD NOT BE DONE BEFORE ──────────────────────────────────────
-- `user_grants` keys on `user_id`, and that row does not exist until the
-- invited person finishes signing up. There was nowhere to put an override
-- decided in advance, so the admin genuinely could only do it afterward — the
-- client is describing the system accurately.
--
-- This table is that missing place. It mirrors `template_grants` exactly,
-- including the per-module dimension from migration 77, so an override chosen
-- at invite time can be as specific as one set later.
--
-- ── APPLIED IN THE SAME TRANSACTION AS EVERYTHING ELSE ───────────────────
-- `complete_signup` already creates the profile and attaches the template as
-- one atomic step. The overrides join it. A person is never briefly live with
-- their template but not their overrides — the state the client would notice
-- only by someone seeing a field they should not.
--
-- ── THE ROWS ARE COPIED, NOT LINKED ──────────────────────────────────────
-- Unlike the template, which stays live-linked for ever, these become ordinary
-- `user_grants` and the invite's copies are then irrelevant. That is correct:
-- an override is a decision about a PERSON, and once the person exists the
-- Users screen is the one place it lives. Leaving the invite as a second
-- source would be two places to edit and two chances to disagree.
-- =============================================================================

create table if not exists invite_grants (
  invite_id   uuid not null references invites(id) on delete cascade,
  scope_kind  grant_scope not null,
  scope_id    uuid not null,
  grant_level permission_level not null,
  module_id   uuid references modules(id) on delete cascade,

  -- Same shape rule as user_grants and template_grants: a module-scope grant
  -- already names its module in scope_id, so it must not carry a second one.
  constraint invite_grants_module_scope_shape
    check (scope_kind <> 'module' or module_id is null)
);

-- NULLS NOT DISTINCT so "the global row" is ONE row, exactly as migration 77
-- established for the other two grant tables. Without it an invite could hold
-- five conflicting global grants for the same scope.
create unique index if not exists invite_grants_scope_module_key
  on invite_grants (invite_id, scope_kind, scope_id, module_id) nulls not distinct;

comment on table invite_grants is
  'Personal permission overrides chosen when the invite was created. Copied into user_grants by complete_signup and never read again.';


-- ── RLS: admins only, and only through the app's own client ──────────────
alter table invite_grants enable row level security;
alter table invite_grants force row level security;

revoke all on table invite_grants from anon, authenticated;

-- Admins manage these from the invite screen with the request-scoped client,
-- so `authenticated` needs the privileges — gated to admins by the policy.
grant select, insert, update, delete on table invite_grants to authenticated;

create policy invite_grants_admin_all on invite_grants
  for all to authenticated
  using (auth_is_admin())
  with check (auth_is_admin());


-- ── complete_signup applies them ─────────────────────────────────────────
create or replace function public.complete_signup(p_user_id uuid, p_email citext, p_full_name text default null::text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
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

  /*
   * The personal overrides chosen on the same screen. Copied rather than
   * linked — see the header. `on conflict do nothing` guards only against a
   * repeat of this statement; the unique index means the invite cannot hold
   * two rows for the same scope in the first place.
   */
  insert into user_grants (user_id, scope_kind, scope_id, grant_level, module_id)
  select p_user_id, ig.scope_kind, ig.scope_id, ig.grant_level, ig.module_id
    from invite_grants ig
   where ig.invite_id = v_invite.id
  on conflict do nothing;

  update invites
     set status = 'accepted', accepted_at = now()
   where id = v_invite.id;

  return v_invite.role_id;
end;
$function$;
