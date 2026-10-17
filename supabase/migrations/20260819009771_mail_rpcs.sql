-- =============================================================================
-- The Email module — the functions that write.
--
-- Nothing in the module grants a write to `authenticated` (9769). Writes come
-- from exactly two places:
--
--   1. The sync engine and the Graph-touching actions, as the SERVICE ROLE,
--      after the app has run authorize() → requireEmailAccess() → a visibility
--      read of the mailbox. Those writes are in TypeScript (src/lib/mail/**)
--      because they apply the same "Outlook wins" reconciliation as sync.
--   2. The functions below that a signed-in person may call directly. Each
--      one checks `auth.uid()` and visibility ITSELF, so calling it from
--      anywhere — a script, the SQL console with a borrowed JWT — cannot do
--      more than the screen can.
--
-- Every function is SECURITY DEFINER with a pinned search_path (CLAUDE.md §8).
-- Refusals say 'not found' for "not yours" as well as "does not exist", so a
-- probe cannot tell the two apart.
-- =============================================================================

-- ── settings ─────────────────────────────────────────────────────────────
create or replace function public.mail_set_user_settings(
  p_undo_send_seconds smallint,
  p_hide_my_mailboxes_from_admins boolean,
  p_default_from_mailbox_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_undo_send_seconds is null or p_undo_send_seconds not between 1 and 10 then
    raise exception 'Undo send must be between 1 and 10 seconds.' using errcode = '22023';
  end if;
  if p_default_from_mailbox_id is not null and not public.mail_mailbox_visible(p_default_from_mailbox_id) then
    raise exception 'not found' using errcode = '42501';
  end if;
  insert into public.mail_user_settings (user_id, undo_send_seconds, hide_my_mailboxes_from_admins, default_from_mailbox_id, updated_at)
  values (auth.uid(), p_undo_send_seconds, coalesce(p_hide_my_mailboxes_from_admins, false), p_default_from_mailbox_id, now())
  on conflict (user_id) do update
     set undo_send_seconds = excluded.undo_send_seconds,
         hide_my_mailboxes_from_admins = excluded.hide_my_mailboxes_from_admins,
         default_from_mailbox_id = excluded.default_from_mailbox_id,
         updated_at = now();
end;
$$;

-- ── disconnect ───────────────────────────────────────────────────────────
-- Own live connection only. Returns how many people are still connected to
-- that mailbox (0 → it stops syncing and its content is purged later).
create or replace function public.mail_disconnect_mailbox(p_connection_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conn      public.mail_connections%rowtype;
  v_remaining int;
  v_next_identity uuid;
begin
  select * into v_conn from public.mail_connections
   where id = p_connection_id and user_id = auth.uid() and disconnected_at is null
   for update;
  if not found then raise exception 'not found' using errcode = '42501'; end if;

  update public.mail_connections
     set disconnected_at = now(), status = 'disconnected', status_changed_at = now()
   where id = v_conn.id;

  -- The identity's token goes as soon as nothing uses it.
  if not exists (select 1 from public.mail_connections
                  where identity_id = v_conn.identity_id and disconnected_at is null) then
    delete from public.mail_identity_secrets where identity_id = v_conn.identity_id;
    update public.mail_identities
       set status = 'disconnected', status_changed_at = now(), deleted_at = now()
     where id = v_conn.identity_id;
  end if;

  select count(*) into v_remaining from public.mail_connections
   where mailbox_id = v_conn.mailbox_id and disconnected_at is null;

  if v_remaining = 0 then
    update public.mail_mailboxes
       set deactivated_at = now(), sync_status = 'paused', sync_identity_id = null, lease_until = null
     where id = v_conn.mailbox_id;
  else
    -- If this person's token was the one pulling the mailbox, hand it to
    -- another connector rather than letting the mailbox stall.
    select c.identity_id into v_next_identity
      from public.mail_connections c
      join public.mail_identities i on i.id = c.identity_id
     where c.mailbox_id = v_conn.mailbox_id and c.disconnected_at is null and i.status = 'ok'
     order by c.connected_at
     limit 1;
    update public.mail_mailboxes
       set sync_identity_id = coalesce(v_next_identity, sync_identity_id),
           sync_status = case when v_next_identity is null then 'stalled' else sync_status end
     where id = v_conn.mailbox_id and sync_identity_id = v_conn.identity_id;
  end if;

  return v_remaining;
end;
$$;

-- ── notices ──────────────────────────────────────────────────────────────
create or replace function public.mail_dismiss_notice(p_notice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.mail_notices set dismissed_at = now()
   where id = p_notice_id and user_id = auth.uid() and dismissed_at is null;
  if not found then raise exception 'not found' using errcode = '42501'; end if;
end;
$$;

-- The broken-connection banner: closable, and back again only when the
-- connection's status changes again (status_changed_at moves past it).
create or replace function public.mail_dismiss_connection_notice(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.mail_connections set notice_dismissed_at = now()
   where id = p_connection_id and user_id = auth.uid() and disconnected_at is null;
  if not found then raise exception 'not found' using errcode = '42501'; end if;
end;
$$;

-- ── pins (CRM-only) ──────────────────────────────────────────────────────
create or replace function public.mail_set_pin(
  p_mailbox_id uuid, p_folder_id uuid, p_conversation_id text, p_pinned boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.mail_mailbox_visible(p_mailbox_id) then
    raise exception 'not found' using errcode = '42501';
  end if;
  if not exists (select 1 from public.mail_folders
                  where id = p_folder_id and mailbox_id = p_mailbox_id and deleted_at is null) then
    raise exception 'not found' using errcode = '42501';
  end if;
  if p_conversation_id is null or char_length(p_conversation_id) not between 1 and 512 then
    raise exception 'Invalid conversation.' using errcode = '22023';
  end if;
  if p_pinned then
    insert into public.mail_pins (mailbox_id, folder_id, conversation_id, pinned_by_id)
    values (p_mailbox_id, p_folder_id, p_conversation_id, auth.uid())
    on conflict do nothing;
  else
    delete from public.mail_pins
     where mailbox_id = p_mailbox_id and folder_id = p_folder_id and conversation_id = p_conversation_id;
  end if;
end;
$$;

-- ── templates (shared = admins manage, everyone uses) ────────────────────
create or replace function public.mail_template_upsert(
  p_id uuid, p_name text, p_subject text, p_body_html text, p_shared boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
  v_row public.mail_templates%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_shared and not auth_is_admin() then
    raise exception 'Only an admin can manage shared templates.' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) = 0 then
    raise exception 'A template needs a name.' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.mail_templates (owner_id, name, subject, body_html, created_by_id, updated_by_id)
    values (case when p_shared then null else v_uid end, btrim(p_name), p_subject, p_body_html, v_uid, v_uid)
    returning id into v_id;
    return v_id;
  end if;

  select * into v_row from public.mail_templates where id = p_id and deleted_at is null for update;
  if not found
     or (v_row.owner_id is not null and v_row.owner_id <> v_uid)
     or (v_row.owner_id is null and not auth_is_admin())
     or ((v_row.owner_id is null) <> coalesce(p_shared, false)) then
    raise exception 'not found' using errcode = '42501';
  end if;
  update public.mail_templates
     set name = btrim(p_name), subject = p_subject, body_html = p_body_html, updated_by_id = v_uid
   where id = p_id;
  return p_id;
end;
$$;

create or replace function public.mail_template_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.mail_templates set deleted_at = now(), updated_by_id = auth.uid()
   where id = p_id and deleted_at is null
     and (owner_id = auth.uid() or (owner_id is null and auth_is_admin()));
  if not found then raise exception 'not found' using errcode = '42501'; end if;
end;
$$;

-- ── outbox: undo send / cancel a scheduled send / dismiss a failure ──────
-- True when it was stopped in time; false when it had already gone.
create or replace function public.mail_outbox_cancel(p_outbox_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.mail_outbox set status = 'cancelled', cancelled_at = now()
   where id = p_outbox_id and user_id = auth.uid() and status in ('held', 'scheduled');
  return found;
end;
$$;

create or replace function public.mail_outbox_acknowledge(p_outbox_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.mail_outbox set acknowledged_at = now()
   where id = p_outbox_id and user_id = auth.uid() and status = 'failed' and acknowledged_at is null;
  if not found then raise exception 'not found' using errcode = '42501'; end if;
end;
$$;

-- ── counts ───────────────────────────────────────────────────────────────
-- The single unread number on the CRM menu: Inbox unread across the mailboxes
-- I connected (not every mailbox an admin can see — that would be everyone's).
-- Graph's own unreadItemCount, so unread mail older than what is loaded counts.
create or replace function public.mail_unread_total()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(f.unread_count), 0)::int
    from public.mail_folders f
    join public.mail_connections c on c.mailbox_id = f.mailbox_id
   where c.user_id = auth.uid()
     and c.disconnected_at is null
     and f.well_known = 'inbox'
     and f.deleted_at is null;
$$;

create or replace function public.mail_connection_count()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int from public.mail_connections
   where user_id = auth.uid() and disconnected_at is null;
$$;

-- ── connect (service role only — the OAuth callback) ─────────────────────
-- One transaction: identity, its encrypted token, the mailbox (reused when
-- someone already connected that address — the spec's "no duplicate pulls"),
-- and the connection (where the 30-cap trigger fires). If any step fails,
-- nothing is left half-made.
--
-- The token arrives ALREADY ENCRYPTED by the app (AAD = user_id:microsoft_user_id);
-- the database never sees it in the clear.
create or replace function public.mail_connect_mailbox(
  p_user_id            uuid,
  p_microsoft_user_id  text,
  p_tenant_id          text,
  p_primary_email      citext,
  p_identity_display   text,
  p_scopes             text[],
  p_missing_scopes     text[],
  p_refresh_enc        bytea,
  p_refresh_iv         bytea,
  p_kind               text,
  p_address            citext,
  p_mailbox_display    text,
  p_graph_user_id      text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_identity   uuid;
  v_mailbox    public.mail_mailboxes%rowtype;
  v_created    boolean := false;
  v_conn       uuid;
  v_reconnect  boolean := false;
  v_status     text := case when coalesce(array_length(p_missing_scopes, 1), 0) > 0 then 'degraded' else 'ok' end;
begin
  if p_kind not in ('personal', 'shared') then
    raise exception 'Invalid mailbox kind.' using errcode = '22023';
  end if;

  -- identity
  select id into v_identity from public.mail_identities
   where user_id = p_user_id and microsoft_user_id = p_microsoft_user_id and deleted_at is null
   for update;
  if found then
    update public.mail_identities
       set tenant_id = p_tenant_id, primary_email = p_primary_email, display_name = coalesce(p_identity_display, ''),
           scopes = p_scopes, missing_scopes = coalesce(p_missing_scopes, '{}'),
           status = v_status, status_changed_at = now(), consecutive_auth_failures = 0,
           last_error_code = null, last_error = null, last_error_at = null, last_token_ok_at = now()
     where id = v_identity;
  else
    insert into public.mail_identities
      (user_id, microsoft_user_id, tenant_id, primary_email, display_name, scopes, missing_scopes, status, last_token_ok_at)
    values
      (p_user_id, p_microsoft_user_id, p_tenant_id, p_primary_email, coalesce(p_identity_display, ''),
       p_scopes, coalesce(p_missing_scopes, '{}'), v_status, now())
    returning id into v_identity;
  end if;

  insert into public.mail_identity_secrets (identity_id, refresh_token_enc, refresh_token_iv, updated_at)
  values (v_identity, p_refresh_enc, p_refresh_iv, now())
  on conflict (identity_id) do update
     set refresh_token_enc = excluded.refresh_token_enc, refresh_token_iv = excluded.refresh_token_iv,
         access_token_enc = null, access_token_iv = null, access_token_expires_at = null, updated_at = now();

  -- mailbox: one row per address
  select * into v_mailbox from public.mail_mailboxes
   where address = p_address and deleted_at is null
   for update;
  if found then
    update public.mail_mailboxes
       set deactivated_at = null,
           display_name = case when display_name = '' then coalesce(p_mailbox_display, '') else display_name end,
           graph_user_id = coalesce(graph_user_id, p_graph_user_id),
           tenant_id = coalesce(tenant_id, p_tenant_id),
           sync_identity_id = case
             when sync_identity_id is null
               or sync_status in ('broken', 'stalled', 'paused')
               or exists (select 1 from public.mail_identities i where i.id = sync_identity_id and i.status <> 'ok')
             then v_identity else sync_identity_id end,
           sync_status = case when sync_status in ('broken', 'stalled', 'paused') then 'pending' else sync_status end,
           consecutive_failures = case when sync_status in ('broken', 'stalled', 'paused') then 0 else consecutive_failures end
     where id = v_mailbox.id;
  else
    insert into public.mail_mailboxes (kind, address, graph_user_id, tenant_id, display_name, sync_identity_id)
    values (p_kind, p_address, p_graph_user_id, p_tenant_id, coalesce(p_mailbox_display, ''), v_identity)
    returning * into v_mailbox;
    v_created := true;
  end if;

  -- connection (cap trigger fires on insert)
  select id into v_conn from public.mail_connections
   where user_id = p_user_id and mailbox_id = v_mailbox.id and disconnected_at is null
   for update;
  if found then
    update public.mail_connections
       set identity_id = v_identity, status = v_status, status_changed_at = now(),
           last_error_code = null, last_error = null, last_error_at = null
     where id = v_conn;
    v_reconnect := true;
  else
    insert into public.mail_connections (user_id, mailbox_id, identity_id, status)
    values (p_user_id, v_mailbox.id, v_identity, v_status)
    returning id into v_conn;
  end if;

  return jsonb_build_object(
    'identity_id', v_identity, 'mailbox_id', v_mailbox.id, 'connection_id', v_conn,
    'mailbox_created', v_created, 'reconnected', v_reconnect, 'status', v_status
  );
end;
$$;

-- ── a person leaves (service role — called from user suspend/delete) ─────
create or replace function public.mail_purge_user_connections(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_n int;
begin
  update public.mail_connections
     set disconnected_at = now(), status = 'disconnected', status_changed_at = now()
   where user_id = p_user_id and disconnected_at is null;
  get diagnostics v_n = row_count;

  delete from public.mail_identity_secrets s
   using public.mail_identities i
   where s.identity_id = i.id and i.user_id = p_user_id;
  update public.mail_identities set status = 'disconnected', status_changed_at = now(), deleted_at = coalesce(deleted_at, now())
   where user_id = p_user_id;

  -- Mailboxes this person was pulling: hand over, or stall, or pause.
  update public.mail_mailboxes m
     set sync_identity_id = (
           select c.identity_id from public.mail_connections c
             join public.mail_identities i on i.id = c.identity_id
            where c.mailbox_id = m.id and c.disconnected_at is null and i.status = 'ok'
            order by c.connected_at limit 1),
         sync_status = case
           when not exists (select 1 from public.mail_connections c where c.mailbox_id = m.id and c.disconnected_at is null) then 'paused'
           when not exists (select 1 from public.mail_connections c join public.mail_identities i on i.id = c.identity_id
                             where c.mailbox_id = m.id and c.disconnected_at is null and i.status = 'ok') then 'stalled'
           else m.sync_status end,
         deactivated_at = case
           when not exists (select 1 from public.mail_connections c where c.mailbox_id = m.id and c.disconnected_at is null) then now()
           else m.deactivated_at end
   where m.sync_identity_id in (select id from public.mail_identities where user_id = p_user_id);

  return v_n;
end;
$$;

-- ── grants ───────────────────────────────────────────────────────────────
revoke all on function public.mail_set_user_settings(smallint, boolean, uuid) from public, anon;
revoke all on function public.mail_disconnect_mailbox(uuid) from public, anon;
revoke all on function public.mail_dismiss_notice(uuid) from public, anon;
revoke all on function public.mail_dismiss_connection_notice(uuid) from public, anon;
revoke all on function public.mail_set_pin(uuid, uuid, text, boolean) from public, anon;
revoke all on function public.mail_template_upsert(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.mail_template_delete(uuid) from public, anon;
revoke all on function public.mail_outbox_cancel(uuid) from public, anon;
revoke all on function public.mail_outbox_acknowledge(uuid) from public, anon;
revoke all on function public.mail_unread_total() from public, anon;
revoke all on function public.mail_connection_count() from public, anon;
grant execute on function public.mail_set_user_settings(smallint, boolean, uuid) to authenticated, service_role;
grant execute on function public.mail_disconnect_mailbox(uuid) to authenticated, service_role;
grant execute on function public.mail_dismiss_notice(uuid) to authenticated, service_role;
grant execute on function public.mail_dismiss_connection_notice(uuid) to authenticated, service_role;
grant execute on function public.mail_set_pin(uuid, uuid, text, boolean) to authenticated, service_role;
grant execute on function public.mail_template_upsert(uuid, text, text, text, boolean) to authenticated, service_role;
grant execute on function public.mail_template_delete(uuid) to authenticated, service_role;
grant execute on function public.mail_outbox_cancel(uuid) to authenticated, service_role;
grant execute on function public.mail_outbox_acknowledge(uuid) to authenticated, service_role;
grant execute on function public.mail_unread_total() to authenticated, service_role;
grant execute on function public.mail_connection_count() to authenticated, service_role;

-- Service role only.
revoke all on function public.mail_connect_mailbox(uuid, text, text, citext, text, text[], text[], bytea, bytea, text, citext, text, text) from public, anon, authenticated;
revoke all on function public.mail_purge_user_connections(uuid) from public, anon, authenticated;
grant execute on function public.mail_connect_mailbox(uuid, text, text, citext, text, text[], text[], bytea, bytea, text, citext, text, text) to service_role;
grant execute on function public.mail_purge_user_connections(uuid) to service_role;
