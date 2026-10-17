-- =============================================================================
-- The Email module — who can see which mailbox. THE security boundary.
--
-- Spec (16 Oct 2026):
--   * A standard user sees only mailboxes they connected themselves.
--   * An admin sees every mailbox any user has connected, EXCEPT other admins'
--     mailboxes that those admins have hidden. Admins cannot reach a mailbox
--     nobody connected.
--   * A shared mailbox is visible only to the users who connected it — admins
--     included.
--
-- ── HIDE SEMANTICS, DEFINED ──────────────────────────────────────────────
-- Hiding is a property of the person who CONNECTED, not of the mailbox. A
-- personal mailbox is hidden from other admins only when EVERY live connector
-- of it is an admin with hiding on. Connected by a hiding admin and by a
-- standard user → other admins still see it, through the standard user. An
-- admin always sees mailboxes they connected themselves. A standard user's
-- hide flag is ignored.
--
-- ── PERFORMANCE ──────────────────────────────────────────────────────────
-- `mail_visible_mailbox_ids()` returns the whole visible set as an array. In
-- a policy written `mailbox_id = any (mail_visible_mailbox_ids())` Postgres
-- evaluates it once per statement (an InitPlan), not once per row — the
-- difference between a 10k-message folder opening instantly and timing out
-- (see migrations 9762/9763 for what per-row permission functions cost).
-- =============================================================================

-- Is THIS user an active admin? auth_is_admin() answers only for the caller;
-- the hide rule needs the answer for the connector.
create or replace function public.mail_user_is_admin(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select r.is_admin
      from public.profiles p
      join public.roles r on r.id = p.role_id
     where p.id = p_user and p.status = 'active' and p.deleted_at is null
  ), false);
$$;

create or replace function public.mail_visible_mailbox_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as uid, auth_is_admin() as is_admin)
  select coalesce(array_agg(distinct m.id), '{}'::uuid[])
    from public.mail_mailboxes m
    join public.mail_connections c on c.mailbox_id = m.id and c.disconnected_at is null
    join public.profiles p on p.id = c.user_id and p.deleted_at is null
    cross join me
   where m.deleted_at is null
     and me.uid is not null
     and (
       -- 1. I connected it myself (personal or shared).
       c.user_id = me.uid
       or (
         -- 2. Admin, personal mailbox, through a connector who is not a
         --    hiding admin. Shared mailboxes never enter this branch.
         me.is_admin
         and m.kind = 'personal'
         and not (
           public.mail_user_is_admin(c.user_id)
           and coalesce((select s.hide_my_mailboxes_from_admins
                           from public.mail_user_settings s where s.user_id = c.user_id), false)
         )
       )
     );
$$;

create or replace function public.mail_mailbox_visible(p_mailbox uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_mailbox = any (public.mail_visible_mailbox_ids());
$$;

revoke all on function public.mail_user_is_admin(uuid) from public, anon;
revoke all on function public.mail_visible_mailbox_ids() from public, anon;
revoke all on function public.mail_mailbox_visible(uuid) from public, anon;
grant execute on function public.mail_user_is_admin(uuid) to authenticated, service_role;
grant execute on function public.mail_visible_mailbox_ids() to authenticated, service_role;
grant execute on function public.mail_mailbox_visible(uuid) to authenticated, service_role;

-- ── SELECT policies (writes were revoked in 9769) ────────────────────────

create policy mail_mailboxes_select on public.mail_mailboxes for select to authenticated
  using (deleted_at is null and id = any (public.mail_visible_mailbox_ids()));

-- Own connections; plus admins see who connected a mailbox they can see.
create policy mail_connections_select on public.mail_connections for select to authenticated
  using (
    disconnected_at is null
    and (user_id = auth.uid()
         or (auth_is_admin() and mailbox_id = any (public.mail_visible_mailbox_ids())))
  );

-- Own identities only. The secret columns live in another table with no policy.
create policy mail_identities_select on public.mail_identities for select to authenticated
  using (deleted_at is null and user_id = auth.uid());

create policy mail_folders_select on public.mail_folders for select to authenticated
  using (deleted_at is null and mailbox_id = any (public.mail_visible_mailbox_ids()));

create policy mail_messages_select on public.mail_messages for select to authenticated
  using (deleted_at is null and mailbox_id = any (public.mail_visible_mailbox_ids()));

create policy mail_attachments_select on public.mail_attachments for select to authenticated
  using (mailbox_id = any (public.mail_visible_mailbox_ids()));

create policy mail_pins_select on public.mail_pins for select to authenticated
  using (mailbox_id = any (public.mail_visible_mailbox_ids()));

create policy mail_rules_select on public.mail_rules for select to authenticated
  using (deleted_at is null and mailbox_id = any (public.mail_visible_mailbox_ids()));

create policy mail_contacts_select on public.mail_contacts for select to authenticated
  using (deleted_at is null and mailbox_id = any (public.mail_visible_mailbox_ids()));

create policy mail_signatures_select on public.mail_signatures for select to authenticated
  using (mailbox_id = any (public.mail_visible_mailbox_ids()));

-- Personal templates are their owner's; shared ones (owner_id null) everyone's.
create policy mail_templates_select on public.mail_templates for select to authenticated
  using (deleted_at is null and (owner_id = auth.uid() or owner_id is null));

create policy mail_user_settings_select on public.mail_user_settings for select to authenticated
  using (user_id = auth.uid());

create policy mail_outbox_select on public.mail_outbox for select to authenticated
  using (user_id = auth.uid());

create policy mail_notices_select on public.mail_notices for select to authenticated
  using (user_id = auth.uid());

-- Deliberately NO policy on: mail_identity_secrets, mail_ops, mail_subscriptions,
-- mail_sync_queue, mail_sync_runs, mail_provider_health. Forced RLS with no
-- policy means no JWT-bearing role can read a row; the service role bypasses.
-- For the secrets table the grant is withdrawn too, so it is not even a
-- relation a browser session can name.
revoke all on public.mail_identity_secrets from authenticated;
revoke all on public.mail_subscriptions from authenticated;
revoke all on public.mail_sync_queue from authenticated;
