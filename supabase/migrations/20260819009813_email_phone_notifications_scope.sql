-- =============================================================================
-- Permissions spec — part 4: "Own only / All users" and the Communication tab.
--
-- ── EMAIL, PHONE, NOTIFICATIONS (the sidebar modules) ───────────────────────
--   Own only   their own connected inbox, their own phone line, their own
--              notifications (where they were @'d)
--   All users  everyone's
-- These used to be "is admin". Now each is its own setting — a Super admin has
-- All users for all three, an Admin has Own only (spec: "Admins are set to Own
-- only for Email, Phone and Notifications").
--
-- The "hide my mailboxes from admins" privacy switch keeps its meaning under
-- the new names: a person who can see everyone's inboxes may hide their own
-- from the others who can.
--
-- ── COMMUNICATION TAB (in the drawer) ───────────────────────────────────────
--   Own only   emails, calls, texts and call recordings the user sent or was
--              copied on
--   Whole org  all of them on that record
-- "It only ever shows records the user can already open", and it has no
-- Hidden: every user sees at least their own.
-- =============================================================================

-- ── who counts as "me" in an email ──────────────────────────────────────────
create or replace function user_mail_identities(u uuid)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct lower(a)), '{}')
    from (
      select p.email::text as a from profiles p where p.id = u
      union
      select m.address::text from mail_connections c
        join mail_mailboxes m on m.id = c.mailbox_id
       where c.user_id = u and c.disconnected_at is null and m.deleted_at is null
    ) x
   where a is not null and a <> '';
$$;
revoke execute on function user_mail_identities(uuid) from public, anon, authenticated;

-- The caller's own addresses only — what a policy may ask. The by-user version
-- above stays closed: it would tell anyone another person's addresses.
create or replace function my_mail_identities()
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select user_mail_identities(auth.uid());
$$;
revoke execute on function my_mail_identities() from public, anon;
grant execute on function my_mail_identities() to authenticated;

-- ── Email module ────────────────────────────────────────────────────────────
create or replace function mail_user_is_admin(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- "Can see every user's inbox" — the people the hide switch hides from.
  select user_perm(p_user, 'email.scope') = 'all';
$$;

create or replace function mail_visible_mailbox_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as uid, auth_perm('email.scope') = 'all' as sees_all)
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
         -- 2. Email = All users: someone else's personal mailbox, unless its
         --    owner also sees everyone's and asked to be hidden from the rest.
         me.sees_all
         and m.kind = 'personal'
         and not (
           public.mail_user_is_admin(c.user_id)
           and coalesce((select s.hide_my_mailboxes_from_admins
                           from public.mail_user_settings s where s.user_id = c.user_id), false)
         )
       )
     );
$$;

drop policy if exists mail_connections_select on mail_connections;
create policy mail_connections_select on mail_connections for select
  using (disconnected_at is null
         and (user_id = auth.uid()
              or (auth_perm('email.scope') = 'all' and mailbox_id = any (mail_visible_mailbox_ids()))));

-- ── Phone module + the drawer's calls, texts and recordings ─────────────────
drop policy if exists phone_calls_select on phone_calls;
create policy phone_calls_select on phone_calls for select
  using (deleted_at is null
         and (auth_perm('phone.scope') = 'all'
              or owner_id = auth.uid()
              or (record_id is not null and record_visible(record_id) and auth_perm('communication.scope') = 'org')));

drop policy if exists phone_messages_select on phone_messages;
create policy phone_messages_select on phone_messages for select
  using (deleted_at is null
         and (auth_perm('phone.scope') = 'all'
              or owner_id = auth.uid()
              or (record_id is not null and record_visible(record_id) and auth_perm('communication.scope') = 'org')));

drop policy if exists phone_recordings_select on phone_recordings;
create policy phone_recordings_select on phone_recordings for select
  using (deleted_at is null
         and exists (select 1 from phone_calls c
                      where c.id = phone_recordings.call_id and c.deleted_at is null
                        and (auth_perm('phone.scope') = 'all'
                             or c.owner_id = auth.uid()
                             or (c.record_id is not null and record_visible(c.record_id)
                                 and auth_perm('communication.scope') = 'org'))));

-- ── record email (the drawer's Email sub-tab) ───────────────────────────────
drop policy if exists messages_select on messages;
create policy messages_select on messages for select
  using (record_visible(record_id)
         and tab_visible(record_id, 'communication')
         and (auth_perm('communication.scope') = 'org'
              or lower(from_identity::text) = any (my_mail_identities())
              or lower(to_identity::text) = any (my_mail_identities())));

-- ── Notifications ───────────────────────────────────────────────────────────
-- All users: everyone's — still only for records this person can open.
drop policy if exists notifications_select_own on notifications;
create policy notifications_select_own on notifications for select
  using (recipient_id = auth.uid()
         or (auth_perm('notifications.scope') = 'all'
             and (record_id is null or record_visible(record_id))));
