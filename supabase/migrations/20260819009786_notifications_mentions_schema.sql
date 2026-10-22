-- =============================================================================
-- @Mentions & Notifications (client build plan, 20 Oct 2026) — 1 of 5: schema.
--
-- `notifications` grows from "a sentence about a record" into a pointer to
-- the exact thing someone was mentioned on (an update, a case reply, a
-- field), with the words that go with it. Phone-call rows (call, voicemail,
-- recording, sms) are untouched and keep working.
--
--   actor_id          who mentioned them (set null if that person is purged)
--   update_id / case_id / case_reply_id / field_key   the target; one per kind
--   note              the sender's optional note on a field mention (≤500)
--   current_value     the field's value when mentioned (never for a sensitive field)
--   previous_value    the value before the sender's own recent change, if asked
--                     for — and REMOVED once the recipient opens the
--                     notification (`notification_open`), as the client asked
--   preview           the first line shown in lists and email subjects
--   opened_at         first open; `read_at` can be reset, this cannot
--   revoked_at        the update was edited/deleted so this mention no longer
--                     exists. A logical delete, because Supabase Realtime does
--                     not deliver a usable DELETE event (only the key, and
--                     unchecked by RLS if REPLICA IDENTITY were FULL); the
--                     nightly prune removes the row later.
--   email_sent_at     the one email per mention went out
--
-- Also fixed here: `notifications.record_id` had no ON DELETE action, so
-- `purge_record()` failed with 23503 for any record that had ever produced a
-- notification. Now cascades.
--
-- Marking read no longer goes through a column grant: a client could mark a
-- field mention read without clearing `previous_value`. Every state change
-- is an RPC (migration 9789); `select` stays, Realtime needs it.
-- =============================================================================

alter table public.notifications
  add column if not exists actor_id       uuid references public.profiles(id) on delete set null,
  add column if not exists update_id      uuid references public.updates(id) on delete cascade,
  add column if not exists case_id        uuid references public.cases(id) on delete cascade,
  add column if not exists case_reply_id  uuid references public.case_replies(id) on delete cascade,
  add column if not exists field_key      citext,
  add column if not exists note           text,
  add column if not exists current_value  text,
  add column if not exists previous_value text,
  add column if not exists preview        text,
  add column if not exists opened_at      timestamptz,
  add column if not exists revoked_at     timestamptz,
  add column if not exists email_sent_at  timestamptz;

alter table public.notifications drop constraint if exists notifications_record_id_fkey;
alter table public.notifications
  add constraint notifications_record_id_fkey
  foreign key (record_id) references public.records(id) on delete cascade;

alter table public.notifications
  add constraint notifications_note_len check (note is null or char_length(note) <= 500),
  add constraint notifications_source_kind_check check (
    source_kind in ('update', 'mention', 'case', 'call', 'voicemail', 'recording', 'sms',
                    'mention_update', 'mention_case_reply', 'mention_field')),
  add constraint notifications_shape check (
    (source_kind = 'mention_update'     and update_id is not null and record_id is not null)
    or (source_kind = 'mention_case_reply' and case_id is not null and case_reply_id is not null and record_id is not null)
    or (source_kind = 'mention_field'      and field_key is not null and record_id is not null)
    or source_kind not like 'mention\_%');

-- One notification per person per update / per case reply, however many
-- times the name appears in the text.
create unique index if not exists notifications_one_per_update
  on public.notifications (recipient_id, update_id) where update_id is not null;
create unique index if not exists notifications_one_per_case_reply
  on public.notifications (recipient_id, case_reply_id) where case_reply_id is not null;
-- Counts on list rows, tabs and fields.
create index if not exists notifications_unread_by_record
  on public.notifications (recipient_id, record_id) where read_at is null and revoked_at is null;
-- Edit / delete paths.
create index if not exists notifications_by_update on public.notifications (update_id) where update_id is not null;
create index if not exists notifications_by_case   on public.notifications (case_id)   where case_id is not null;
-- Prune, and the email sweep.
create index if not exists notifications_created on public.notifications (created_at);
create index if not exists notifications_email_due
  on public.notifications (created_at) where email_sent_at is null and source_kind like 'mention\_%' and revoked_at is null;

revoke update on public.notifications from authenticated, anon;
drop policy if exists notifications_update_own on public.notifications;

-- ── Mutes: "stop alerting me about this record" ──────────────────────────
create table public.notification_mutes (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  record_id  uuid not null references public.records(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, record_id)
);
alter table public.notification_mutes enable row level security;
alter table public.notification_mutes force row level security;
create policy notification_mutes_select on public.notification_mutes for select to authenticated
  using (user_id = auth.uid());
create policy notification_mutes_insert on public.notification_mutes for insert to authenticated
  with check (user_id = auth.uid() and record_visible(record_id));
create policy notification_mutes_delete on public.notification_mutes for delete to authenticated
  using (user_id = auth.uid());
revoke all on public.notification_mutes from public, anon;
grant select, insert, delete on public.notification_mutes to authenticated;
grant all on public.notification_mutes to service_role;

-- ── Who was mentioned on a case reply (the "was notified" chip) ──────────
create table public.case_reply_mentions (
  case_reply_id uuid not null references public.case_replies(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  primary key (case_reply_id, user_id)
);
alter table public.case_reply_mentions enable row level security;
alter table public.case_reply_mentions force row level security;
-- Read with the case; written only by the RPC (no insert/delete grant).
create policy case_reply_mentions_select on public.case_reply_mentions for select to authenticated
  using (exists (select 1 from case_replies r join cases c on c.id = r.case_id
                  where r.id = case_reply_mentions.case_reply_id
                    and record_visible(c.record_id) and tab_visible(c.record_id, 'cases')));
revoke all on public.case_reply_mentions from public, anon;
grant select on public.case_reply_mentions to authenticated;
grant all on public.case_reply_mentions to service_role;

-- ── purge_user: the two new per-person tables ────────────────────────────
-- Body unchanged from 20260819005800 except the two added deletes; the
-- CASCADE only fires on the branch where the auth row can actually go.
create or replace function public.purge_user(p_user uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text;
  v_left    bigint;
  v_stub    text;
begin
  if not auth_is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'You cannot delete your own account' using errcode = '23514';
  end if;

  select email into v_email from profiles where id = p_user and deleted_at is not null;
  if v_email is null then
    raise exception 'Soft delete this user first — permanent removal is only available from the Recycle Bin'
      using errcode = '23514';
  end if;

  v_left := count_user_records(p_user);
  if v_left > 0 then
    raise exception 'Reassign this user''s % record(s) before deleting them', v_left
      using errcode = '23514';
  end if;

  delete from user_grants              where user_id  = p_user;
  delete from user_templates           where user_id  = p_user;
  delete from user_filters             where user_id  = p_user;
  delete from user_column_order        where user_id  = p_user;
  delete from user_field_order         where user_id  = p_user;
  delete from record_visibility_grants where owner_id = p_user or viewer_id = p_user;
  delete from case_managers            where user_id  = p_user;
  delete from record_team_members      where user_id  = p_user;
  delete from update_mentions          where user_id  = p_user;
  delete from case_reply_mentions      where user_id  = p_user;
  delete from notification_mutes       where user_id  = p_user;
  delete from notifications            where recipient_id = p_user;

  insert into auth_audit_log (actor_id, event_type, email_attempted, metadata)
  values (auth.uid(), 'user_purged', v_email, jsonb_build_object('user_id', p_user));

  begin
    delete from auth.users where id = p_user;
    return 'deleted';
  exception
    when foreign_key_violation then
      null;
  end;

  v_stub := 'deleted-' || replace(p_user::text, '-', '') || '@removed.invalid';

  update profiles
     set email               = v_stub,
         full_name           = null,
         status              = 'suspended',
         sessions_valid_from = now(),
         last_login_at       = null,
         last_seen_at        = null,
         deleted_at          = now()
   where id = p_user;

  delete from auth.identities      where user_id = p_user;
  delete from auth.mfa_factors     where user_id = p_user;
  delete from auth.one_time_tokens where user_id = p_user;
  delete from auth.sessions        where user_id = p_user;
  delete from auth.refresh_tokens  where user_id = p_user::text;

  update auth.users
     set encrypted_password     = null,
         email                  = v_stub,
         email_change           = '',
         email_change_token_new = '',
         recovery_token         = '',
         confirmation_token     = '',
         banned_until           = now() + interval '1000 years'
   where id = p_user;

  return 'anonymised';
end;
$$;
